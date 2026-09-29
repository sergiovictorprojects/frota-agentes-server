import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atualizarAgente } from '../../src/db/agentes.ts';
import { criarDemanda, obterDemanda, reivindicarDemandas, type Demanda } from '../../src/db/demandas.ts';
import { listarEventosDaDemanda } from '../../src/db/eventos.ts';
import { listarMensagens } from '../../src/db/mensagens.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import { listarPlanosDaDemanda } from '../../src/db/planos.ts';
import { listarAvaliacoesDaDemanda } from '../../src/db/politicas.ts';
import type { ModoOrquestracao } from '../../src/domain/orquestracao.ts';
import { LlmError } from '../../src/llm/llm.ts';
import { PAPEL_COORDENADOR } from '../../src/orchestrator/planejamento.ts';
import { processarDemanda, type DependenciasDemanda } from '../../src/orchestrator/processar-demanda.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, USO_PADRAO } from '../helpers/fakes.ts';

const PAPEL_AUDITOR = 'frota:agent-evaluator';
const PAPEL_EXECUTOR = 'frota:architect';
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
const auditoriaLimpa = { violacoes: [], observacoes: 'sem violações' };
const planoValido = {
  tarefas: [
    { chave: 'levantar-dados', capacidade: 'd1', dependeDe: [] },
    { chave: 'revisar-seguranca', capacidade: 'd3', dependeDe: ['levantar-dados'] },
  ],
};

describe('Fase 3.1: planejamento em shadow dentro do orquestrador', () => {
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

  // O coordenador responde com `plano` (ou lança, se for um Error); os outros papéis, como sempre.
  const llmCom = (plano: unknown) =>
    new LlmFalso((p) => {
      if (p.papel === PAPEL_COORDENADOR) return plano;
      return p.papel === PAPEL_AUDITOR ? auditoriaLimpa : execucaoPadrao;
    }, USO_PADRAO);
  const deps = (llm: LlmFalso, orquestracao?: ModoOrquestracao): DependenciasDemanda => ({
    pool: db.pool,
    llm,
    modeloTrabalho: MODELO,
    modeloAuditoria: MODELO,
    urlBase: 'https://frota.minhaempresa.com.br',
    ...(orquestracao ? { orquestracao } : {}),
  });
  async function demandaReivindicada(): Promise<{ demanda: Demanda; runId: string }> {
    const runId = await iniciarRun(db.pool);
    await criarDemanda(db.pool, { titulo: 'Painel de estoque', categoria: 'd1', descricao: 'Montar um painel' });
    const [demanda] = await reivindicarDemandas(db.pool, runId, 1);
    return { demanda: demanda!, runId };
  }
  const tiposDeEvento = async (demandaId: string) => (await listarEventosDaDemanda(db.pool, demandaId)).map((e) => e.tipoEvento);

  it.each([undefined, 'desligada'] as const)('modo %s: nenhuma chamada ao coordenador e nenhum plano', async (modo) => {
    const { demanda, runId } = await demandaReivindicada();
    const llm = llmCom(planoValido);

    const r = await processarDemanda(deps(llm, modo), demanda, runId);

    expect(r.statusFinal).toBe('Concluída');
    expect(llm.pedidos.map((p) => p.papel)).toEqual([PAPEL_EXECUTOR, PAPEL_AUDITOR]);
    expect(await listarPlanosDaDemanda(db.pool, demanda.id)).toEqual([]);
    const tipos = await tiposDeEvento(demanda.id);
    expect(tipos.filter((t) => t.startsWith('plano') || t === 'planejamento_falhou')).toEqual([]);
  });

  it('planejar: grava o plano shadow com a integração e segue pelo fluxo legado com o mesmo resultado', async () => {
    const { demanda, runId } = await demandaReivindicada();
    const llm = llmCom(planoValido);

    const r = await processarDemanda(deps(llm, 'planejar'), demanda, runId);

    expect(r.statusFinal).toBe('Concluída');
    expect(await obterDemanda(db.pool, demanda.id)).toMatchObject({ status: 'Concluída', claimedByRun: null });
    expect(llm.pedidos.map((p) => p.papel)).toEqual([PAPEL_COORDENADOR, PAPEL_EXECUTOR, PAPEL_AUDITOR]);

    const planos = await listarPlanosDaDemanda(db.pool, demanda.id);
    expect(planos).toHaveLength(1);
    expect(planos[0]).toMatchObject({ versao: 1, modo: 'shadow', estado: 'registrado', motivoRejeicao: null, criadoPelaRunId: runId });
    expect(planos[0]!.tarefas).toEqual([
      { chave: 'levantar-dados', tipo: 'especialista', capacidade: 'd1', estado: 'pendente', dependeDe: [] },
      { chave: 'revisar-seguranca', tipo: 'especialista', capacidade: 'd3', estado: 'pendente', dependeDe: ['levantar-dados'] },
      {
        chave: 'integracao',
        tipo: 'integracao',
        capacidade: 'gestores',
        estado: 'pendente',
        dependeDe: ['levantar-dados', 'revisar-seguranca'],
      },
    ]);

    const eventos = await listarEventosDaDemanda(db.pool, demanda.id);
    const registrado = eventos.find((e) => e.tipoEvento === 'plano_registrado');
    expect(registrado).toBeDefined();
    expect(registrado!.ator).toBe(PAPEL_COORDENADOR);
    // Só ids e contagens: nenhuma chave de tarefa (texto vindo do modelo) entra no ledger.
    expect(Object.keys(registrado!.metadata).sort()).toEqual(['modo', 'planoId', 'totalDependencias', 'totalTarefas', 'versao']);
    expect(registrado!.metadata).toMatchObject({ planoId: planos[0]!.id, versao: 1, modo: 'shadow', totalTarefas: 3, totalDependencias: 3 });
    expect(JSON.stringify(registrado)).not.toContain('levantar-dados');

    // O planejamento vem depois de processamento_iniciado e antes da execução legada.
    const tipos = eventos.map((e) => e.tipoEvento);
    expect(tipos.indexOf('processamento_iniciado')).toBeLessThan(tipos.indexOf('plano_registrado'));

    // Nenhuma mensagem nova na conversa: o plano não aparece para o solicitante nesta entrega.
    const mensagens = await listarMensagens(db.pool, demanda.id);
    expect(mensagens.some((m) => m.agente === PAPEL_COORDENADOR)).toBe(false);
  });

  it('planejar: avalia política pre/during/post do planejamento com operacao própria, sem colidir com a execução', async () => {
    const { demanda, runId } = await demandaReivindicada();

    await processarDemanda(deps(llmCom(planoValido), 'planejar'), demanda, runId);

    const avaliacoes = await listarAvaliacoesDaDemanda(db.pool, demanda.id);
    expect(avaliacoes).toHaveLength(6);
    const planejamento = avaliacoes.filter((a) => a.contexto.operacao === 'planejamento');
    expect(planejamento.map((a) => a.estagio)).toEqual(['pre', 'during', 'post']);
    for (const a of planejamento) {
      expect(a.contexto).toMatchObject({ agente: PAPEL_COORDENADOR, papel: 'coordenador', categoria: 'd1', estado: 'ativo' });
      expect(a.decisao).toBe('allow');
    }

    const eventos = (await listarEventosDaDemanda(db.pool, demanda.id)).filter((e) => e.tipoEvento === 'politica_avaliada');
    expect(eventos).toHaveLength(6);
    expect(eventos.filter((e) => e.metadata['operacao'] === 'planejamento').map((e) => e.metadata['estagio'])).toEqual([
      'pre',
      'during',
      'post',
    ]);
    expect(new Set(eventos.map((e) => e.chaveIdempotencia)).size).toBe(6);
  });

  it.each([
    [
      'ciclo',
      {
        tarefas: [
          { chave: 'a', capacidade: 'd1', dependeDe: ['b'] },
          { chave: 'b', capacidade: 'd2', dependeDe: ['a'] },
        ],
      },
    ],
    [
      'limite_tarefas',
      {
        tarefas: ['a', 'b', 'c', 'd'].map((chave) => ({ chave, capacidade: 'd1', dependeDe: [] })),
      },
    ],
  ] as const)('plano inválido (%s) é gravado como rejeitado e a demanda conclui normalmente', async (motivo, plano) => {
    const { demanda, runId } = await demandaReivindicada();

    const r = await processarDemanda(deps(llmCom(plano), 'planejar'), demanda, runId);

    expect(r.statusFinal).toBe('Concluída');
    const planos = await listarPlanosDaDemanda(db.pool, demanda.id);
    expect(planos).toHaveLength(1);
    expect(planos[0]).toMatchObject({ estado: 'rejeitado', motivoRejeicao: motivo, tarefas: [] });
    const rejeitado = (await listarEventosDaDemanda(db.pool, demanda.id)).find((e) => e.tipoEvento === 'plano_rejeitado');
    expect(rejeitado?.metadata).toEqual({ planoId: planos[0]!.id, versao: 1, motivoRejeicao: motivo });
  });

  it('falha da API no planejamento vira planejamento_falhou e a demanda conclui pelo fluxo legado', async () => {
    const { demanda, runId } = await demandaReivindicada();
    const llm = llmCom(new LlmError('api', 'indisponível', USO_PADRAO));

    const r = await processarDemanda(deps(llm, 'planejar'), demanda, runId);

    expect(r.statusFinal).toBe('Concluída');
    expect(llm.pedidos.map((p) => p.papel)).toEqual([PAPEL_COORDENADOR, PAPEL_EXECUTOR, PAPEL_AUDITOR]);
    expect(await listarPlanosDaDemanda(db.pool, demanda.id)).toEqual([]);
    const falhou = (await listarEventosDaDemanda(db.pool, demanda.id)).find((e) => e.tipoEvento === 'planejamento_falhou');
    expect(falhou?.metadata).toEqual({ codigoErro: 'llm_api' });
  });

  it('coordenador suspenso: não chama o modelo para planejar, registra agente_nao_autorizado e segue', async () => {
    await atualizarAgente(db.pool, PAPEL_COORDENADOR, 'teste:planejamento', { estado: 'suspenso' });
    try {
      const { demanda, runId } = await demandaReivindicada();
      const llm = llmCom(planoValido);

      const r = await processarDemanda(deps(llm, 'planejar'), demanda, runId);

      expect(r.statusFinal).toBe('Concluída');
      expect(llm.pedidos.map((p) => p.papel)).toEqual([PAPEL_EXECUTOR, PAPEL_AUDITOR]);
      expect(await listarPlanosDaDemanda(db.pool, demanda.id)).toEqual([]);
      const falhou = (await listarEventosDaDemanda(db.pool, demanda.id)).find((e) => e.tipoEvento === 'planejamento_falhou');
      expect(falhou?.metadata).toEqual({ codigoErro: 'agente_nao_autorizado' });
      // Só o "pre" do planejamento chegou a ser avaliado, com o estado real do agente.
      const planejamento = (await listarAvaliacoesDaDemanda(db.pool, demanda.id)).filter(
        (a) => a.contexto.operacao === 'planejamento',
      );
      expect(planejamento.map((a) => [a.estagio, a.contexto.estado])).toEqual([['pre', 'suspenso']]);
    } finally {
      await atualizarAgente(db.pool, PAPEL_COORDENADOR, 'teste:planejamento', { estado: 'ativo' });
    }
  });

  it('o prompt do planejador mantém a demanda dentro das tags de dados, nunca no prompt de sistema', async () => {
    const { demanda, runId } = await demandaReivindicada();
    const llm = llmCom(planoValido);

    await processarDemanda(deps(llm, 'planejar'), demanda, runId);

    const pedido = llm.pedidos.find((p) => p.papel === PAPEL_COORDENADOR)!;
    expect(pedido.usuario).toMatch(/^<demanda>[\s\S]*Montar um painel[\s\S]*<\/demanda>/);
    expect(pedido.sistema).not.toContain('Montar um painel');
    expect(pedido.sistema).not.toContain('Painel de estoque');
    expect(pedido.modelo).toBe(MODELO);
  });

  it('um segundo planejamento da mesma demanda vira a versão 2, sem sobrescrever a primeira', async () => {
    const { demanda, runId } = await demandaReivindicada();
    await processarDemanda(deps(llmCom(planoValido), 'planejar'), demanda, runId);
    await db.pool.query("UPDATE demandas SET status = 'Nova' WHERE id = $1", [demanda.id]);
    const runId2 = await iniciarRun(db.pool);
    const [denovo] = await reivindicarDemandas(db.pool, runId2, 1);

    await processarDemanda(deps(llmCom(planoValido), 'planejar'), denovo!, runId2);

    const planos = await listarPlanosDaDemanda(db.pool, demanda.id);
    expect(planos.map((p) => [p.versao, p.estado, p.criadoPelaRunId])).toEqual([
      [1, 'registrado', runId],
      [2, 'registrado', runId2],
    ]);
  });
});
