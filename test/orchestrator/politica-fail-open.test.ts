import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarDemanda, obterDemanda, reivindicarDemandas } from '../../src/db/demandas.ts';
import { listarAvaliacoesDaDemanda } from '../../src/db/politicas.ts';
import { processarDemanda } from '../../src/orchestrator/processar-demanda.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, USO_PADRAO } from '../helpers/fakes.ts';

// Só o obterAgentePorChave importado por processar-demanda.ts falha: agenteEstaAutorizado chama a
// referência interna do próprio módulo, então a checagem do catálogo continua funcionando de verdade.
// Isto isola exatamente a leitura que avaliarEstagio faz antes de avaliar a política.
vi.mock('../../src/db/agentes.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/agentes.ts')>()),
  obterAgentePorChave: vi.fn().mockRejectedValue(new Error('banco indisponivel')),
}));

const PAPEL_AUDITOR = 'frota:agent-evaluator';

describe('Policy Engine em modo shadow: falha na leitura do agente', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, aprendizado_evolucao CASCADE');
  });

  it('nunca impede a conclusao da demanda nem a devolve para a fila', async () => {
    await criarDemanda(db.pool, { titulo: 'Painel de estoque', categoria: 'd1' });
    const [demanda] = await reivindicarDemandas(db.pool, randomUUID(), 1);
    const llm = new LlmFalso(
      (p) =>
        p.papel === PAPEL_AUDITOR
          ? { violacoes: [], observacoes: 'sem violações' }
          : {
              plano: 'Entregar análise',
              nivelComplexidade: 2,
              setoresEnvolvidos: ['d1'],
              acaoHumana: null,
              insumoCritico: null,
              entrega: { tipo: 'texto', titulo: 'Análise', conteudo: 'Conteúdo da análise' },
              resumo: 'Análise entregue',
              fontesUtilizadas: 'briefing da demanda',
              autoavaliacao: 90,
              ganhos: 'Entrega utilizável',
              perdas: 'Nada relevante',
              aprendizado: 'Registrar trade-offs',
              ponderacoes: [{ setor: 'd1', nota: 'ok' }],
            },
      USO_PADRAO,
    );

    const r = await processarDemanda(
      { pool: db.pool, llm, modeloTrabalho: 'claude-sonnet-5', modeloAuditoria: 'claude-sonnet-5', urlBase: 'https://frota.exemplo.com' },
      demanda!,
      randomUUID(),
    );

    expect(r.statusFinal).toBe('Concluída');
    expect(await obterDemanda(db.pool, demanda!.id)).toMatchObject({ status: 'Concluída' });
    expect(llm.pedidos.map((p) => p.papel)).toEqual(['frota:architect', PAPEL_AUDITOR]);
    // Nenhuma avaliação gravada: as três (pre, during e post) falharam antes de avaliar, e foram ignoradas.
    expect(await listarAvaliacoesDaDemanda(db.pool, demanda!.id)).toHaveLength(0);
  });
});
