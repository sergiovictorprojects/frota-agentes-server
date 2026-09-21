import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { criarDemanda } from '../../src/db/demandas.ts';
import { gastoDoMes, iniciarRun, obterFlags, registrarPasso } from '../../src/db/operacao.ts';
import { LlmError, type PedidoLlm } from '../../src/llm/llm.ts';
import { FrotaPausadaError, LlmComOrcamento, OrcamentoExcedidoError } from '../../src/llm/orcamento.ts';
import { ModeloDesconhecidoError } from '../../src/llm/models.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, NotificadorMemoria } from '../helpers/fakes.ts';

// O banco grava agent_steps.criado_em com o relógio real; o teste usa o mesmo relógio para o mês bater sempre.
const agora = () => new Date();
const schema = z.object({ ok: z.boolean() });
// 1 milhão de tokens de entrada no Sonnet 5 custa exatamente US$ 2.
const USO_2_DOLARES = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const pedido: PedidoLlm<{ ok: boolean }> = {
  modelo: 'claude-sonnet-5',
  papel: 'frota:architect',
  sistema: 's',
  usuario: 'u',
  schema,
  maxTokens: 100,
};

describe('LlmComOrcamento', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE runs, agent_steps, demandas CASCADE');
    await db.pool.query("UPDATE system_flags SET pausado = false, pausado_motivo = NULL, alertas_enviados = '{}'");
  });

  function montar(orcamento: number, responder: () => unknown = () => ({ ok: true })) {
    const notificador = new NotificadorMemoria();
    const interno = new LlmFalso(responder, USO_2_DOLARES);
    const llm = new LlmComOrcamento({ llm: interno, pool: db.pool, orcamentoMensalUsd: orcamento, notificador, agora });
    return { llm, interno, notificador };
  }

  it('registra o passo com custo, papel, modelo e o contexto da demanda e da run', async () => {
    const { llm } = montar(100);
    const demanda = await criarDemanda(db.pool, { titulo: 'x', categoria: 'd1' });
    const runId = await iniciarRun(db.pool);

    await llm.gerar({ ...pedido, contexto: { runId, demandaId: demanda.id } });

    const { rows } = await db.pool.query(
      'SELECT run_id, demanda_id, papel, modelo, tokens_in, custo_usd::float8 AS custo FROM agent_steps',
    );
    expect(rows).toEqual([
      {
        run_id: runId,
        demanda_id: demanda.id,
        papel: 'frota:architect',
        modelo: 'claude-sonnet-5',
        tokens_in: 1_000_000,
        custo: 2,
      },
    ]);
  });

  it('avisa em 50% e 80%, e ao chegar a 100% pausa a frota e notifica como critico', async () => {
    const { llm, interno, notificador } = montar(10);

    for (let i = 0; i < 5; i++) await llm.gerar(pedido);

    expect(notificador.enviadas.map((n) => n.nivel)).toEqual(['aviso', 'aviso', 'critico']);
    expect(notificador.enviadas.map((n) => n.titulo)).toEqual([
      'Orçamento mensal em 50%',
      'Orçamento mensal em 80%',
      'Frota pausada: orçamento mensal atingido',
    ]);
    expect(await gastoDoMes(db.pool, agora())).toBeCloseTo(10, 6);
    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });

    await expect(llm.gerar(pedido)).rejects.toBeInstanceOf(FrotaPausadaError);
    expect(interno.pedidos).toHaveLength(5);
  });

  it('nao avisa enquanto o gasto esta abaixo de 50% e nao repete o alerta em chamadas seguintes', async () => {
    const { llm, notificador } = montar(10);

    await llm.gerar(pedido);
    await llm.gerar(pedido);
    expect(notificador.enviadas).toEqual([]);

    await llm.gerar(pedido);
    expect(notificador.enviadas.map((n) => n.titulo)).toEqual(['Orçamento mensal em 50%']);

    await llm.gerar(pedido);
    expect(notificador.enviadas.map((n) => n.titulo)).toEqual(['Orçamento mensal em 50%', 'Orçamento mensal em 80%']);
  });

  it('bloqueia antes de chamar o modelo quando o gasto ja estourou o orcamento', async () => {
    await registrarPasso(db.pool, {
      runId: null,
      demandaId: null,
      papel: 'x',
      modelo: 'claude-sonnet-5',
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      custoUsd: 10,
      duracaoMs: null,
    });
    const { llm, interno, notificador } = montar(10);

    await expect(llm.gerar(pedido)).rejects.toBeInstanceOf(OrcamentoExcedidoError);

    expect(interno.pedidos).toHaveLength(0);
    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });
    expect(notificador.enviadas).toHaveLength(1);
    expect(notificador.enviadas[0]?.nivel).toBe('critico');
  });

  it('recusa modelo sem preco antes de gastar qualquer coisa', async () => {
    const { llm, interno } = montar(100);
    await expect(llm.gerar({ ...pedido, modelo: 'modelo-inventado' })).rejects.toBeInstanceOf(ModeloDesconhecidoError);
    expect(interno.pedidos).toHaveLength(0);
  });

  it('contabiliza o custo de uma resposta invalida, que tambem consome tokens', async () => {
    const { llm } = montar(100, () => new LlmError('invalido', 'fora do esquema', USO_2_DOLARES));
    await expect(llm.gerar(pedido)).rejects.toBeInstanceOf(LlmError);
    expect(await gastoDoMes(db.pool, agora())).toBeCloseTo(2, 6);
  });

  it('nao contabiliza falha de API sem uso', async () => {
    const { llm } = montar(100, () => new LlmError('api', 'fora do ar', null, 529));
    await expect(llm.gerar(pedido)).rejects.toBeInstanceOf(LlmError);
    expect(await gastoDoMes(db.pool, agora())).toBe(0);
  });

  it('apos retomar com um teto maior no mesmo mes, os avisos do novo teto voltam a valer e a pausa acontece', async () => {
    const primeiro = montar(4);
    await primeiro.llm.gerar(pedido);
    await primeiro.llm.gerar(pedido);
    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });
    await db.pool.query('UPDATE system_flags SET pausado = false, pausado_motivo = NULL');

    const segundo = montar(8);
    await segundo.llm.gerar(pedido);
    await segundo.llm.gerar(pedido);

    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });
    expect(segundo.notificador.enviadas.map((n) => n.titulo)).toEqual([
      'Orçamento mensal em 50%',
      'Orçamento mensal em 80%',
      'Frota pausada: orçamento mensal atingido',
    ]);
  });

  it('pausa a frota ao atingir 100% mesmo que o aviso desse limiar ja tenha sido registrado', async () => {
    const { llm } = montar(2);
    await db.pool.query(
      `UPDATE system_flags SET alertas_enviados = jsonb_build_object($1::text, '[50,80,100]'::jsonb)`,
      [`${new Date().toISOString().slice(0, 7)}@2.00`],
    );

    await llm.gerar(pedido);

    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });
  });

  it('respeita uma pausa manual sem chamar o modelo', async () => {
    await db.pool.query("UPDATE system_flags SET pausado = true, pausado_motivo = 'manutencao'");
    const { llm, interno } = montar(100);
    await expect(llm.gerar(pedido)).rejects.toThrowError(/manutencao/);
    expect(interno.pedidos).toHaveLength(0);
  });

  it('nao deixa uma falha do notificador derrubar a chamada nem esconder a pausa', async () => {
    const notificador = { notificar: async () => Promise.reject(new Error('telegram fora do ar')) };
    const interno = new LlmFalso(() => ({ ok: true }), USO_2_DOLARES);
    const llm = new LlmComOrcamento({ llm: interno, pool: db.pool, orcamentoMensalUsd: 2, notificador, agora });

    await expect(llm.gerar(pedido)).resolves.toMatchObject({ valor: { ok: true } });

    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });
  });
});
