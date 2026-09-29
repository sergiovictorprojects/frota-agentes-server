import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atualizarAgente } from '../../src/db/agentes.ts';
import { inserirArtefato } from '../../src/db/artefatos.ts';
import { ATOR_SISTEMA, listarEventosDaDemanda, montarChaveIdempotencia, registrarEvento } from '../../src/db/eventos.ts';
import { bloquearPorCusto, criarEnvelope, fixarRotaLegado, obterEnvelope, reterReservasVencidas } from '../../src/db/orquestracao.ts';
import {
  listarPlanosDaDemanda,
  obterPlanoAtivo,
  registrarPlanoExecucao,
  registrarPlanoRejeitado,
  validarPlanoExecucao,
} from '../../src/db/planos.ts';
import { avaliarEregistrar, listarAvaliacoesDaDemanda, type ContextoAvaliacao } from '../../src/db/politicas.ts';
import { criarEntrega } from '../../src/db/relatorios.ts';
import {
  abandonarPlano,
  ativarPlano,
  concluirIntegracao,
  concluirPlano,
  concluirTarefaEspecialista,
  devolverTarefa,
  falharPorContextoExcedido,
  falharTentativa,
  listarTarefasDoPlano,
  listarTarefasParaPrompt,
  MARGEM_LEASE_SEGUNDOS,
  recuperarLeasesVencidos,
  reivindicarProximaTarefa,
  reservarERegistrarEnvio,
  type TarefaReivindicada,
} from '../../src/db/tarefas.ts';
import { comTransacao } from '../../src/db/tx.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import {
  artefatoDeTeste,
  contarPassos,
  demandaComEnvelope,
  enviar,
  levarAteIntegracao,
  linhaDaTarefa,
  novaDemanda,
  planoAtivoDeTeste,
  registrarPlanoDeTeste,
  reivindicar,
  reivindicarEEnviar,
  UUID_RE,
  vencerLease,
} from '../helpers/execucao.ts';

// Fase 3.2a: planos em execução e tarefas (migration 006, src/db/tarefas.ts). Nada disso é chamado pelo fluxo
// real nesta entrega; os testes provam as garantias que a PR 3.2b vai usar. Onde o ponto é o que o banco
// recusa, o teste usa SQL direto, contornando os repositórios.
describe('execucao por tarefas (migration 006)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  const linha = (tarefaId: string) => linhaDaTarefa(db.pool, tarefaId);

  describe('plano em execucao: registro, ativacao e maquina de estados', () => {
    it('so nasce com o envelope da demanda na rota tarefas (o registrado e o rejeitado)', async () => {
      const d = await novaDemanda(db.pool);
      const v = validarPlanoExecucao({ tarefas: [{ chave: 'analise', capacidade: 'd1', objetivo: 'Analisar', dependeDe: [] }] });
      if (!v.valido) throw new Error('plano de teste invalido');
      const mensagem = 'planos_demanda: um plano em execução exige o envelope da demanda na rota tarefas';

      await expect(registrarPlanoExecucao(db.pool, { ...d, tarefas: v.tarefas })).rejects.toThrow(mensagem);
      await criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: '2.00' });
      await fixarRotaLegado(db.pool, { demandaId: d.demandaId, motivo: 'planejamento_falhou' });
      await expect(registrarPlanoExecucao(db.pool, { ...d, tarefas: v.tarefas })).rejects.toThrow(mensagem);
      await expect(registrarPlanoRejeitado(db.pool, { ...d, motivo: 'ciclo', modo: 'execucao' })).rejects.toThrow(mensagem);
      expect(await listarPlanosDaDemanda(db.pool, d.demandaId)).toEqual([]);
    });

    it('registrado → ativo libera as tarefas sem dependencia; o banco grava a data e a leitura mostra o estado', async () => {
      const d = await demandaComEnvelope(db.pool);
      const p = await registrarPlanoDeTeste(db.pool, d, [
        { chave: 'dados', capacidade: 'd1' },
        { chave: 'api', capacidade: 'd2', dependeDe: ['dados'] },
      ]);
      expect(await obterPlanoAtivo(db.pool, d.demandaId)).toBeNull();

      expect(await ativarPlano(db.pool, p.planoId)).toEqual({ ativado: true, versao: 1, totalTarefas: 3, tarefasProntas: 1 });
      const ativo = await obterPlanoAtivo(db.pool, d.demandaId);
      expect(ativo).toMatchObject({ id: p.planoId, demandaId: d.demandaId, versao: 1, criadoPelaRunId: d.runId });
      expect(Number.isNaN(Date.parse(ativo!.ativadoEm))).toBe(false);
      expect((await listarTarefasDoPlano(db.pool, p.planoId)).map((t) => [t.chave, t.tipo, t.estado])).toEqual([
        ['api', 'especialista', 'pendente'],
        ['dados', 'especialista', 'pronta'],
        ['integracao', 'integracao', 'pendente'],
      ]);
      expect(await listarPlanosDaDemanda(db.pool, d.demandaId)).toMatchObject([{ modo: 'execucao', estado: 'ativo', motivoAbandono: null }]);

      // Ativar de novo não faz nada; um plano shadow nunca é ativado.
      expect(await ativarPlano(db.pool, p.planoId)).toEqual({ ativado: false });
    });

    it('no maximo um plano ativo por demanda', async () => {
      const d = await demandaComEnvelope(db.pool);
      const p1 = await registrarPlanoDeTeste(db.pool, d);
      const p2 = await registrarPlanoDeTeste(db.pool, d);
      expect(p2.versao).toBe(2);
      await ativarPlano(db.pool, p1.planoId);
      await expect(ativarPlano(db.pool, p2.planoId)).rejects.toThrow(/planos_demanda_um_ativo_idx/);
    });

    it('a ativacao confere a forma do plano no banco, mesmo por SQL direto', async () => {
      type TarefaCrua = { chave: string; tipo: string; capacidade: string; objetivo: string | null };
      const esp = (chave: string): TarefaCrua => ({ chave, tipo: 'especialista', capacidade: 'd1', objetivo: `Objetivo ${chave}` });
      const integ: TarefaCrua = { chave: 'integracao', tipo: 'integracao', capacidade: 'gestores', objetivo: null };
      const d = await demandaComEnvelope(db.pool);

      const planoCru = (tarefas: TarefaCrua[], arestas: [string, string][]) =>
        comTransacao(db.pool, async (c) => {
          const { rows: v } = await c.query<{ v: number }>(
            'SELECT COALESCE(MAX(versao), 0) + 1 AS v FROM planos_demanda WHERE demanda_id = $1',
            [d.demandaId],
          );
          const { rows } = await c.query<{ id: string }>(
            "INSERT INTO planos_demanda (demanda_id, versao, modo, estado) VALUES ($1, $2, 'execucao', 'registrado') RETURNING id",
            [d.demandaId, v[0]!.v],
          );
          const ids = new Map<string, string>();
          for (const t of tarefas) {
            const { rows: tr } = await c.query<{ id: string }>(
              'INSERT INTO tarefas (plano_id, chave, tipo, capacidade, objetivo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
              [rows[0]!.id, t.chave, t.tipo, t.capacidade, t.objetivo],
            );
            ids.set(t.chave, tr[0]!.id);
          }
          for (const [de, para] of arestas) {
            await c.query('INSERT INTO tarefas_dependencias (tarefa_id, depende_de_id) VALUES ($1, $2)', [ids.get(de), ids.get(para)]);
          }
          return rows[0]!.id;
        });
      const ativar = (planoId: string) => db.pool.query("UPDATE planos_demanda SET estado = 'ativo' WHERE id = $1", [planoId]);
      const aresta = (chave: string): [string, string] => ['integracao', chave];

      await expect(ativar(await planoCru([esp('a')], []))).rejects.toThrow('planos_demanda: a ativação exige exatamente uma integração');
      await expect(ativar(await planoCru([integ], []))).rejects.toThrow('planos_demanda: a ativação exige de 1 a 3 especialistas');
      await expect(
        ativar(await planoCru([esp('a'), esp('b'), esp('c'), esp('d'), integ], ['a', 'b', 'c', 'd'].map(aresta))),
      ).rejects.toThrow('planos_demanda: a ativação exige de 1 a 3 especialistas');
      await expect(ativar(await planoCru([esp('a'), esp('b'), integ], [aresta('a')]))).rejects.toThrow(
        'planos_demanda: a ativação exige uma aresta direta da integração para cada especialista',
      );

      // A especialista de um plano em execução nasce com objetivo, e a integração nunca tem.
      await expect(planoCru([{ ...esp('a'), objetivo: null }], [])).rejects.toThrow('tarefas: especialista de plano em execução exige objetivo');
      await expect(planoCru([esp('a'), { ...integ, objetivo: 'Integrar' }], [])).rejects.toThrow(/tarefas_objetivo_tipo_check/);
      // Objetivo fora do formato fechado: vazio, longo, sinal de tag, separador de linha ou caractere de controle.
      for (const objetivo of ['', 'x'.repeat(301), 'Use <b>negrito</b>', 'linha\u2028outra', 'com\ttab', 'fim\u0085']) {
        await expect(planoCru([{ ...esp('a'), objetivo }], [])).rejects.toThrow(/tarefas_objetivo_check/);
      }

      // Na forma certa, ativa.
      await ativar(await planoCru([esp('a'), integ], [aresta('a')]));
      expect(await obterPlanoAtivo(db.pool, d.demandaId)).not.toBeNull();
    });

    it('a ativacao exige o envelope ainda na rota tarefas', async () => {
      const d = await demandaComEnvelope(db.pool);
      const p = await registrarPlanoDeTeste(db.pool, d);
      await fixarRotaLegado(db.pool, { demandaId: d.demandaId, motivo: 'plano_rejeitado' });
      await expect(ativarPlano(db.pool, p.planoId)).rejects.toThrow('planos_demanda: a ativação exige o envelope da demanda na rota tarefas');
    });

    it('recusa transicoes fora da maquina de estados, mudanca de identidade e DELETE; as datas sao do banco', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const sql = (texto: string, id = p.planoId) => db.pool.query(texto, [id]);

      await expect(sql("UPDATE planos_demanda SET estado = 'registrado' WHERE id = $1")).rejects.toThrow(
        'planos_demanda: transição ativo → registrado não é permitida',
      );
      await expect(sql("UPDATE planos_demanda SET estado = 'rejeitado' WHERE id = $1")).rejects.toThrow(
        'planos_demanda: transição ativo → rejeitado não é permitida',
      );
      await expect(sql('UPDATE planos_demanda SET versao = 9 WHERE id = $1')).rejects.toThrow('planos_demanda: a identidade do plano é imutável');
      await expect(sql("UPDATE planos_demanda SET estado = 'concluido' WHERE id = $1")).rejects.toThrow(
        'planos_demanda: concluir exige a integração concluída e com entrega',
      );
      await expect(sql('DELETE FROM planos_demanda WHERE id = $1')).rejects.toThrow('planos_demanda: DELETE não é permitido');

      const d = await demandaComEnvelope(db.pool);
      await expect(
        db.pool.query("INSERT INTO planos_demanda (demanda_id, versao, modo, estado, ativado_em) VALUES ($1, 1, 'execucao', 'ativo', now())", [
          d.demandaId,
        ]),
      ).rejects.toThrow('planos_demanda: um plano em execução nasce registrado ou rejeitado');
      const r = await registrarPlanoDeTeste(db.pool, d);
      await expect(sql("UPDATE planos_demanda SET estado = 'concluido' WHERE id = $1", r.planoId)).rejects.toThrow(
        'planos_demanda: transição registrado → concluido não é permitida',
      );
      // Quem chama não escolhe a data da ativação.
      await sql("UPDATE planos_demanda SET estado = 'ativo', ativado_em = '2001-01-01' WHERE id = $1", r.planoId);
      const { rows } = await sql("SELECT ativado_em > now() - interval '1 hour' AS recente, encerrado_em FROM planos_demanda WHERE id = $1", r.planoId);
      expect(rows[0]).toEqual({ recente: true, encerrado_em: null });
    });

    it('o grafo fica congelado depois da ativacao', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      await expect(
        db.pool.query("INSERT INTO tarefas (plano_id, chave, tipo, capacidade, objetivo) VALUES ($1, 'nova', 'especialista', 'd3', 'Nova')", [
          p.planoId,
        ]),
      ).rejects.toThrow('só um plano registrado recebe tarefas');
      await expect(
        db.pool.query('INSERT INTO tarefas_dependencias (tarefa_id, depende_de_id) VALUES ($1, $2)', [p.ids.b, p.ids.a]),
      ).rejects.toThrow('só um plano registrado recebe dependências: o grafo fica congelado depois da ativação');
      await expect(db.pool.query('DELETE FROM tarefas_dependencias WHERE tarefa_id = $1', [p.ids.integracao])).rejects.toThrow(
        'tarefas_dependencias é append-only: DELETE não é permitido',
      );
    });

    it('uma tarefa nasce pendente, sem claim e sem execucao; timeout e tentativas sao do banco', async () => {
      const d = await demandaComEnvelope(db.pool);
      const p = await registrarPlanoDeTeste(db.pool, d);
      const inserir = (colunas: string, valores: string) =>
        db.pool.query(`INSERT INTO tarefas (plano_id, chave, tipo, capacidade, objetivo${colunas}) VALUES ($1, 'extra', 'especialista', 'd1', 'Extra'${valores}) RETURNING *`, [
          p.planoId,
        ]);
      const mensagem = 'tarefas: uma tarefa nasce pendente, sem claim e sem execução';
      await expect(inserir(', estado', ", 'pronta'")).rejects.toThrow(mensagem);
      await expect(inserir(', claim_id', ', gen_random_uuid()')).rejects.toThrow(mensagem);
      await expect(inserir(', lease_token', ', gen_random_uuid()')).rejects.toThrow(mensagem);
      await expect(inserir(', tentativas', ', 1')).rejects.toThrow(mensagem);
      await expect(inserir(', agente_chave, agente_versao, agente_papel, modelo', ", 'frota:architect', 1, 'executor', 'claude-sonnet-5'")).rejects.toThrow(
        mensagem,
      );

      const { rows } = await inserir(', timeout_segundos', ', 5');
      expect(rows[0]).toMatchObject({ estado: 'pendente', timeout_segundos: 480, tentativas: 0, max_tentativas: 2, claim_id: null, lease_token: null });
      expect((await linha(p.ids.integracao!)).timeout_segundos).toBe(720);
      await expect(db.pool.query('DELETE FROM tarefas WHERE id = $1', [p.ids.analise])).rejects.toThrow('tarefas: DELETE não é permitido');
    });
  });

  describe('claim', () => {
    it('grava o snapshot do catalogo e o lease; o banco gera claim_id e lease_token; a tentativa ainda nao conta', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);

      expect(t).toMatchObject({
        id: p.ids.analise,
        planoId: p.planoId,
        demandaId: p.demandaId,
        chave: 'analise',
        tipo: 'especialista',
        capacidade: 'd1',
        tentativas: 0,
        maxTentativas: 2,
        timeoutSegundos: 480,
        agente: { chave: 'frota:architect', versao: 1, papel: 'executor', modelo: 'claude-sonnet-5' },
      });
      expect(t.claimId).toMatch(UUID_RE);
      expect(t.leaseToken).toMatch(UUID_RE);
      expect(t.leaseToken).not.toBe(t.claimId);
      const validade = (Date.parse(t.leaseExpiraEm) - Date.now()) / 1000;
      expect(validade).toBeGreaterThan(480 + MARGEM_LEASE_SEGUNDOS - 60);
      expect(validade).toBeLessThanOrEqual(480 + MARGEM_LEASE_SEGUNDOS + 5);

      const [resumo] = await listarTarefasDoPlano(db.pool, p.planoId);
      expect(resumo).toMatchObject({ estado: 'em_execucao', claimId: t.claimId, tentativas: 0, enviadaEm: null, iniciadaEm: null, agente: t.agente });
    });

    it('claim_id e lease_token nunca vem de quem chama; o snapshot precisa casar com o catalogo e o lease tem tamanho fechado', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd1' },
      ]);
      const claimCru = (tarefaId: string, agente: string, papel: string, lease: string, extra = '') =>
        db.pool.query(
          `UPDATE tarefas SET estado = 'em_execucao', agente_chave = $2, agente_versao = 1, agente_papel = $3, modelo = 'claude-sonnet-5',
                  lease_expira_em = ${lease}${extra}
            WHERE id = $1 RETURNING claim_id, lease_token`,
          [tarefaId, agente, papel],
        );
      // Timeout de 480 segundos da especialista: o lease vai de 600 a 1.380 segundos a partir de agora.
      const valido = "now() + interval '11 minutes'";
      const snapshot = 'tarefas: o snapshot do claim precisa ser de um agente ativo e compatível no catálogo';

      await expect(claimCru(p.ids.a!, 'frota:code-explorer', 'executor', valido)).rejects.toThrow(snapshot);
      await expect(claimCru(p.ids.a!, 'frota:architect', 'coordenador', valido)).rejects.toThrow(snapshot);
      for (const lease of ['now()', "now() + interval '599 seconds'", "now() + interval '1381 seconds'", "now() + interval '1 year'"]) {
        await expect(claimCru(p.ids.a!, 'frota:architect', 'executor', lease), lease).rejects.toThrow(
          'tarefas: o lease do claim vale o timeout mais uma folga de 120 a 900 segundos',
        );
      }
      await expect(claimCru(p.ids.integracao!, 'frota:gestores', 'coordenador', valido)).rejects.toThrow(
        'tarefas: transição pendente → em_execucao não é permitida',
      );
      await expect(db.pool.query("UPDATE tarefas SET estado = 'pronta' WHERE id = $1", [p.ids.integracao])).rejects.toThrow(
        'tarefas: uma tarefa só fica pronta com todas as dependências concluídas',
      );

      // Nos dois limites do lease, passa; o claim_id e o lease_token de quem chama são trocados pelos do banco.
      const meus = [randomUUID(), randomUUID()] as const;
      const { rows } = await claimCru(p.ids.b!, 'frota:architect', 'executor', "now() + interval '1380 seconds'", `, claim_id = '${meus[0]}', lease_token = '${meus[1]}'`);
      expect(rows[0]!.claim_id).toMatch(UUID_RE);
      expect(rows[0]!.claim_id).not.toBe(meus[0]);
      expect(rows[0]!.lease_token).not.toBe(meus[1]);
      await claimCru(p.ids.a!, 'frota:architect', 'executor', "now() + interval '600 seconds'");
      expect(await linha(p.ids.a!)).toMatchObject({ estado: 'em_execucao' });
    });

    it('pega a primeira tarefa pronta por chave e so libera a que nao tem dependencia pendente', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'beta', capacidade: 'd2' },
        { chave: 'alfa', capacidade: 'd1' },
        { chave: 'gama', capacidade: 'd3', dependeDe: ['alfa'] },
      ]);
      expect((await reivindicar(db.pool, p.planoId)).chave).toBe('alfa');
      const b = await reivindicar(db.pool, p.planoId);
      expect(b).toMatchObject({ chave: 'beta', agente: { chave: 'frota:code-explorer' } });
      expect(await reivindicarProximaTarefa(db.pool, p.planoId)).toEqual({ reivindicada: false, motivo: 'sem_tarefa_pronta' });
    });

    it('sem agente ativo da capacidade, nada e gravado e o motivo volta para quem chama', async () => {
      const p = await planoAtivoDeTeste(db.pool, [{ chave: 'seguranca', capacidade: 'd4' }]);
      await atualizarAgente(db.pool, 'frota:security-reviewer', 'teste', { estado: 'suspenso' });
      try {
        expect(await reivindicarProximaTarefa(db.pool, p.planoId)).toEqual({
          reivindicada: false,
          motivo: 'agente_indisponivel',
          tarefaId: p.ids.seguranca,
        });
        expect(await linha(p.ids.seguranca!)).toMatchObject({ estado: 'pronta', claim_id: null, agente_chave: null, lease_expira_em: null });
      } finally {
        await atualizarAgente(db.pool, 'frota:security-reviewer', 'teste', { estado: 'ativo' });
      }
    });

    it('claims concorrentes nunca pegam a mesma tarefa', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
        { chave: 'c', capacidade: 'd3' },
      ]);
      const resultados = await Promise.all(Array.from({ length: 6 }, () => reivindicarProximaTarefa(db.pool, p.planoId)));
      const ganhos = resultados.flatMap((r) => (r.reivindicada ? [r.tarefa] : []));
      expect(ganhos).toHaveLength(3);
      expect(new Set(ganhos.map((t) => t.id)).size).toBe(3);
      expect(new Set(ganhos.map((t) => t.claimId)).size).toBe(3);
      expect(resultados.filter((r) => !r.reivindicada)).toEqual(Array(3).fill({ reivindicada: false, motivo: 'sem_tarefa_pronta' }));
    });
  });

  describe('registro de envio', () => {
    it('cria a reserva do claim, soma exatamente uma tentativa e renova o lease, uma vez por claim', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      const e = await reservarERegistrarEnvio(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken, valorReservadoUsd: '0.05' });
      if (!e.registrado) throw new Error('deveria registrar');
      expect(e).toMatchObject({ claimId: t.claimId, valorReservadoUsd: '0.050000', tentativa: 1 });

      const { rows } = await db.pool.query(
        `SELECT demanda_id, plano_id, tarefa_id, claim_id, operacao, modelo, estado, valor_reservado_usd::text AS valor,
                EXTRACT(EPOCH FROM expira_em - criada_em)::int AS validade
           FROM reservas_custo WHERE id = $1`,
        [e.reservaId],
      );
      expect(rows[0]).toEqual({
        demanda_id: p.demandaId,
        plano_id: p.planoId,
        tarefa_id: t.id,
        claim_id: t.claimId,
        operacao: 'execucao',
        modelo: 'claude-sonnet-5',
        estado: 'aberta',
        valor: '0.050000',
        validade: 480 + MARGEM_LEASE_SEGUNDOS,
      });
      const [resumo] = await listarTarefasDoPlano(db.pool, p.planoId);
      expect(resumo).toMatchObject({ estado: 'em_execucao', tentativas: 1, claimId: t.claimId });
      expect(resumo!.enviadaEm).not.toBeNull();
      expect(resumo!.iniciadaEm).not.toBeNull();
      expect(Date.parse(resumo!.leaseExpiraEm!)).toBeGreaterThanOrEqual(Date.parse(t.leaseExpiraEm));

      // Um segundo envio do mesmo claim, ou um token que não é o do claim, não grava nada.
      const deNovo = { tarefaId: t.id, leaseToken: t.leaseToken, valorReservadoUsd: '0.05' };
      expect(await reservarERegistrarEnvio(db.pool, deNovo)).toEqual({ registrado: false, motivo: 'lease_perdido' });
      expect(await reservarERegistrarEnvio(db.pool, { ...deNovo, leaseToken: randomUUID() })).toEqual({ registrado: false, motivo: 'lease_perdido' });
      const { rows: n } = await db.pool.query('SELECT count(*)::int AS n FROM reservas_custo WHERE tarefa_id = $1', [t.id]);
      expect(n[0].n).toBe(1);
    });

    it('nenhum envio sem reserva aberta do mesmo claim; a tentativa sobe so no envio e nunca desce', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      const envioCru = (soma: number, lease = "now() + interval '11 minutes'") =>
        db.pool.query(`UPDATE tarefas SET tentativas = tentativas + $2, lease_expira_em = ${lease} WHERE id = $1`, [t.id, soma]);
      const reservaCrua = (claimId: string) =>
        db.pool.query(
          `INSERT INTO reservas_custo (demanda_id, plano_id, tarefa_id, claim_id, operacao, modelo, valor_reservado_usd, expira_em)
           VALUES ($1, $2, $3, $4, 'execucao', 'claude-sonnet-5', 0.01, now() + interval '1 hour') RETURNING id`,
          [p.demandaId, p.planoId, t.id, claimId],
        );

      await expect(envioCru(1)).rejects.toThrow('tarefas: nenhum envio sem reserva aberta do mesmo claim');
      await expect(reservaCrua(randomUUID())).rejects.toThrow('reservas_custo: a reserva de uma tarefa é do claim atual, antes do envio');
      // Reserva cancelada não serve, e o claim não ganha outra: uma reserva por claim.
      const { rows } = await reservaCrua(t.claimId);
      await db.pool.query("UPDATE reservas_custo SET estado = 'cancelada' WHERE id = $1", [rows[0]!.id]);
      await expect(envioCru(1)).rejects.toThrow('tarefas: nenhum envio sem reserva aberta do mesmo claim');
      await expect(reservaCrua(t.claimId)).rejects.toThrow(/reservas_custo_claim_idx/);

      // Novo claim, com reserva aberta: o envio soma exatamente uma tentativa.
      await devolverTarefa(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken });
      const t2 = await reivindicar(db.pool, p.planoId);
      await db.pool.query(
        `INSERT INTO reservas_custo (demanda_id, plano_id, tarefa_id, claim_id, operacao, modelo, valor_reservado_usd, expira_em)
         VALUES ($1, $2, $3, $4, 'execucao', 'claude-sonnet-5', 0.01, now() + interval '1 hour')`,
        [p.demandaId, p.planoId, t2.id, t2.claimId],
      );
      await expect(envioCru(2)).rejects.toThrow('tarefas: o registro de envio soma exatamente uma tentativa');
      // O lease renovado no envio tem a mesma faixa do claim.
      for (const lease of ['now()', "now() + interval '1 year'"]) {
        await expect(envioCru(1, lease), lease).rejects.toThrow(
          'tarefas: o registro de envio renova o lease para o timeout mais uma folga de 120 a 900 segundos',
        );
      }
      await envioCru(1);
      await expect(envioCru(1)).rejects.toThrow('tarefas: uma tarefa em execução só aceita um registro de envio por claim');
      await expect(db.pool.query('UPDATE tarefas SET tentativas = 0 WHERE id = $1', [t.id])).rejects.toThrow('tarefas: tentativas nunca descem');
      await expect(db.pool.query("UPDATE tarefas SET estado = 'pronta', tentativas = tentativas + 1 WHERE id = $1", [t.id])).rejects.toThrow(
        'tarefas: a tentativa só sobe no registro de envio',
      );
    });

    it('autorizacao final do agente: suspenso, com outro modelo ou outra versao, nada e gravado', async () => {
      const p = await planoAtivoDeTeste(db.pool, [{ chave: 'docs', capacidade: 'd8' }]);
      const agente = 'frota:doc-updater';
      const t = await reivindicar(db.pool, p.planoId);
      const envio = (x: TarefaReivindicada) => reservarERegistrarEnvio(db.pool, { tarefaId: x.id, leaseToken: x.leaseToken, valorReservadoUsd: '0.05' });

      await atualizarAgente(db.pool, agente, 'teste', { estado: 'suspenso' });
      expect(await envio(t)).toEqual({ registrado: false, motivo: 'agente_nao_autorizado' });
      await atualizarAgente(db.pool, agente, 'teste', { estado: 'ativo' });
      expect(await envio(t)).toEqual({ registrado: false, motivo: 'agente_alterado' });
      expect(await linha(t.id)).toMatchObject({ estado: 'em_execucao', tentativas: 0, enviada_em: null });
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM reservas_custo WHERE tarefa_id = $1', [t.id]);
      expect(rows[0].n).toBe(0);

      // Devolvida, a tarefa volta a ser reivindicada com o snapshot novo.
      expect(await devolverTarefa(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken })).toEqual({ devolvida: true, claimId: t.claimId });
      const t2 = await reivindicar(db.pool, p.planoId);
      expect(t2.claimId).not.toBe(t.claimId);
      expect(t2.agente.versao).toBe(t.agente.versao + 2);

      await atualizarAgente(db.pool, agente, 'teste', { modeloPermitido: 'claude-opus-5' });
      try {
        expect(await envio(t2)).toEqual({ registrado: false, motivo: 'agente_nao_autorizado' });
      } finally {
        await atualizarAgente(db.pool, agente, 'teste', { modeloPermitido: 'claude-sonnet-5' });
      }

      // O banco repete a checagem: com a reserva do claim e o agente suspenso, o envio por SQL direto não passa.
      await devolverTarefa(db.pool, { tarefaId: t2.id, leaseToken: t2.leaseToken });
      const t3 = await reivindicar(db.pool, p.planoId);
      await db.pool.query(
        `INSERT INTO reservas_custo (demanda_id, plano_id, tarefa_id, claim_id, operacao, modelo, valor_reservado_usd, expira_em)
         VALUES ($1, $2, $3, $4, 'execucao', 'claude-sonnet-5', 0.01, now() + interval '1 hour')`,
        [p.demandaId, p.planoId, t3.id, t3.claimId],
      );
      await atualizarAgente(db.pool, agente, 'teste', { estado: 'suspenso' });
      try {
        await expect(
          db.pool.query("UPDATE tarefas SET tentativas = tentativas + 1, lease_expira_em = now() + interval '11 minutes' WHERE id = $1", [t3.id]),
        ).rejects.toThrow('tarefas: o agente do claim não está mais autorizado');
      } finally {
        await atualizarAgente(db.pool, agente, 'teste', { estado: 'ativo' });
      }
    });

    it('acima do limite de custo ou com a demanda bloqueada, o envio nao e registrado e nada e gravado', async () => {
      const p = await planoAtivoDeTeste(db.pool, undefined, { tetoBaseUsd: '1.00' });
      const t = await reivindicar(db.pool, p.planoId);
      const envio = (valorReservadoUsd: string) =>
        reservarERegistrarEnvio(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken, valorReservadoUsd });

      expect(await envio('1.000001')).toEqual({
        registrado: false,
        motivo: 'custo_demanda_excedido',
        comprometidoUsd: '0.000000',
        limiteUsd: '1.00',
        reservaUsd: '1.000001',
      });
      await bloquearPorCusto(db.pool, p.demandaId);
      expect(await envio('0.01')).toEqual({ registrado: false, motivo: 'demanda_bloqueada' });
      expect(await linha(t.id)).toMatchObject({ estado: 'em_execucao', tentativas: 0, enviada_em: null });
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM reservas_custo WHERE tarefa_id = $1', [t.id]);
      expect(rows[0].n).toBe(0);
    });

    it('com o lease vencido, o envio nao e registrado', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      await vencerLease(db.pool, t.id);
      expect(await reservarERegistrarEnvio(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken, valorReservadoUsd: '0.05' })).toEqual({
        registrado: false,
        motivo: 'lease_perdido',
      });
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM reservas_custo WHERE tarefa_id = $1', [t.id]);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('saidas de em_execucao: lease e claim sempre limpos, claimId devolvido', () => {
    it('devolverTarefa: antes do envio volta para pronta sem consumir tentativa', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      expect(await devolverTarefa(db.pool, { tarefaId: t.id, leaseToken: randomUUID() })).toEqual({ devolvida: false });
      expect(await devolverTarefa(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken })).toEqual({ devolvida: true, claimId: t.claimId });
      expect(await linha(t.id)).toMatchObject({
        estado: 'pronta',
        tentativas: 0,
        claim_id: null,
        lease_token: null,
        lease_expira_em: null,
        agente_chave: null,
        modelo: null,
        enviada_em: null,
      });
      expect(await devolverTarefa(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken })).toEqual({ devolvida: false });

      // Depois do envio não há devolução: a tentativa já contou.
      const { tarefa: t2 } = await reivindicarEEnviar(db.pool, p.planoId);
      expect(await devolverTarefa(db.pool, { tarefaId: t2.id, leaseToken: t2.leaseToken })).toEqual({ devolvida: false });
    });

    it('falharTentativa: depois do envio, volta para pronta com tentativa restante; na ultima, falha e abandona o plano', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      const falhar = (x: TarefaReivindicada, codigoErro: 'llm_api' | 'llm_timeout') =>
        falharTentativa(db.pool, { tarefaId: x.id, leaseToken: x.leaseToken, codigoErro });

      expect(await falhar(t, 'llm_api')).toEqual({ registrada: false });
      expect(await falharTentativa(db.pool, { tarefaId: randomUUID(), leaseToken: t.leaseToken, codigoErro: 'llm_api' })).toEqual({
        registrada: false,
      });
      await enviar(db.pool, t);
      expect(await falhar(t, 'llm_api')).toEqual({
        registrada: true,
        claimId: t.claimId,
        tentativa: 1,
        destino: 'pronta',
        definitiva: false,
        abandono: null,
      });
      expect(await linha(t.id)).toMatchObject({
        estado: 'pronta',
        tentativas: 1,
        codigo_erro: null,
        claim_id: null,
        lease_token: null,
        enviada_em: null,
        agente_chave: null,
      });

      const { tarefa: t2 } = await reivindicarEEnviar(db.pool, p.planoId);
      expect(t2.claimId).not.toBe(t.claimId);
      expect(await falhar(t2, 'llm_timeout')).toEqual({
        registrada: true,
        claimId: t2.claimId,
        tentativa: 2,
        destino: 'falhou',
        definitiva: true,
        abandono: { planoId: p.planoId, demandaId: p.demandaId, versao: 1, tarefasCanceladas: 1 },
      });
      expect(await linha(t.id)).toMatchObject({
        estado: 'falhou',
        tentativas: 2,
        codigo_erro: 'llm_timeout',
        claim_id: null,
        lease_token: null,
        lease_expira_em: null,
        enviada_em: null,
        // O snapshot fica: é o registro de quem executou a última tentativa.
        agente_chave: 'frota:architect',
      });
      // Na mesma transação: plano abandonado, integração cancelada e rota fixada.
      expect(await listarPlanosDaDemanda(db.pool, p.demandaId)).toMatchObject([{ estado: 'abandonado', motivoAbandono: 'tarefa_falhou' }]);
      expect(await linha(p.ids.integracao!)).toMatchObject({ estado: 'cancelada' });
      expect(await obterEnvelope(db.pool, p.demandaId)).toMatchObject({ rota: 'legado_fixo', motivoLegado: 'tarefa_falhou' });
      expect(await reivindicarProximaTarefa(db.pool, p.planoId)).toEqual({ reivindicada: false, motivo: 'sem_tarefa_pronta' });
      expect(await falhar(t2, 'llm_timeout')).toEqual({ registrada: false });
      await expect(
        falharTentativa(db.pool, { tarefaId: t2.id, leaseToken: t2.leaseToken, codigoErro: 'contexto_excedido' as never }),
      ).rejects.toThrow('use falharPorContextoExcedido');
    });

    it('no COMMIT, uma tarefa que falhou exige o plano abandonado por tarefa_falhou', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const { tarefa: t } = await reivindicarEEnviar(db.pool, p.planoId);
      const falharCru = (c: pg.Pool | pg.PoolClient) =>
        c.query("UPDATE tarefas SET estado = 'falhou', codigo_erro = 'llm_api' WHERE id = $1", [t.id]);
      const mensagem = 'tarefas: uma tarefa que falhou exige o plano abandonado por tarefa_falhou na mesma transação';

      await expect(falharCru(db.pool)).rejects.toThrow(mensagem);
      // Abandonar por outro motivo também não serve.
      await expect(
        comTransacao(db.pool, async (c) => {
          await falharCru(c);
          await abandonarPlano(c, { planoId: p.planoId, motivo: 'pendencia_humana' });
        }),
      ).rejects.toThrow(mensagem);
      expect(await linha(t.id)).toMatchObject({ estado: 'em_execucao', claim_id: t.claimId });
      expect(await obterPlanoAtivo(db.pool, p.demandaId)).toMatchObject({ id: p.planoId });
    });

    it('sem claim nao ha snapshot: cancelar ou falhar por contexto_excedido ignora o snapshot mandado no UPDATE', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const snapshot = ", agente_chave = 'frota:architect', agente_versao = 1, agente_papel = 'executor', modelo = 'claude-sonnet-5'";
      await comTransacao(db.pool, async (c) => {
        await c.query("UPDATE planos_demanda SET estado = 'abandonado', motivo_abandono = 'tarefa_falhou' WHERE id = $1", [p.planoId]);
        await c.query(`UPDATE tarefas SET estado = 'falhou', codigo_erro = 'contexto_excedido'${snapshot} WHERE id = $1`, [p.ids.analise]);
        await c.query(`UPDATE tarefas SET estado = 'cancelada'${snapshot} WHERE id = $1`, [p.ids.integracao]);
        await fixarRotaLegado(c, { demandaId: p.demandaId, motivo: 'tarefa_falhou' });
      });
      for (const id of [p.ids.analise!, p.ids.integracao!]) {
        expect(await linha(id)).toMatchObject({ agente_chave: null, agente_versao: null, agente_papel: null, modelo: null });
      }
    });

    it('pronta → falhou so com contexto_excedido, e com o plano abandonado na mesma transacao', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const falharCru = (codigo: string) =>
        db.pool.query("UPDATE tarefas SET estado = 'falhou', codigo_erro = $2 WHERE id = $1", [p.ids.analise, codigo]);
      await expect(falharCru('llm_api')).rejects.toThrow('tarefas: pronta → falhou só com contexto_excedido');
      await expect(falharCru('contexto_excedido')).rejects.toThrow(
        'tarefas: contexto_excedido exige o plano abandonado por tarefa_falhou na mesma transação',
      );
      // Depois do claim, contexto_excedido não existe mais: a falha de uma tarefa reivindicada tem outro código.
      const t = await reivindicar(db.pool, p.planoId);
      await enviar(db.pool, t);
      await expect(falharCru('contexto_excedido')).rejects.toThrow(
        'tarefas: contexto_excedido é anterior ao claim; uma tarefa em execução não falha com ele',
      );
      expect(await linha(t.id)).toMatchObject({ estado: 'em_execucao', codigo_erro: null });
    });

    it('falharPorContextoExcedido: sem claim, sem reserva e sem tentativa; plano abandonado, resto cancelado e rota fixada', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      // Só uma tarefa pronta: a integração, ainda pendente, não falha por contexto.
      expect(await falharPorContextoExcedido(db.pool, p.ids.integracao!)).toEqual({ registrada: false });
      expect(await falharPorContextoExcedido(db.pool, p.ids.a!)).toEqual({
        registrada: true,
        planoId: p.planoId,
        demandaId: p.demandaId,
        versao: 1,
        tipo: 'especialista',
        tentativa: 0,
        tarefasCanceladas: 2,
      });
      expect(await linha(p.ids.a!)).toMatchObject({
        estado: 'falhou',
        codigo_erro: 'contexto_excedido',
        tentativas: 0,
        claim_id: null,
        lease_token: null,
        agente_chave: null,
      });
      expect((await listarTarefasDoPlano(db.pool, p.planoId)).map((t) => [t.chave, t.estado])).toEqual([
        ['a', 'falhou'],
        ['b', 'cancelada'],
        ['integracao', 'cancelada'],
      ]);
      expect(await listarPlanosDaDemanda(db.pool, p.demandaId)).toMatchObject([{ estado: 'abandonado', motivoAbandono: 'tarefa_falhou' }]);
      expect(await obterEnvelope(db.pool, p.demandaId)).toMatchObject({ rota: 'legado_fixo', motivoLegado: 'tarefa_falhou' });
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM reservas_custo WHERE demanda_id = $1', [p.demandaId]);
      expect(rows[0].n).toBe(0);
      // Nada se repete sozinho.
      expect(await falharPorContextoExcedido(db.pool, p.ids.a!)).toEqual({ registrada: false });
      expect(await falharPorContextoExcedido(db.pool, p.ids.b!)).toEqual({ registrada: false });

      // O evento: anterior ao claim, com ator sistema, claimId nulo e tentativa 0.
      const evento = await registrarEvento(db.pool, {
        demandaId: p.demandaId,
        correlacaoId: p.runId,
        runId: p.runId,
        tentativa: null,
        tipoEvento: 'tarefa_falhou',
        ator: ATOR_SISTEMA,
        tarefaId: p.ids.a,
        chaveIdempotencia: montarChaveIdempotencia(p.runId, 'tarefa_falhou', p.ids.a!),
        metadata: { claimId: null, tipo: 'especialista', tentativa: 0, codigoErro: 'contexto_excedido', definitiva: true },
      });
      expect(evento).toMatchObject({ tarefaId: p.ids.a, ator: 'sistema', resumo: 'Tarefa falhou.' });
    });

    it('recuperarLeasesVencidos: sem envio, ou com tentativa restante, volta para pronta e o plano segue ativo', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      // a: só o claim. b: claim e envio, com uma tentativa ainda restante. Os dois leases vencem.
      const ta = await reivindicar(db.pool, p.planoId);
      const tb = await reivindicar(db.pool, p.planoId);
      await enviar(db.pool, tb);
      await vencerLease(db.pool, ta.id);
      await vencerLease(db.pool, tb.id);

      const esperado = [
        { tarefaId: ta.id, claimId: ta.claimId, tentativa: 0, enviada: false, destino: 'pronta' },
        { tarefaId: tb.id, claimId: tb.claimId, tentativa: 1, enviada: true, destino: 'pronta' },
      ].sort((x, y) => (x.tarefaId < y.tarefaId ? -1 : 1));
      expect(await recuperarLeasesVencidos(db.pool, p.planoId)).toEqual({ leases: esperado, abandono: null });
      expect(await linha(ta.id)).toMatchObject({ estado: 'pronta', tentativas: 0, claim_id: null, lease_token: null });
      expect(await linha(tb.id)).toMatchObject({ estado: 'pronta', tentativas: 1, claim_id: null, lease_token: null, enviada_em: null });
      expect(await obterPlanoAtivo(db.pool, p.demandaId)).toMatchObject({ id: p.planoId });
      expect(await recuperarLeasesVencidos(db.pool, p.planoId)).toEqual({ leases: [], abandono: null });

      // A reserva do envio venceu junto: a varredura a retém, e ela segue contando.
      const retidas = (await reterReservasVencidas(db.pool)).filter((r) => r.demandaId === p.demandaId);
      expect(retidas.map((r) => r.tarefaId)).toEqual([tb.id]);
    });

    it('recuperarLeasesVencidos: sem tentativa restante, a tarefa falha e o plano e abandonado na mesma transacao', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      // a: a primeira tentativa falha; a segunda, a última, é enviada e o lease vence. b: claim ainda valendo.
      const ta1 = await reivindicar(db.pool, p.planoId);
      await enviar(db.pool, ta1);
      await falharTentativa(db.pool, { tarefaId: ta1.id, leaseToken: ta1.leaseToken, codigoErro: 'llm_api' });
      const ta2 = await reivindicar(db.pool, p.planoId);
      expect(ta2.id).toBe(ta1.id);
      await enviar(db.pool, ta2);
      const tb = await reivindicar(db.pool, p.planoId);
      await vencerLease(db.pool, ta2.id);

      expect(await recuperarLeasesVencidos(db.pool, p.planoId)).toEqual({
        leases: [{ tarefaId: ta2.id, claimId: ta2.claimId, tentativa: 2, enviada: true, destino: 'falhou' }],
        abandono: { planoId: p.planoId, demandaId: p.demandaId, versao: 1, tarefasCanceladas: 2 },
      });
      expect(await linha(ta2.id)).toMatchObject({ estado: 'falhou', codigo_erro: 'lease_expirado', claim_id: null, lease_token: null });
      expect(await linha(tb.id)).toMatchObject({ estado: 'cancelada', claim_id: null, lease_token: null });
      expect(await listarPlanosDaDemanda(db.pool, p.demandaId)).toMatchObject([{ estado: 'abandonado', motivoAbandono: 'tarefa_falhou' }]);
      expect(await obterEnvelope(db.pool, p.demandaId)).toMatchObject({ rota: 'legado_fixo', motivoLegado: 'tarefa_falhou' });
      expect(await recuperarLeasesVencidos(db.pool, p.planoId)).toEqual({ leases: [], abandono: null });
    });

    it('um lease ainda valido nao e tocado pela recuperacao', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      expect(await recuperarLeasesVencidos(db.pool, p.planoId)).toEqual({ leases: [], abandono: null });
      expect(await linha(t.id)).toMatchObject({ estado: 'em_execucao', claim_id: t.claimId });
      expect(await recuperarLeasesVencidos(db.pool, randomUUID())).toEqual({ leases: [], abandono: null });
    });

    it('erros sem uso (devolucao, falha antes do envio, contexto_excedido) nao geram agent_step', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      const t = await reivindicar(db.pool, p.planoId);
      await devolverTarefa(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken });
      const t2 = await reivindicar(db.pool, p.planoId);
      await enviar(db.pool, t2);
      await falharTentativa(db.pool, { tarefaId: t2.id, leaseToken: t2.leaseToken, codigoErro: 'llm_api' });
      await falharPorContextoExcedido(db.pool, p.ids.a!);
      expect(await contarPassos(db.pool, p.demandaId)).toBe(0);
    });
  });

  describe('conclusao, integracao e entrega unica', () => {
    it('especialista: grava o artefato, conclui, libera as dependentes e descarta resultado atrasado ou de outro token', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2', dependeDe: ['a'] },
      ]);
      const { tarefa: t } = await reivindicarEEnviar(db.pool, p.planoId);
      expect(t.chave).toBe('a');
      const conteudo = 'Conteúdo com acentuação: ção.';
      const r = await concluirTarefaEspecialista(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken, artefato: artefatoDeTeste(conteudo) });
      expect(r).toMatchObject({
        persistido: true,
        claimId: t.claimId,
        tentativa: 1,
        bytes: Buffer.byteLength(conteudo, 'utf8'),
        totalReferencias: 0,
        tarefasLiberadas: 1,
        entregaId: null,
      });
      const l = await linha(t.id);
      expect(l).toMatchObject({ estado: 'concluida', claim_id: null, lease_token: null, lease_expira_em: null, agente_chave: 'frota:architect' });
      expect(l.enviada_em).not.toBeNull();
      expect(l.concluida_em).not.toBeNull();
      expect((await listarTarefasDoPlano(db.pool, p.planoId)).map((x) => [x.chave, x.estado])).toEqual([
        ['a', 'concluida'],
        ['b', 'pronta'],
        ['integracao', 'pendente'],
      ]);

      expect(await concluirTarefaEspecialista(db.pool, { tarefaId: t.id, leaseToken: t.leaseToken, artefato: artefatoDeTeste() })).toEqual({
        persistido: false,
        motivoDescarte: 'tarefa_encerrada',
      });
      const { tarefa: tb } = await reivindicarEEnviar(db.pool, p.planoId);
      expect(await concluirTarefaEspecialista(db.pool, { tarefaId: tb.id, leaseToken: randomUUID(), artefato: artefatoDeTeste() })).toEqual({
        persistido: false,
        motivoDescarte: 'lease_perdido',
      });
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM artefatos_tarefa WHERE tarefa_id = $1', [tb.id]);
      expect(rows[0].n).toBe(0);
    });

    it('concluir exige o envio registrado e o artefato', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      const concluirCru = () => db.pool.query("UPDATE tarefas SET estado = 'concluida' WHERE id = $1", [t.id]);
      await expect(concluirCru()).rejects.toThrow('tarefas: concluir exige o envio registrado');
      await enviar(db.pool, t);
      await expect(concluirCru()).rejects.toThrow('tarefas: concluir exige o artefato da tarefa');
    });

    it('caminho completo: especialista, integracao com entrega unica e plano concluido', async () => {
      const p = await planoAtivoDeTeste(db.pool, [{ chave: 'a', capacidade: 'd1' }]);
      const { tarefa: ta } = await reivindicarEEnviar(db.pool, p.planoId);
      const entrega = { titulo: 'Entrega final', conteudo: '<p>Entrega</p>' };
      await expect(concluirIntegracao(db.pool, { tarefaId: ta.id, leaseToken: ta.leaseToken, artefato: artefatoDeTeste(), entrega })).rejects.toThrow(
        'concluirIntegracao recebeu uma especialista.',
      );
      await concluirTarefaEspecialista(db.pool, { tarefaId: ta.id, leaseToken: ta.leaseToken, artefato: artefatoDeTeste() });

      const { tarefa: ti, reservaId } = await reivindicarEEnviar(db.pool, p.planoId);
      expect(ti).toMatchObject({
        chave: 'integracao',
        tipo: 'integracao',
        capacidade: 'gestores',
        timeoutSegundos: 720,
        agente: { chave: 'frota:gestores', papel: 'coordenador' },
      });
      const { rows: reserva } = await db.pool.query('SELECT operacao FROM reservas_custo WHERE id = $1', [reservaId]);
      expect(reserva[0].operacao).toBe('integracao');
      await expect(concluirTarefaEspecialista(db.pool, { tarefaId: ti.id, leaseToken: ti.leaseToken, artefato: artefatoDeTeste() })).rejects.toThrow(
        'concluirTarefaEspecialista recebeu a integração.',
      );

      const r = await concluirIntegracao(db.pool, {
        tarefaId: ti.id,
        leaseToken: ti.leaseToken,
        artefato: artefatoDeTeste('{"conclusao":"ok"}', [{ tipo: 'artefato', tarefaId: ta.id }], 'json'),
        entrega,
      });
      if (!r.persistido) throw new Error('deveria persistir');
      expect(r).toMatchObject({ claimId: ti.claimId, tentativa: 1, totalReferencias: 1, tarefasLiberadas: 0 });
      const { rows: entregas } = await db.pool.query('SELECT id, titulo, conteudo FROM entregas WHERE demanda_id = $1', [p.demandaId]);
      expect(entregas).toEqual([{ id: r.entregaId, ...entrega }]);
      expect(await linha(ti.id)).toMatchObject({ estado: 'concluida', entrega_id: r.entregaId, claim_id: null, lease_token: null });

      expect(await concluirPlano(db.pool, p.planoId)).toBe(true);
      expect(await concluirPlano(db.pool, p.planoId)).toBe(false);
      expect(await listarPlanosDaDemanda(db.pool, p.demandaId)).toMatchObject([{ estado: 'concluido', motivoAbandono: null }]);
      expect(await obterPlanoAtivo(db.pool, p.demandaId)).toBeNull();
      await expect(db.pool.query("UPDATE planos_demanda SET estado = 'ativo' WHERE id = $1", [p.planoId])).rejects.toThrow(
        'planos_demanda: transição concluido → ativo não é permitida',
      );

      // Um resultado atrasado da integração é descartado: a entrega é única.
      expect(await concluirIntegracao(db.pool, { tarefaId: ti.id, leaseToken: ti.leaseToken, artefato: artefatoDeTeste(), entrega })).toEqual({
        persistido: false,
        motivoDescarte: 'tarefa_encerrada',
      });
      const { rows: n } = await db.pool.query('SELECT count(*)::int AS n FROM entregas WHERE demanda_id = $1', [p.demandaId]);
      expect(n[0].n).toBe(1);
    });

    it('o banco recusa entrega de outra demanda e entrega ja usada por outra integracao', async () => {
      const concluirCru = (tarefaId: string, entregaId: string) =>
        comTransacao(db.pool, async (c) => {
          await inserirArtefato(c, { tarefaId, artefato: artefatoDeTeste() });
          await c.query("UPDATE tarefas SET estado = 'concluida', entrega_id = $2 WHERE id = $1", [tarefaId, entregaId]);
        });

      const p = await planoAtivoDeTeste(db.pool);
      const ti = await levarAteIntegracao(db.pool, p.planoId);
      const outra = await novaDemanda(db.pool);
      const alheia = await criarEntrega(db.pool, { demandaId: outra.demandaId, titulo: 'Alheia', conteudo: 'x' });
      await expect(concluirCru(ti.id, alheia.id)).rejects.toThrow('tarefas: a integração conclui com uma entrega da mesma demanda do plano');
      const r = await concluirIntegracao(db.pool, {
        tarefaId: ti.id,
        leaseToken: ti.leaseToken,
        artefato: artefatoDeTeste(),
        entrega: { titulo: 'Entrega', conteudo: 'ok' },
      });
      if (!r.persistido) throw new Error('deveria persistir');
      await concluirPlano(db.pool, p.planoId);

      // Um segundo plano da mesma demanda não reaproveita a entrega do primeiro.
      const p2 = await registrarPlanoDeTeste(db.pool, p);
      await ativarPlano(db.pool, p2.planoId);
      const ti2 = await levarAteIntegracao(db.pool, p2.planoId);
      await expect(concluirCru(ti2.id, r.entregaId!)).rejects.toThrow(/tarefas_entrega_id_key/);
    });
  });

  describe('abandono', () => {
    it('por pendencia humana: cancela as tarefas abertas, inclusive a em execucao, sem fixar a rota', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      const ta = await reivindicar(db.pool, p.planoId);
      expect(await comTransacao(db.pool, (c) => abandonarPlano(c, { planoId: p.planoId, motivo: 'pendencia_humana' }))).toEqual({
        abandonado: true,
        demandaId: p.demandaId,
        versao: 1,
        tarefasCanceladas: 3,
        rotaFixada: false,
      });
      expect(await linha(ta.id)).toMatchObject({ estado: 'cancelada', claim_id: null, lease_token: null, lease_expira_em: null });
      expect((await listarTarefasDoPlano(db.pool, p.planoId)).map((t) => t.estado)).toEqual(['cancelada', 'cancelada', 'cancelada']);
      expect(await obterEnvelope(db.pool, p.demandaId)).toMatchObject({ rota: 'tarefas', motivoLegado: null });
      expect(await comTransacao(db.pool, (c) => abandonarPlano(c, { planoId: p.planoId, motivo: 'pendencia_humana' }))).toEqual({
        abandonado: false,
      });
      await expect(db.pool.query("UPDATE planos_demanda SET estado = 'ativo' WHERE id = $1", [p.planoId])).rejects.toThrow(
        'planos_demanda: transição abandonado → ativo não é permitida',
      );
      // A demanda pode ganhar um plano novo depois do abandono.
      const p2 = await registrarPlanoDeTeste(db.pool, p);
      expect(await ativarPlano(db.pool, p2.planoId)).toMatchObject({ ativado: true, versao: 2 });
    });

    it.each(['agente_indisponivel', 'tarefa_falhou'] as const)('por %s fixa a rota legado_fixo com o mesmo motivo', async (motivo) => {
      const p = await planoAtivoDeTeste(db.pool);
      expect(await comTransacao(db.pool, (c) => abandonarPlano(c, { planoId: p.planoId, motivo }))).toMatchObject({
        abandonado: true,
        tarefasCanceladas: 2,
        rotaFixada: true,
      });
      expect(await obterEnvelope(db.pool, p.demandaId)).toMatchObject({ rota: 'legado_fixo', motivoLegado: motivo });
    });

    it('os gatilhos adiados recusam, no COMMIT, um encerramento pela metade', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const abandonarCru = (c: pg.PoolClient, motivo: string) =>
        c.query("UPDATE planos_demanda SET estado = 'abandonado', motivo_abandono = $2 WHERE id = $1", [p.planoId, motivo]);
      const cancelarCru = (c: pg.PoolClient) => c.query("UPDATE tarefas SET estado = 'cancelada' WHERE plano_id = $1", [p.planoId]);

      await expect(comTransacao(db.pool, (c) => abandonarCru(c, 'pendencia_humana'))).rejects.toThrow(
        'planos_demanda: plano abandonado com tarefa aberta',
      );
      await expect(
        comTransacao(db.pool, async (c) => {
          await abandonarCru(c, 'tarefa_falhou');
          await cancelarCru(c);
        }),
      ).rejects.toThrow('planos_demanda: abandono por tarefa_falhou exige a rota legado_fixo com o mesmo motivo');
      await expect(
        comTransacao(db.pool, async (c) => {
          await abandonarCru(c, 'tarefa_falhou');
          await cancelarCru(c);
          await fixarRotaLegado(c, { demandaId: p.demandaId, motivo: 'agente_indisponivel' });
        }),
      ).rejects.toThrow('planos_demanda: abandono por tarefa_falhou exige a rota legado_fixo com o mesmo motivo');
      await expect(comTransacao(db.pool, (c) => fixarRotaLegado(c, { demandaId: p.demandaId, motivo: 'tarefa_falhou' }))).rejects.toThrow(
        'orquestracao_demandas: a rota legado_fixo não pode conviver com plano ativo',
      );
      await expect(db.pool.query("UPDATE tarefas SET estado = 'cancelada' WHERE id = $1", [p.ids.analise])).rejects.toThrow(
        'tarefas: cancelar exige o plano abandonado na mesma transação',
      );

      // Nada disso ficou gravado.
      expect(await obterPlanoAtivo(db.pool, p.demandaId)).toMatchObject({ id: p.planoId });
      expect(await obterEnvelope(db.pool, p.demandaId)).toMatchObject({ rota: 'tarefas' });
      expect((await listarTarefasDoPlano(db.pool, p.planoId)).map((t) => t.estado)).toEqual(['pronta', 'pendente']);
    });
  });

  describe('leituras, politicas e eventos por tarefa', () => {
    it('as listagens nunca devolvem objetivo nem lease_token; so a montagem do prompt le o objetivo', async () => {
      const segredo = 'Objetivo reservado da tarefa';
      const p = await planoAtivoDeTeste(db.pool, [{ chave: 'a', capacidade: 'd1', objetivo: segredo }]);
      const t = await reivindicar(db.pool, p.planoId);
      const tarefas = await listarTarefasDoPlano(db.pool, p.planoId);
      expect(Object.keys(tarefas[0]!).sort()).toEqual(
        [
          'id',
          'chave',
          'tipo',
          'capacidade',
          'estado',
          'tentativas',
          'maxTentativas',
          'claimId',
          'agente',
          'leaseExpiraEm',
          'enviadaEm',
          'iniciadaEm',
          'concluidaEm',
          'codigoErro',
          'entregaId',
        ].sort(),
      );
      const texto = JSON.stringify([tarefas, await listarPlanosDaDemanda(db.pool, p.demandaId)]);
      expect(texto).not.toContain(segredo);
      expect(texto).not.toContain(t.leaseToken);
      expect(texto).toContain(t.claimId);
      expect(await listarTarefasParaPrompt(db.pool, p.planoId)).toEqual([
        { id: p.ids.a, chave: 'a', tipo: 'especialista', objetivo: segredo },
        { id: p.ids.integracao, chave: 'integracao', tipo: 'integracao', objetivo: null },
      ]);
    });

    it('avaliacao de politica por tarefa: uma por claim, e o estagio pre so com o snapshot do claim atual', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t1 = await reivindicar(db.pool, p.planoId);
      const contexto: ContextoAvaliacao = {
        agente: t1.agente.chave,
        papel: t1.agente.papel,
        categoria: 'd1',
        estado: 'ativo',
        modelo: t1.agente.modelo,
        operacao: 'execucao',
        prioridade: 'MEDIUM',
      };
      const avaliar = (t: TarefaReivindicada, claimId = t.claimId) =>
        avaliarEregistrar(db.pool, {
          demandaId: p.demandaId,
          runId: p.runId,
          correlacaoId: p.runId,
          tentativa: 1,
          estagio: 'pre',
          contexto,
          tarefa: { id: t.id, claimId },
        });

      expect(await avaliar(t1)).toBe('allow');
      await devolverTarefa(db.pool, { tarefaId: t1.id, leaseToken: t1.leaseToken });
      const t2 = await reivindicar(db.pool, p.planoId);
      expect(await avaliar(t2)).toBe('allow');
      expect((await listarAvaliacoesDaDemanda(db.pool, p.demandaId)).map((a) => [a.tarefaId, a.claimId])).toEqual([
        [t1.id, t1.claimId],
        [t2.id, t2.claimId],
      ]);
      const eventos = (await listarEventosDaDemanda(db.pool, p.demandaId)).filter((e) => e.tipoEvento === 'politica_avaliada');
      const metadata = (claimId: string) => ({
        estagio: 'pre',
        decisao: 'allow',
        politicaId: null,
        regraId: null,
        versaoRegra: null,
        operacao: 'execucao',
        claimId,
      });
      expect(eventos.map((e) => [e.tarefaId, e.metadata])).toEqual([
        [t1.id, metadata(t1.claimId)],
        [t2.id, metadata(t2.claimId)],
      ]);

      // O claim antigo já não vale no estágio pre. Fail-open: a avaliação devolve allow, mas nada é gravado.
      expect(await avaliar(t2, t1.claimId)).toBe('allow');
      expect(await listarAvaliacoesDaDemanda(db.pool, p.demandaId)).toHaveLength(2);

      const inserirCru = (demandaId: string, estagio: string, ctx: ContextoAvaliacao, claimId: string | null) =>
        db.pool.query(
          `INSERT INTO avaliacoes_politica (demanda_id, run_id, estagio, decisao, contexto, tarefa_id, claim_id)
           VALUES ($1, $2, $3, 'allow', $4, $5, $6)`,
          [demandaId, p.runId, estagio, JSON.stringify(ctx), t2.id, claimId],
        );
      const pre = 'avaliacoes_politica: a avaliação pre usa exatamente o snapshot do claim atual';
      await expect(inserirCru(p.demandaId, 'pre', contexto, t1.claimId)).rejects.toThrow(pre);
      await expect(inserirCru(p.demandaId, 'pre', { ...contexto, modelo: 'claude-opus-5' }, t2.claimId)).rejects.toThrow(pre);
      await expect(inserirCru(p.demandaId, 'pre', { ...contexto, papel: 'coordenador' }, t2.claimId)).rejects.toThrow(pre);
      await expect(inserirCru(p.demandaId, 'pre', { ...contexto, operacao: 'integracao' }, t2.claimId)).rejects.toThrow(
        'avaliacoes_politica: a operação precisa ser a da tarefa',
      );
      // Sem a operação no contexto, também não: a comparação não deixa um valor ausente passar.
      const semOperacao = { ...contexto, operacao: undefined } as unknown as ContextoAvaliacao;
      await expect(inserirCru(p.demandaId, 'post', semOperacao, t2.claimId)).rejects.toThrow(
        'avaliacoes_politica: a operação precisa ser a da tarefa',
      );
      const outra = await novaDemanda(db.pool);
      await expect(inserirCru(outra.demandaId, 'post', contexto, t2.claimId)).rejects.toThrow(
        'avaliacoes_politica: a tarefa precisa ser da mesma demanda da avaliação',
      );
      await expect(inserirCru(p.demandaId, 'post', contexto, null)).rejects.toThrow(/avaliacoes_politica_claim_check/);
      // Fora do estágio pre, o claim de uma chamada já encerrada continua aceito (a avaliação post vem depois).
      await inserirCru(p.demandaId, 'post', contexto, t1.claimId);
    });

    it('um evento com tarefa precisa ser da mesma demanda da tarefa', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const outra = await novaDemanda(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      const evento = (demandaId: string) =>
        registrarEvento(db.pool, {
          demandaId,
          correlacaoId: p.runId,
          runId: p.runId,
          tentativa: null,
          tipoEvento: 'agente_selecionado',
          ator: ATOR_SISTEMA,
          tarefaId: t.id,
          chaveIdempotencia: montarChaveIdempotencia(p.runId, 'agente_selecionado', t.claimId),
          metadata: { claimId: t.claimId, agente: t.agente.chave, versaoAgente: t.agente.versao, capacidade: 'd1' },
        });
      await expect(evento(outra.demandaId)).rejects.toThrow('agent_events: a tarefa precisa ser da mesma demanda do evento');
      expect(await evento(p.demandaId)).toMatchObject({ tarefaId: t.id, tipoEvento: 'agente_selecionado', resumo: 'Agente selecionado para a tarefa.' });
      expect((await listarEventosDaDemanda(db.pool, p.demandaId)).map((e) => e.tarefaId)).toEqual([t.id]);
      expect(await listarEventosDaDemanda(db.pool, outra.demandaId)).toEqual([]);
    });
  });
});
