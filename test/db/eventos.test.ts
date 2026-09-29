import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDemanda } from '../../src/db/demandas.ts';
import {
  listarEventosDaDemanda,
  listarEventosDaRun,
  montarChaveIdempotencia,
  registrarEvento,
} from '../../src/db/eventos.ts';
import { listarMigracoesDisponiveis } from '../../src/db/migrate.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('migration 002_agent_events', () => {
  it('esta registrada e aplicada junto com as demais migrations', async () => {
    expect(await listarMigracoesDisponiveis()).toEqual([
      '001_init.sql',
      '002_agent_events.sql',
      '003_agentes.sql',
      '004_policy_engine.sql',
      '005_planos_tarefas.sql',
    ]);
  });
});

describe('agent_events', () => {
  let db: TestDb;
  let demandaId: string;
  let runId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs CASCADE');
    demandaId = (await criarDemanda(db.pool, { titulo: 'Demanda de teste', categoria: 'd1' })).id;
    runId = await iniciarRun(db.pool);
  });

  // processamento_iniciado tem metadata vazia: é o tipo mais simples para os testes que não são sobre
  // o conteúdo da metadata em si.
  function evento(sobrescrever: Partial<Parameters<typeof registrarEvento>[1]> = {}) {
    return {
      demandaId,
      correlacaoId: runId,
      runId,
      tentativa: 1,
      tipoEvento: 'processamento_iniciado' as const,
      ator: 'frota:architect',
      chaveIdempotencia: montarChaveIdempotencia(runId, 'processamento_iniciado'),
      metadata: {},
      ...sobrescrever,
    };
  }

  describe('estrutura da tabela', () => {
    it('cria a tabela com as colunas esperadas', async () => {
      const { rows } = await db.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_events' ORDER BY column_name",
      );
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        [
          'id',
          'demanda_id',
          'correlacao_id',
          'run_id',
          'tentativa',
          'sequencia_demanda',
          'tipo_evento',
          'schema_versao',
          'ator',
          'resumo',
          'metadata',
          'chave_idempotencia',
          'ocorrido_em',
        ].sort(),
      );
    });

    it('rejeita resumo vazio ou maior que 2000 caracteres, mesmo por SQL direto', async () => {
      const base =
        "INSERT INTO agent_events (demanda_id, correlacao_id, tentativa, sequencia_demanda, tipo_evento, ator, resumo, chave_idempotencia) VALUES ($1, $3, 1, 1, 't', 'sistema', $2, 'k')";
      await expect(db.pool.query(base, [demandaId, '', randomUUID()])).rejects.toThrow();
      await expect(db.pool.query(base, [demandaId, 'x'.repeat(2001), randomUUID()])).rejects.toThrow();
    });

    it('rejeita run_id que nao existe (chave estrangeira)', async () => {
      await expect(registrarEvento(db.pool, evento({ runId: randomUUID() }))).rejects.toThrow();
    });

    it('rejeita demanda_id que nao existe', async () => {
      await expect(registrarEvento(db.pool, evento({ demandaId: randomUUID() }))).rejects.toThrow();
    });

    it('rejeita tipo_evento fora da lista permitida, mesmo contornando o tipo do TypeScript', async () => {
      await expect(
        registrarEvento(db.pool, evento({ tipoEvento: 'tipo_inventado' as never })),
      ).rejects.toThrow(/não permitido/);
    });

    it('aceita tentativa nula: o evento nao prova que o processamento comecou', async () => {
      const e = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'demanda_reivindicada', tentativa: null, metadata: { tentativaPlanejada: 1 } }),
      );
      expect(e.tentativa).toBeNull();
    });
  });

  describe('append-only: UPDATE e DELETE bloqueados', () => {
    it('recusa UPDATE com a mensagem do gatilho', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query("UPDATE agent_events SET resumo = 'alterado'")).rejects.toThrow(/append-only/);
    });

    it('recusa DELETE com a mensagem do gatilho', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query('DELETE FROM agent_events')).rejects.toThrow(/append-only/);
    });

    it('TRUNCATE ... CASCADE (usado pela limpeza dos testes) continua funcionando', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query('TRUNCATE demandas CASCADE')).resolves.toBeDefined();
    });
  });

  describe('apagar a demanda-mae: RESTRICT, nao CASCADE', () => {
    it('bloqueia a remocao fisica de uma demanda que tem eventos', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query('DELETE FROM demandas WHERE id = $1', [demandaId])).rejects.toThrow();
      // a demanda continua existindo, porque o DELETE foi rejeitado
      const { rowCount } = await db.pool.query('SELECT 1 FROM demandas WHERE id = $1', [demandaId]);
      expect(rowCount).toBe(1);
    });

    it('permite apagar uma demanda que nunca teve eventos', async () => {
      const semEventos = (await criarDemanda(db.pool, { titulo: 'Sem eventos', categoria: 'd1' })).id;
      await expect(db.pool.query('DELETE FROM demandas WHERE id = $1', [semEventos])).resolves.toBeDefined();
    });
  });

  describe('ordenacao (cursor global id)', () => {
    it('atribui sequencia_demanda crescente comecando em 1, por demanda', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd2' })).id;

      const e1 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'a' }));
      const e2 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));
      const eOutra = await registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: 'a' }));

      expect(e1.sequenciaDemanda).toBe(1);
      expect(e2.sequenciaDemanda).toBe(2);
      expect(eOutra.sequenciaDemanda).toBe(1);
    });

    it('cursor global (id) cresce entre demandas diferentes, sem reiniciar', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd2' })).id;
      const e1 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'a' }));
      const e2 = await registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: 'a' }));
      const e3 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));

      expect(BigInt(e2.id)).toBeGreaterThan(BigInt(e1.id));
      expect(BigInt(e3.id)).toBeGreaterThan(BigInt(e2.id));
    });

    it('listarEventosDaDemanda ordena por id (cursor global), nao por sequencia_demanda ou tentativa', async () => {
      await registrarEvento(db.pool, evento({ tipoEvento: 'demanda_criada', chaveIdempotencia: 'a', metadata: { categoria: 'd1', prioridade: 'MEDIUM' } }));
      await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));
      await registrarEvento(db.pool, evento({ tipoEvento: 'demanda_reaberta', chaveIdempotencia: 'c', metadata: { origem: 'manual' } }));

      const lista = await listarEventosDaDemanda(db.pool, demandaId);
      expect(lista.map((e) => e.tipoEvento)).toEqual(['demanda_criada', 'processamento_iniciado', 'demanda_reaberta']);
      // id crescente e estritamente ordenado — é a garantia de estabilidade, não sequencia_demanda.
      for (let i = 1; i < lista.length; i++) expect(BigInt(lista[i]!.id)).toBeGreaterThan(BigInt(lista[i - 1]!.id));
    });

    it('listarEventosDaRun devolve os eventos de varias demandas na mesma run, em ordem de id', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd2' })).id;
      await registrarEvento(db.pool, evento({ chaveIdempotencia: 'a' }));
      await registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: 'a' }));
      await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));

      const lista = await listarEventosDaRun(db.pool, runId);
      expect(lista).toHaveLength(3);
      expect(lista.map((e) => e.demandaId)).toEqual([demandaId, outraDemandaId, demandaId]);
      for (let i = 1; i < lista.length; i++) expect(BigInt(lista[i]!.id)).toBeGreaterThan(BigInt(lista[i - 1]!.id));
    });

    it('duas demandas processadas em paralelo nao embaralham suas sequencias', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Paralela', categoria: 'd2' })).id;

      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => registrarEvento(db.pool, evento({ chaveIdempotencia: `d1-${i}` }))),
        ...Array.from({ length: 5 }, (_, i) =>
          registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: `d2-${i}` })),
        ),
      ]);

      const seqDemanda1 = (await listarEventosDaDemanda(db.pool, demandaId)).map((e) => e.sequenciaDemanda);
      const seqDemanda2 = (await listarEventosDaDemanda(db.pool, outraDemandaId)).map((e) => e.sequenciaDemanda);
      expect(seqDemanda1.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      expect(seqDemanda2.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('idempotencia e retry', () => {
    it('a mesma chave para a mesma demanda nunca duplica: devolve o evento original', async () => {
      const primeiro = await registrarEvento(db.pool, evento());
      const segundo = await registrarEvento(db.pool, evento());

      expect(segundo.id).toBe(primeiro.id);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(1);
    });

    it('chamadas concorrentes com a mesma chave produzem um unico evento (retry seguro)', async () => {
      const resultados = await Promise.all(Array.from({ length: 8 }, () => registrarEvento(db.pool, evento())));
      const idsUnicos = new Set(resultados.map((r) => r.id));
      expect(idsUnicos.size).toBe(1);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(1);
    });

    it('duas execucoes distintas (correlacaoId diferente) nunca colidem, mesmo com o mesmo numero de tentativa', async () => {
      // Este é exatamente o cenário que a tentativa sozinha não conseguia distinguir: run A e run B
      // processam a MESMA demanda na tentativa 1 (ex.: run A sofreu parada sistêmica e devolveu sem
      // penalizar, ou a demanda foi reaberta e zerou tentativas) — o correlacaoId (run_id) é que garante
      // que os eventos de uma não apagam os da outra.
      const runA = runId;
      const runB = await iniciarRun(db.pool);

      const eA = await registrarEvento(
        db.pool,
        evento({ runId: runA, correlacaoId: runA, tentativa: 1, chaveIdempotencia: montarChaveIdempotencia(runA, 'processamento_iniciado') }),
      );
      const eB = await registrarEvento(
        db.pool,
        evento({ runId: runB, correlacaoId: runB, tentativa: 1, chaveIdempotencia: montarChaveIdempotencia(runB, 'processamento_iniciado') }),
      );

      expect(eB.id).not.toBe(eA.id);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(2);
    });

    it('interrupcao sistemica seguida de reprocessamento e reabertura: cada execucao fica com seus proprios eventos', async () => {
      // run 1: começa, sofre parada sistêmica (orçamento/pausa/API fora do ar) e devolve sem penalizar
      // a tentativa (desfazerTentativa = true em devolverParaFila, fora do escopo deste teste unitário).
      const run1 = runId;
      await registrarEvento(
        db.pool,
        evento({
          runId: run1,
          correlacaoId: run1,
          tentativa: 1,
          chaveIdempotencia: montarChaveIdempotencia(run1, 'processamento_iniciado'),
        }),
      );
      await registrarEvento(
        db.pool,
        evento({
          runId: run1,
          correlacaoId: run1,
          tentativa: 1,
          tipoEvento: 'demanda_devolvida_para_fila',
          chaveIdempotencia: montarChaveIdempotencia(run1, 'demanda_devolvida_para_fila'),
          metadata: { motivoDevolucao: 'parada_sistemica', codigoErro: 'orcamento_excedido' },
        }),
      );

      // run 2: reprocessa a mesma demanda, ainda na "tentativa 1" (a run 1 não consumiu a tentativa) —
      // é exatamente o caso que tentativa sozinha não distingue, mas correlacaoId (run2 !== run1) sim.
      const run2 = await iniciarRun(db.pool);
      const e2 = await registrarEvento(
        db.pool,
        evento({
          runId: run2,
          correlacaoId: run2,
          tentativa: 1,
          chaveIdempotencia: montarChaveIdempotencia(run2, 'processamento_iniciado'),
        }),
      );

      // depois, a demanda é reaberta pela interface (reabrirDemanda zera tentativas): outra correlação
      // imutável (um UUID de ação de interface, sem run), sem tentativa provada (null).
      const correlacaoReabertura = randomUUID();
      const e3 = await registrarEvento(
        db.pool,
        evento({
          runId: null,
          correlacaoId: correlacaoReabertura,
          tentativa: null,
          tipoEvento: 'demanda_reaberta',
          chaveIdempotencia: montarChaveIdempotencia(correlacaoReabertura, 'demanda_reaberta'),
          metadata: { origem: 'manual' },
        }),
      );

      const linha = await listarEventosDaDemanda(db.pool, demandaId);
      expect(linha).toHaveLength(4);
      expect(new Set(linha.map((e) => e.correlacaoId)).size).toBe(3);
      expect(e2.tentativa).toBe(1);
      expect(e3.tentativa).toBeNull();
    });

    it('a mesma run com tipos de evento diferentes gera eventos distintos', async () => {
      const t1 = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'demanda_falhou', chaveIdempotencia: montarChaveIdempotencia(runId, 'demanda_falhou'), metadata: { codigoErro: 'falha_inesperada' } }),
      );
      const t2 = await registrarEvento(
        db.pool,
        evento({
          tipoEvento: 'demanda_devolvida_para_fila',
          chaveIdempotencia: montarChaveIdempotencia(runId, 'demanda_devolvida_para_fila'),
          metadata: { motivoDevolucao: 'falha_da_demanda', codigoErro: 'falha_inesperada' },
        }),
      );

      expect(t2.id).not.toBe(t1.id);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(2);
    });
  });

  describe('conteudo seguro: resumo fixo e metadata restrita por schema', () => {
    it('resumo e sempre o texto fixo do tipo, nunca o que foi passado em metadata', async () => {
      const e = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'entrega_criada', metadata: { entregaId: randomUUID(), tipo: 'html', publicadaComoHtml: true } }),
      );
      expect(e.resumo).toBe('Entrega criada.');
    });

    it('metadata guarda so o que o schema do tipo permite, sem campos extras', async () => {
      const e = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'auditoria_concluida', metadata: { antipadroesCount: 2, regrasCumpridasPercent: 50 } }),
      );
      expect(e.metadata).toEqual({ antipadroesCount: 2, regrasCumpridasPercent: 50 });
    });

    it('rejeita metadata com campo fora do schema do tipo', async () => {
      await expect(
        registrarEvento(db.pool, evento({ tipoEvento: 'auditoria_concluida', metadata: { antipadroesCount: 2, regrasCumpridasPercent: 50, extra: 'x' } })),
      ).rejects.toThrow();
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(0);
    });

    it('rejeita metadata com texto livre onde o schema exige enum ou numero', async () => {
      await expect(
        registrarEvento(db.pool, evento({ tipoEvento: 'chamada_trabalho_falhou', metadata: { codigoErro: 'um erro qualquer em texto livre' } })),
      ).rejects.toThrow();
    });

    it('rejeita campos classicamente perigosos, porque eles simplesmente nao existem em nenhum schema', async () => {
      for (const campo of ['prompt', 'chain_of_thought', 'raciocinio', 'resposta_bruta', 'api_key', 'authorization']) {
        await expect(registrarEvento(db.pool, evento({ metadata: { [campo]: 'x' } }))).rejects.toThrow();
      }
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(0);
    });

    it('um segredo colocado em titulo, plano, motivo, descricao ou mensagem de erro nunca aparece em agent_events', async () => {
      const segredo = 'RACIOCINIO_INTERNO_BRUTO_NAO_DEVE_VAZAR_AQUI';
      const demandaComSegredo = await criarDemanda(db.pool, { titulo: `Demanda ${segredo}`, categoria: 'd1' });

      // Simula os pontos reais do fluxo: cada um usa só o resumo fixo e a metadata do schema do tipo —
      // nunca o texto que, na aplicação real, viria do título, do plano do modelo, do motivo de uma
      // pendência, da descrição de um insumo faltante ou da mensagem de um erro lançado.
      await registrarEvento(db.pool, {
        demandaId: demandaComSegredo.id,
        correlacaoId: runId,
        runId,
        tentativa: null,
        tipoEvento: 'demanda_criada',
        ator: 'solicitante',
        chaveIdempotencia: montarChaveIdempotencia(runId, 'demanda_criada'),
        // metadata do schema real de demanda_criada: categoria e prioridade, nunca o título.
        metadata: { categoria: 'd1', prioridade: 'MEDIUM' },
      });
      await registrarEvento(db.pool, {
        demandaId: demandaComSegredo.id,
        correlacaoId: runId,
        runId,
        tentativa: 1,
        tipoEvento: 'pendencia_humana_registrada',
        ator: 'frota:architect',
        chaveIdempotencia: montarChaveIdempotencia(runId, 'pendencia_humana_registrada'),
        // motivo real (`segredo`) nunca entra: só a contagem de ações.
        metadata: { totalAcoes: 2 },
      });
      await registrarEvento(db.pool, {
        demandaId: demandaComSegredo.id,
        correlacaoId: runId,
        runId,
        tentativa: 1,
        tipoEvento: 'chamada_trabalho_falhou',
        ator: 'frota:architect',
        chaveIdempotencia: montarChaveIdempotencia(runId, 'chamada_trabalho_falhou'),
        // mensagem real do erro (poderia conter `segredo`) nunca entra: só o código classificado.
        metadata: { codigoErro: 'llm_invalido' },
      });

      const eventos = await listarEventosDaDemanda(db.pool, demandaComSegredo.id);
      expect(eventos.length).toBeGreaterThan(0);
      expect(JSON.stringify(eventos)).not.toContain(segredo);
    });
  });
});
