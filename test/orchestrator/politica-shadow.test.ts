import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { obterAgentePorChave } from '../../src/db/agentes.ts';
import { criarDemanda, obterDemanda, reivindicarDemandas, type Demanda } from '../../src/db/demandas.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import { criarPolitica, criarRegra, listarAvaliacoesDaDemanda } from '../../src/db/politicas.ts';
import { processarDemanda, type DependenciasDemanda } from '../../src/orchestrator/processar-demanda.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, USO_PADRAO } from '../helpers/fakes.ts';

// Só o obterAgentePorChave importado por processar-demanda.ts (a leitura que avaliarEstagio faz antes de
// avaliar a política) é substituído: agenteEstaAutorizado chama a referência interna do próprio módulo,
// então a checagem real do catálogo continua funcionando e a demanda segue o fluxo normal.
vi.mock('../../src/db/agentes.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/agentes.ts')>()),
  obterAgentePorChave: vi.fn(),
}));

const PAPEL_AUDITOR = 'frota:agent-evaluator';
const MODELO = 'claude-sonnet-5';

const execucaoPadrao = {
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
};

describe('Policy Engine em modo shadow dentro do orquestrador', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, aprendizado_evolucao CASCADE');
    vi.mocked(obterAgentePorChave).mockReset();
  });

  const deps = (llm: LlmFalso): DependenciasDemanda => ({
    pool: db.pool,
    llm,
    modeloTrabalho: MODELO,
    modeloAuditoria: MODELO,
    urlBase: 'https://frota.exemplo.com',
  });
  const llmPadrao = () =>
    new LlmFalso((p) => (p.papel === PAPEL_AUDITOR ? { violacoes: [], observacoes: 'sem violações' } : execucaoPadrao), USO_PADRAO);

  // Uma run real: o ledger (agent_events.run_id) tem FK para runs, então um runId inventado geraria
  // avisos de FK que nada têm a ver com o que o teste verifica.
  async function demandaReivindicada(): Promise<{ demanda: Demanda; runId: string }> {
    const runId = await iniciarRun(db.pool);
    await criarDemanda(db.pool, { titulo: 'Painel de estoque', categoria: 'd1' });
    const [demanda] = await reivindicarDemandas(db.pool, runId, 1);
    return { demanda: demanda!, runId };
  }

  it('falha na leitura do agente nunca impede a conclusao da demanda nem a devolve para a fila', async () => {
    vi.mocked(obterAgentePorChave).mockRejectedValue(new Error('banco indisponivel'));
    const { demanda, runId } = await demandaReivindicada();
    const llm = llmPadrao();

    const r = await processarDemanda(deps(llm), demanda, runId);

    expect(r.statusFinal).toBe('Concluída');
    expect(await obterDemanda(db.pool, demanda.id)).toMatchObject({ status: 'Concluída' });
    expect(llm.pedidos.map((p) => p.papel)).toEqual(['frota:architect', PAPEL_AUDITOR]);
    // Nenhuma avaliação gravada: as três (pre, during e post) falharam antes de avaliar, e foram ignoradas.
    expect(await listarAvaliacoesDaDemanda(db.pool, demanda.id)).toHaveLength(0);
  });

  it('agente fora do catalogo e avaliado como "desconhecido": nunca casa com "estado: ativo", e nada bloqueia', async () => {
    vi.mocked(obterAgentePorChave).mockResolvedValue(null);
    const politica = await criarPolitica(db.pool, { chave: `pol-orq-desconhecido-${randomUUID()}`, nome: 'x', descricao: 'x' });
    await criarRegra(db.pool, {
      politicaId: politica.id,
      chave: `regra-deny-ativo-${randomUUID()}`,
      estagio: 'pre',
      decisao: 'deny',
      condicao: { estado: 'ativo', modelo: MODELO },
    });
    await criarRegra(db.pool, {
      politicaId: politica.id,
      chave: `regra-warn-desconhecido-${randomUUID()}`,
      estagio: 'pre',
      decisao: 'warn',
      condicao: { estado: 'desconhecido', modelo: MODELO },
    });
    const { demanda, runId } = await demandaReivindicada();

    const r = await processarDemanda(deps(llmPadrao()), demanda, runId);

    // Shadow: nem o warn nem uma eventual regra de deny mudam o resultado.
    expect(r.statusFinal).toBe('Concluída');
    const avaliacoes = await listarAvaliacoesDaDemanda(db.pool, demanda.id);
    expect(avaliacoes.map((a) => a.estagio)).toEqual(['pre', 'during', 'post']);
    expect(avaliacoes.every((a) => a.contexto.estado === 'desconhecido')).toBe(true);
    // O deny de "estado: ativo" nunca casou; o warn de "estado: desconhecido" casou no pre.
    expect(avaliacoes[0]).toMatchObject({ estagio: 'pre', decisao: 'warn' });
    expect(avaliacoes.some((a) => a.decisao === 'deny')).toBe(false);
  });

  it('auditor fora do catalogo: papel "auditor" (nunca o papel do setor da demanda) e regra de auditoria casa em shadow', async () => {
    vi.mocked(obterAgentePorChave).mockResolvedValue(null);
    const politica = await criarPolitica(db.pool, { chave: `pol-orq-auditor-${randomUUID()}`, nome: 'x', descricao: 'x' });
    const regra = await criarRegra(db.pool, {
      politicaId: politica.id,
      chave: `regra-auditor-desconhecido-${randomUUID()}`,
      estagio: 'during',
      decisao: 'require_approval',
      condicao: { agente: PAPEL_AUDITOR, papel: 'auditor', estado: 'desconhecido', operacao: 'auditoria' },
    });
    const { demanda, runId } = await demandaReivindicada();

    const r = await processarDemanda(deps(llmPadrao()), demanda, runId);

    // Shadow: require_approval é só registrado; a auditoria roda e a demanda conclui.
    expect(r.statusFinal).toBe('Concluída');
    expect(await obterDemanda(db.pool, demanda.id)).toMatchObject({ status: 'Concluída' });
    const avaliacoes = await listarAvaliacoesDaDemanda(db.pool, demanda.id);
    const during = avaliacoes.find((a) => a.estagio === 'during');
    expect(during).toMatchObject({ decisao: 'require_approval', regraId: regra.id });
    expect(during!.contexto).toMatchObject({
      agente: PAPEL_AUDITOR,
      papel: 'auditor',
      estado: 'desconhecido',
      operacao: 'auditoria',
      // A categoria continua sendo a da demanda, também na auditoria.
      categoria: 'd1',
    });
    // Na execução, o papel de fallback continua sendo o do setor da demanda (d1 → executor).
    expect(avaliacoes.find((a) => a.estagio === 'pre')!.contexto.papel).toBe('executor');
  });
});
