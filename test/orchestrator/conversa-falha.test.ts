import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarDemanda, obterDemanda, reivindicarDemandas } from '../../src/db/demandas.ts';
import { listarEventosDaDemanda } from '../../src/db/eventos.ts';
import { listarMensagens } from '../../src/db/mensagens.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import { listarPlanosDaDemanda } from '../../src/db/planos.ts';
import type { ModoOrquestracao } from '../../src/domain/orquestracao.ts';
import { processarDemanda } from '../../src/orchestrator/processar-demanda.ts';
import { processarFila, type DependenciasFila } from '../../src/orchestrator/processar-fila.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, NotificadorMemoria, USO_PADRAO } from '../helpers/fakes.ts';

// Só listarMensagens é envolvido: por padrão chama a função real; cada teste faz UMA leitura falhar. É a
// leitura que conversaDaDemanda (processar-demanda.ts) faz para montar o contexto do planejador e da
// execução. Fica num arquivo próprio para o mock não alcançar os outros testes.
vi.mock('../../src/db/mensagens.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/mensagens.ts')>();
  return { ...original, listarMensagens: vi.fn(original.listarMensagens) };
});

const PAPEL_EXECUTOR = 'frota:architect';
// Simula uma mensagem de erro do driver com detalhes internos: nada disto pode chegar ao ledger.
const TEXTO_BRUTO = 'connection to server at "pg-interno.railway.internal" failed: password=segredo-XYZ-123';

describe('falha isolada na leitura da conversa da demanda', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs, aprendizado_evolucao CASCADE');
    await db.pool.query("UPDATE system_flags SET pausado = false, pausado_motivo = NULL, alertas_enviados = '{}'");
  });

  const novoLlm = () => new LlmFalso(() => new Error('o modelo não deveria ser chamado'), USO_PADRAO);
  const falharProximaLeitura = () => vi.mocked(listarMensagens).mockRejectedValueOnce(new Error(TEXTO_BRUTO));

  describe.each(['desligada', 'planejar'] as const)('modo %s', (modo: ModoOrquestracao) => {
    it('processarDemanda: emite chamada_trabalho_falhou com código fechado, não chama o modelo e relança o mesmo erro', async () => {
      const runId = await iniciarRun(db.pool);
      await criarDemanda(db.pool, { titulo: 'Painel de estoque', categoria: 'd1' });
      const [demanda] = await reivindicarDemandas(db.pool, runId, 1);
      const llm = novoLlm();
      const erro = new Error(TEXTO_BRUTO);
      vi.mocked(listarMensagens).mockRejectedValueOnce(erro);

      await expect(
        processarDemanda(
          { pool: db.pool, llm, modeloTrabalho: 'claude-sonnet-5', modeloAuditoria: 'claude-sonnet-5', urlBase: 'https://frota.minhaempresa.com.br', orquestracao: modo },
          demanda!,
          runId,
        ),
      ).rejects.toBe(erro);

      expect(llm.pedidos).toHaveLength(0);
      const eventos = await listarEventosDaDemanda(db.pool, demanda!.id);
      expect(eventos.map((e) => e.tipoEvento)).toEqual(['processamento_iniciado', 'chamada_trabalho_falhou']);
      expect(eventos[1]).toMatchObject({ ator: PAPEL_EXECUTOR, metadata: { codigoErro: 'falha_inesperada' } });
      expect(JSON.stringify(eventos)).not.toMatch(/railway\.internal|segredo|password/);
      // Nenhum plano: a falha acontece antes do planejamento.
      expect(await listarPlanosDaDemanda(db.pool, demanda!.id)).toEqual([]);
    });

    it('processarFila: o erro continua sendo tratado pela fila como falha da demanda, sem texto bruto', async () => {
      const demanda = await criarDemanda(db.pool, { titulo: 'Painel de estoque', categoria: 'd1' });
      const llm = novoLlm();
      const deps: DependenciasFila = {
        pool: db.pool,
        llm,
        modeloTrabalho: 'claude-sonnet-5',
        modeloAuditoria: 'claude-sonnet-5',
        urlBase: 'https://frota.minhaempresa.com.br',
        orquestracao: modo,
        notificador: new NotificadorMemoria(),
        maxDemandasPorRun: 3,
        minutosAbandono: 60,
      };
      falharProximaLeitura();

      const resumo = await processarFila(deps);

      expect(llm.pedidos).toHaveLength(0);
      expect(resumo.processadas).toEqual([]);
      expect(resumo.falhas).toEqual([{ titulo: 'Painel de estoque', motivo: 'Falha inesperada no processamento.', statusFinal: 'Nova' }]);
      expect(await obterDemanda(db.pool, demanda.id)).toMatchObject({ status: 'Nova', tentativas: 1 });

      const eventos = await listarEventosDaDemanda(db.pool, demanda.id);
      expect(eventos.map((e) => e.tipoEvento)).toEqual([
        'demanda_reivindicada',
        'processamento_iniciado',
        'chamada_trabalho_falhou',
        'demanda_devolvida_para_fila',
      ]);
      expect(eventos[2]).toMatchObject({ ator: PAPEL_EXECUTOR, metadata: { codigoErro: 'falha_inesperada' } });
      expect(eventos[3]!.metadata).toEqual({ motivoDevolucao: 'falha_da_demanda', codigoErro: 'falha_inesperada' });
      expect(JSON.stringify(eventos)).not.toMatch(/railway\.internal|segredo|password/);
    });
  });
});
