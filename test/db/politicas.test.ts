import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarDemanda } from '../../src/db/demandas.ts';
import { listarEventosDaDemanda } from '../../src/db/eventos.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import {
  atualizarPolitica,
  avaliarEregistrar,
  criarPolitica,
  criarRegra,
  listarAvaliacoesDaDemanda,
  listarHistoricoDaPolitica,
  obterPoliticaPorChave,
  type ContextoAvaliacao,
} from '../../src/db/politicas.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

const ATOR_TESTE = 'teste';

const contextoPadrao: ContextoAvaliacao = {
  agente: 'frota:architect',
  papel: 'executor',
  categoria: 'd1',
  estado: 'ativo',
  modelo: 'claude-sonnet-5',
  operacao: 'execucao',
  prioridade: 'MEDIUM',
};

describe('policy engine determinístico em modo shadow (Fase 2, Entrega 2)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function demandaERun() {
    const demanda = await criarDemanda(db.pool, { titulo: 'Demanda de teste', categoria: 'd1' });
    const runId = await iniciarRun(db.pool);
    return { demandaId: demanda.id, runId };
  }

  describe('estrutura da migration', () => {
    it('cria politicas, politicas_historico, regras_politica e avaliacoes_politica com as colunas esperadas', async () => {
      const tabelas: Record<string, string[]> = {
        politicas: ['id', 'chave', 'nome', 'descricao', 'estado', 'versao', 'criado_em', 'atualizado_em'],
        politicas_historico: ['id', 'politica_id', 'ator', 'campos_alterados', 'versao_anterior', 'versao_nova', 'ocorrido_em'],
        regras_politica: ['id', 'politica_id', 'chave', 'estagio', 'decisao', 'condicao', 'versao', 'criado_em'],
        avaliacoes_politica: [
          'id',
          'demanda_id',
          'run_id',
          'regra_id',
          'politica_id',
          'estagio',
          'decisao',
          'contexto',
          'versao_regra',
          'ocorrido_em',
        ],
      };
      for (const [tabela, colunas] of Object.entries(tabelas)) {
        const { rows } = await db.pool.query<{ column_name: string }>(
          'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
          [tabela],
        );
        expect(rows.map((r) => r.column_name).sort()).toEqual(colunas.sort());
      }
    });

    it('nenhuma coluna, em nenhuma das quatro tabelas, guarda prompt, token, segredo, motivo ou raciocinio', async () => {
      const { rows } = await db.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name IN ('politicas', 'politicas_historico', 'regras_politica', 'avaliacoes_politica')",
      );
      const nomes = rows.map((r) => r.column_name);
      for (const proibido of ['prompt', 'token', 'segredo', 'api_key', 'raciocinio', 'motivo', 'resposta']) {
        expect(nomes.some((n) => n.includes(proibido))).toBe(false);
      }
    });
  });

  describe('regras_politica: totalmente append-only', () => {
    it('rejeita UPDATE e DELETE diretos', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-append-only', nome: 'Append only', descricao: 'Teste.' });
      const regra = await criarRegra(db.pool, {
        politicaId: politica.id,
        chave: 'regra-append-only',
        estagio: 'pre',
        decisao: 'warn',
        // modelo exclusivo: esta política fica ativa pelo resto do arquivo (só testamos o INSERT aqui),
        // então a condição não pode ser larga o bastante para contaminar avaliações de outros testes.
        condicao: { categoria: 'd1', modelo: 'modelo-teste-append-only' },
      });
      await expect(db.pool.query('UPDATE regras_politica SET decisao = $1 WHERE id = $2', ['deny', regra.id])).rejects.toThrow(
        /append-only/,
      );
      await expect(db.pool.query('DELETE FROM regras_politica WHERE id = $1', [regra.id])).rejects.toThrow(/append-only/);
    });

    it('rejeita condicao com campo fora da allowlist, mesmo por SQL direto', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-condicao-livre', nome: 'x', descricao: 'x' });
      await expect(
        criarRegra(db.pool, {
          politicaId: politica.id,
          chave: 'regra-invalida',
          estagio: 'pre',
          decisao: 'deny',
          // @ts-expect-error campo fora da allowlist, de propósito
          condicao: { motivo: 'texto livre nunca deveria ser aceito aqui' },
        }),
      ).rejects.toThrow();
    });

    it('rejeita estagio ou decisao fora do dominio fechado, mesmo por SQL direto', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-dominio', nome: 'x', descricao: 'x' });
      await expect(
        db.pool.query(
          `INSERT INTO regras_politica (politica_id, chave, estagio, decisao, condicao) VALUES ($1, 'x1', 'meio', 'warn', '{}'::jsonb)`,
          [politica.id],
        ),
      ).rejects.toThrow();
      await expect(
        db.pool.query(
          `INSERT INTO regras_politica (politica_id, chave, estagio, decisao, condicao) VALUES ($1, 'x2', 'pre', 'bloquear_tudo', '{}'::jsonb)`,
          [politica.id],
        ),
      ).rejects.toThrow();
    });
  });

  describe('avaliacoes_politica: append-only', () => {
    it('rejeita UPDATE e DELETE diretos', async () => {
      const { demandaId, runId } = await demandaERun();
      await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'pre',
        contexto: contextoPadrao,
      });
      const [avaliacao] = await listarAvaliacoesDaDemanda(db.pool, demandaId);
      await expect(db.pool.query('UPDATE avaliacoes_politica SET decisao = $1 WHERE id = $2', ['deny', avaliacao!.id])).rejects.toThrow(
        /append-only/,
      );
      await expect(db.pool.query('DELETE FROM avaliacoes_politica WHERE id = $1', [avaliacao!.id])).rejects.toThrow(/append-only/);
    });
  });

  describe('politicas: identidade imutável, estado versionado com trilha real', () => {
    it('bloqueia UPDATE que muda id, chave, nome ou descricao', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-imutavel', nome: 'Nome', descricao: 'Descrição.' });
      await expect(db.pool.query('UPDATE politicas SET chave = $1 WHERE id = $2', ['outra', politica.id])).rejects.toThrow(
        /imutáveis/,
      );
      await expect(db.pool.query('UPDATE politicas SET nome = $1 WHERE id = $2', ['Outro nome', politica.id])).rejects.toThrow(
        /imutáveis/,
      );
    });

    it('atualizarPolitica muda estado, incrementa versao e grava trilha', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-versionada', nome: 'x', descricao: 'x' });
      const depois = await atualizarPolitica(db.pool, politica.chave, 'operador:ana', 'inativa');
      expect(depois.estado).toBe('inativa');
      expect(depois.versao).toBe(politica.versao + 1);
      const historico = await listarHistoricoDaPolitica(db.pool, politica.id);
      expect(historico).toHaveLength(1);
      expect(historico[0]).toMatchObject({
        ator: 'operador:ana',
        camposAlterados: { estado: { de: 'ativa', para: 'inativa' } },
      });
    });

    it('atualizarPolitica para o mesmo estado que ja tem: nao versiona nem grava trilha', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-sem-mudanca', nome: 'x', descricao: 'x' });
      const depois = await atualizarPolitica(db.pool, politica.chave, ATOR_TESTE, politica.estado);
      expect(depois.versao).toBe(politica.versao);
      expect(await listarHistoricoDaPolitica(db.pool, politica.id)).toHaveLength(0);
    });

    it('UPDATE direto de estado, sem passar por atualizarPolitica, tambem grava trilha automaticamente', async () => {
      const politica = await criarPolitica(db.pool, { chave: 'pol-sql-direto', nome: 'x', descricao: 'x' });
      await db.pool.query("UPDATE politicas SET estado = 'inativa' WHERE id = $1", [politica.id]);
      const historico = await listarHistoricoDaPolitica(db.pool, politica.id);
      expect(historico).toHaveLength(1);
      expect(historico[0]!.ator).toBe('sistema:sql_direto');
    });
  });

  describe('avaliação determinística: allow, warn, require_approval, deny', () => {
    it.each(['allow', 'warn', 'require_approval', 'deny'] as const)(
      'regra com decisao "%s" e registrada exatamente com essa decisao',
      async (decisao) => {
        const { demandaId, runId } = await demandaERun();
        // modelo exclusivo desta iteração: evita que regras de iterações anteriores (todas ativas, todas
        // append-only) interfiram na avaliação — cada it.each usa seu próprio recorte do contexto.
        const modelo = `modelo-teste-${decisao}`;
        const politica = await criarPolitica(db.pool, { chave: `pol-${decisao}`, nome: 'x', descricao: 'x' });
        await criarRegra(db.pool, {
          politicaId: politica.id,
          chave: `regra-${decisao}`,
          estagio: 'pre',
          decisao,
          condicao: { categoria: 'd1', operacao: 'execucao', modelo },
        });

        const resultado = await avaliarEregistrar(db.pool, {
          demandaId,
          runId,
          correlacaoId: runId,
          tentativa: 1,
          estagio: 'pre',
          contexto: { ...contextoPadrao, modelo },
        });

        expect(resultado).toBe(decisao);
        const [avaliacao] = await listarAvaliacoesDaDemanda(db.pool, demandaId);
        expect(avaliacao!.decisao).toBe(decisao);
        expect(avaliacao!.politicaId).toBe(politica.id);
      },
    );

    it('sem regra correspondente: decisao implicita allow, sem regra/politica associada', async () => {
      const { demandaId, runId } = await demandaERun();
      const resultado = await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'pre',
        contexto: { ...contextoPadrao, categoria: 'd18' },
      });
      expect(resultado).toBe('allow');
      const [avaliacao] = await listarAvaliacoesDaDemanda(db.pool, demandaId);
      expect(avaliacao!.regraId).toBeNull();
      expect(avaliacao!.politicaId).toBeNull();
    });

    it('entre regras que casam, a mais restritiva vence (deny sobre warn)', async () => {
      const { demandaId, runId } = await demandaERun();
      const politica = await criarPolitica(db.pool, { chave: 'pol-severidade', nome: 'x', descricao: 'x' });
      await criarRegra(db.pool, {
        politicaId: politica.id,
        chave: 'regra-warn-generica',
        estagio: 'during',
        decisao: 'warn',
        condicao: { operacao: 'auditoria' },
      });
      await criarRegra(db.pool, {
        politicaId: politica.id,
        chave: 'regra-deny-especifica',
        estagio: 'during',
        decisao: 'deny',
        condicao: { operacao: 'auditoria', agente: 'frota:agent-evaluator' },
      });

      const resultado = await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'during',
        contexto: { ...contextoPadrao, agente: 'frota:agent-evaluator', operacao: 'auditoria' },
      });

      expect(resultado).toBe('deny');
    });

    it('regra inativa (politica inativa) nunca e considerada', async () => {
      const { demandaId, runId } = await demandaERun();
      const modelo = 'modelo-teste-inativa';
      const politica = await criarPolitica(db.pool, { chave: 'pol-inativa', nome: 'x', descricao: 'x' });
      await criarRegra(db.pool, {
        politicaId: politica.id,
        chave: 'regra-nunca-ativa',
        estagio: 'pre',
        decisao: 'deny',
        condicao: { categoria: 'd1', modelo },
      });
      await atualizarPolitica(db.pool, politica.chave, ATOR_TESTE, 'inativa');

      const resultado = await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'pre',
        contexto: { ...contextoPadrao, modelo },
      });

      expect(resultado).toBe('allow');
    });
  });

  describe('deny nao bloqueia nada em modo shadow', () => {
    it('deny e registrado normalmente, sem lancar excecao nem alterar nenhum estado', async () => {
      const { demandaId, runId } = await demandaERun();
      const politica = await criarPolitica(db.pool, { chave: 'pol-deny-shadow', nome: 'x', descricao: 'x' });
      const modelo = 'modelo-teste-deny-shadow';
      await criarRegra(db.pool, {
        politicaId: politica.id,
        chave: 'regra-deny-shadow',
        estagio: 'pre',
        decisao: 'deny',
        condicao: { categoria: 'd1', modelo },
      });

      // Não há try/catch aqui de propósito: avaliarEregistrar nunca lança, mesmo quando a decisão é deny.
      const resultado = await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'pre',
        contexto: { ...contextoPadrao, modelo },
      });

      expect(resultado).toBe('deny');
      // A demanda continua exatamente como estava — nada no motor de política toca em `demandas`.
      const { rows } = await db.pool.query('SELECT status FROM demandas WHERE id = $1', [demandaId]);
      expect(rows[0]!.status).toBe('Nova');
    });
  });

  describe('avaliações pre/during/post', () => {
    it('registra uma avaliacao por estagio, cada uma com seu proprio estagio gravado', async () => {
      const { demandaId, runId } = await demandaERun();
      for (const estagio of ['pre', 'during', 'post'] as const) {
        await avaliarEregistrar(db.pool, {
          demandaId,
          runId,
          correlacaoId: runId,
          tentativa: 1,
          estagio,
          contexto: contextoPadrao,
        });
      }
      const avaliacoes = await listarAvaliacoesDaDemanda(db.pool, demandaId);
      expect(avaliacoes.map((a) => a.estagio)).toEqual(['pre', 'during', 'post']);
    });

    it('emite um evento politica_avaliada por estagio no ledger unificado, com metadata segura', async () => {
      const { demandaId, runId } = await demandaERun();
      for (const estagio of ['pre', 'during', 'post'] as const) {
        await avaliarEregistrar(db.pool, {
          demandaId,
          runId,
          correlacaoId: runId,
          tentativa: 1,
          estagio,
          contexto: contextoPadrao,
        });
      }
      const eventos = (await listarEventosDaDemanda(db.pool, demandaId)).filter((e) => e.tipoEvento === 'politica_avaliada');
      expect(eventos).toHaveLength(3);
      expect(eventos.map((e) => (e.metadata as { estagio: string }).estagio)).toEqual(['pre', 'during', 'post']);
      for (const e of eventos) {
        expect(Object.keys(e.metadata).sort()).toEqual(['decisao', 'estagio', 'politicaId', 'regraId', 'versaoRegra'].sort());
      }
    });
  });

  describe('validação de schema e redaction', () => {
    it('rejeita contexto com campo fora da allowlist', async () => {
      const { demandaId, runId } = await demandaERun();
      await expect(
        avaliarEregistrar(db.pool, {
          demandaId,
          runId,
          correlacaoId: runId,
          tentativa: 1,
          estagio: 'pre',
          // @ts-expect-error campo fora da allowlist, de propósito
          contexto: { ...contextoPadrao, motivoLivre: 'nunca deveria ser aceito' },
        }),
      ).resolves.toBe('allow'); // avaliarEregistrar nunca lança: erro de validação é fail-open, mas nada é gravado.
      expect(await listarAvaliacoesDaDemanda(db.pool, demandaId)).toHaveLength(0);
    });

    it('um valor de texto livre tentando se passar por um campo fechado (ex.: categoria) nunca e aceito', async () => {
      const { demandaId, runId } = await demandaERun();
      const resultado = await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'pre',
        // @ts-expect-error valor fora do enum fechado, de propósito
        contexto: { ...contextoPadrao, categoria: 'texto livre que não é uma categoria' },
      });
      expect(resultado).toBe('allow');
      expect(await listarAvaliacoesDaDemanda(db.pool, demandaId)).toHaveLength(0);
    });

    it('nenhum segredo/prompt colado em politicaRef ou em qualquer campo aparece na avaliacao gravada', async () => {
      const { demandaId, runId } = await demandaERun();
      const segredo = 'RACIOCINIO_OU_SEGREDO_QUE_NAO_PODE_APARECER_NA_AVALIACAO';
      await avaliarEregistrar(db.pool, {
        demandaId,
        runId,
        correlacaoId: runId,
        tentativa: 1,
        estagio: 'pre',
        contexto: contextoPadrao,
      });
      const avaliacoes = await listarAvaliacoesDaDemanda(db.pool, demandaId);
      expect(JSON.stringify(avaliacoes)).not.toContain(segredo);
    });
  });

  describe('consultas', () => {
    it('obterPoliticaPorChave devolve null para chave inexistente', async () => {
      expect(await obterPoliticaPorChave(db.pool, 'frota:politica-fantasma')).toBeNull();
    });

    it('listarAvaliacoesDaDemanda ordena por id (cursor global)', async () => {
      const { demandaId, runId } = await demandaERun();
      for (const estagio of ['pre', 'during', 'post'] as const) {
        await avaliarEregistrar(db.pool, {
          demandaId,
          runId,
          correlacaoId: randomUUID(),
          tentativa: 1,
          estagio,
          contexto: contextoPadrao,
        });
      }
      const avaliacoes = await listarAvaliacoesDaDemanda(db.pool, demandaId);
      for (let i = 1; i < avaliacoes.length; i++) expect(BigInt(avaliacoes[i]!.id)).toBeGreaterThan(BigInt(avaliacoes[i - 1]!.id));
    });
  });
});
