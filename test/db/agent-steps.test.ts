import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registrarPasso } from '../../src/db/operacao.ts';
import { liquidarReserva, reservarCusto, reterReserva, situacaoDeCusto } from '../../src/db/orquestracao.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { contarPassos, demandaComEnvelope, novaDemanda, planoAtivoDeTeste, reivindicarEEnviar } from '../helpers/execucao.ts';

// Migration 006: agent_steps é a fonte do gasto realizado (orquestracao_comprometido_usd e o orçamento mensal),
// então é append-only e só aceita contagens, custo e duração que não sejam negativos. Tudo por SQL direto: o
// ponto é o que o banco recusa, não o que o código deixa de fazer.
describe('agent_steps: append-only e sem valores negativos (migration 006)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  const UPDATE_RECUSADO = 'agent_steps é append-only: UPDATE não é permitido';
  const DELETE_RECUSADO = 'agent_steps é append-only: DELETE não é permitido';

  const uso = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

  // Um passo válido por SQL direto, com o que o teste sobrescrever.
  async function inserirPasso(demandaId: string | null, sobrescrever: Record<string, unknown> = {}): Promise<string> {
    const valores: Record<string, unknown> = {
      demanda_id: demandaId,
      papel: 'frota:architect',
      modelo: 'claude-sonnet-5',
      tokens_in: 100,
      tokens_out: 50,
      cache_read: 0,
      cache_write: 0,
      custo_usd: '0.500000',
      duracao_ms: 1200,
      ...sobrescrever,
    };
    const colunas = Object.keys(valores);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_steps (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(valores),
    );
    return rows[0]!.id;
  }

  const linha = async (id: string) => (await db.pool.query('SELECT * FROM agent_steps WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

  // Reserva de planejamento (sem tarefa) liquidada pelo repositório: o passo fica ligado a ela.
  async function passoLigado(demandaId: string, runId: string): Promise<{ reservaId: string; agentStepId: string }> {
    const r = await reservarCusto(db.pool, {
      demandaId,
      operacao: 'planejamento',
      modelo: 'claude-sonnet-5',
      valorReservadoUsd: '0.10',
      validadeSegundos: 600,
      agenteChave: 'frota:gestores',
    });
    if (!r.reservada) throw new Error(`reserva de teste recusada: ${r.motivo}`);
    const l = await liquidarReserva(db.pool, {
      reservaId: r.reservaId,
      passo: { runId, papel: 'frota:gestores', uso: uso(10_000, 1_000), duracaoMs: 5 },
    });
    return { reservaId: r.reservaId, agentStepId: l.agentStepId };
  }

  it('recusa custo, contagens e duracao negativos e custo NaN; aceita zero e duracao nula', async () => {
    const d = await novaDemanda(db.pool);
    const recusados: [string, unknown][] = [
      ['tokens_in', -1],
      ['tokens_out', -1],
      ['cache_read', -1],
      ['cache_write', -1],
      ['custo_usd', '-0.000001'],
      ['custo_usd', 'NaN'],
      ['duracao_ms', -1],
    ];
    for (const [coluna, valor] of recusados) {
      await expect(inserirPasso(d.demandaId, { [coluna]: valor }), `${coluna} = ${String(valor)}`).rejects.toThrow(
        `violates check constraint "agent_steps_${coluna}_check"`,
      );
    }
    // Infinito nem chega ao CHECK: numeric(12,6) não guarda valor infinito.
    await expect(inserirPasso(d.demandaId, { custo_usd: 'Infinity' })).rejects.toThrow('numeric field overflow');
    // O caminho do código também: registrarPasso não grava custo negativo.
    await expect(
      registrarPasso(db.pool, {
        runId: null,
        demandaId: d.demandaId,
        papel: 'frota:architect',
        modelo: 'claude-sonnet-5',
        tokensIn: 1,
        tokensOut: 1,
        cacheRead: 0,
        cacheWrite: 0,
        custoUsd: -0.5,
        duracaoMs: 10,
      }),
    ).rejects.toThrow('agent_steps_custo_usd_check');
    expect(await contarPassos(db.pool, d.demandaId)).toBe(0);

    const zero = await inserirPasso(d.demandaId, { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, custo_usd: 0, duracao_ms: null });
    expect(await linha(zero)).toMatchObject({ tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, custo_usd: '0.000000', duracao_ms: null });
  });

  it('UPDATE de qualquer coluna e recusado, com qualquer valor, ate o mesmo', async () => {
    const p = await planoAtivoDeTeste(db.pool);
    const { tarefa, reservaId } = await reivindicarEEnviar(db.pool, p.planoId);
    const daTarefa = await liquidarReserva(db.pool, {
      reservaId,
      passo: { runId: p.runId, papel: tarefa.agente.chave, uso: uso(1_000, 100), duracaoMs: 10 },
    });
    const legado = await inserirPasso(p.demandaId, { run_id: p.runId });
    const outra = await novaDemanda(db.pool);

    const { rows } = await db.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_steps' ORDER BY ordinal_position",
    );
    const colunas = rows.map((l) => l.column_name);
    expect(colunas).toEqual([
      'id',
      'run_id',
      'demanda_id',
      'papel',
      'modelo',
      'tokens_in',
      'tokens_out',
      'cache_read',
      'cache_write',
      'custo_usd',
      'duracao_ms',
      'criado_em',
      'plano_id',
      'tarefa_id',
      'operacao',
    ]);

    const mudancas = [
      'custo_usd = 0',
      'tokens_in = 0',
      'tokens_out = 0',
      'demanda_id = NULL',
      `demanda_id = '${outra.demandaId}'`,
      "modelo = 'claude-haiku-4-5'",
      'plano_id = NULL',
      'tarefa_id = NULL',
      "operacao = 'auditoria'",
      'run_id = NULL',
      "papel = 'frota:gestores'",
      'duracao_ms = NULL',
      "criado_em = now() - interval '40 days'",
      `id = '${randomUUID()}'`,
    ];
    for (const id of [daTarefa.agentStepId, legado]) {
      const antes = await linha(id);
      for (const coluna of colunas) {
        await expect(db.pool.query(`UPDATE agent_steps SET ${coluna} = ${coluna} WHERE id = $1`, [id]), coluna).rejects.toThrow(UPDATE_RECUSADO);
      }
      for (const set of mudancas) {
        await expect(db.pool.query(`UPDATE agent_steps SET ${set} WHERE id = $1`, [id]), set).rejects.toThrow(UPDATE_RECUSADO);
      }
      expect(await linha(id)).toEqual(antes);
    }
    expect(await linha(daTarefa.agentStepId)).toMatchObject({ plano_id: p.planoId, tarefa_id: tarefa.id, operacao: 'execucao' });
  });

  it('DELETE e recusado, ligado ou nao a uma reserva; apagar a run ou a demanda de um passo tambem', async () => {
    const d = await demandaComEnvelope(db.pool);
    const solto = await inserirPasso(d.demandaId, { run_id: d.runId });
    const { agentStepId: ligado } = await passoLigado(d.demandaId, d.runId);

    await expect(db.pool.query('DELETE FROM agent_steps WHERE id = $1', [solto])).rejects.toThrow(DELETE_RECUSADO);
    await expect(db.pool.query('DELETE FROM agent_steps WHERE id = $1', [ligado])).rejects.toThrow(DELETE_RECUSADO);
    await expect(db.pool.query('DELETE FROM agent_steps WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(DELETE_RECUSADO);
    expect(await contarPassos(db.pool, d.demandaId)).toBe(2);

    // O ON DELETE SET NULL de run_id e demanda_id (001) seria um UPDATE no passo: o banco recusa apagar a run ou
    // a demanda, e o passo fica como estava.
    await expect(db.pool.query('DELETE FROM runs WHERE id = $1', [d.runId])).rejects.toThrow(UPDATE_RECUSADO);
    const { rows } = await db.pool.query<{ id: string }>("INSERT INTO demandas (titulo, categoria) VALUES ('Com passo', 'd1') RETURNING id");
    const comPasso = rows[0]!.id;
    const passoDaDemanda = await inserirPasso(comPasso);
    await expect(db.pool.query('DELETE FROM demandas WHERE id = $1', [comPasso])).rejects.toThrow(UPDATE_RECUSADO);
    expect(await linha(passoDaDemanda)).toMatchObject({ demanda_id: comPasso });
    expect(await linha(solto)).toMatchObject({ run_id: d.runId, demanda_id: d.demandaId });
  });

  it('TRUNCATE ... CASCADE, usado na limpeza dos testes, continua funcionando', async () => {
    const d = await demandaComEnvelope(db.pool);
    await passoLigado(d.demandaId, d.runId);
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('TRUNCATE agent_steps CASCADE');
      const { rows } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_steps');
      expect(rows[0]!.n).toBe(0);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await contarPassos(db.pool, d.demandaId)).toBe(1);
  });

  it('um passo ligado a uma reserva, liquidada ou tardia, continua o mesmo e liquidar de novo devolve ele', async () => {
    const d = await demandaComEnvelope(db.pool);
    const passo = { runId: d.runId, papel: 'frota:gestores', uso: uso(10_000, 1_000), duracaoMs: 5 };
    const { reservaId, agentStepId } = await passoLigado(d.demandaId, d.runId);

    const r = await reservarCusto(db.pool, {
      demandaId: d.demandaId,
      operacao: 'planejamento',
      modelo: 'claude-sonnet-5',
      valorReservadoUsd: '0.10',
      validadeSegundos: 600,
      agenteChave: 'frota:gestores',
    });
    if (!r.reservada) throw new Error('reserva de teste recusada');
    await reterReserva(db.pool, r.reservaId);
    const tardio = await liquidarReserva(db.pool, { reservaId: r.reservaId, passo });
    expect(tardio).toMatchObject({ liquidada: false, estadoReserva: 'retida' });

    for (const [id, stepId] of [
      [reservaId, agentStepId],
      [r.reservaId, tardio.agentStepId],
    ] as const) {
      const antes = await linha(stepId);
      await expect(db.pool.query('UPDATE agent_steps SET custo_usd = 0 WHERE id = $1', [stepId])).rejects.toThrow(UPDATE_RECUSADO);
      await expect(db.pool.query('UPDATE agent_steps SET demanda_id = NULL WHERE id = $1', [stepId])).rejects.toThrow(UPDATE_RECUSADO);
      await expect(db.pool.query('DELETE FROM agent_steps WHERE id = $1', [stepId])).rejects.toThrow(DELETE_RECUSADO);
      expect(await linha(stepId)).toEqual(antes);
      const { rows } = await db.pool.query<{ agent_step_id: string; custo: string }>(
        'SELECT r.agent_step_id, s.custo_usd::text AS custo FROM reservas_custo r JOIN agent_steps s ON s.id = r.agent_step_id WHERE r.id = $1',
        [id],
      );
      expect(rows[0]).toEqual({ agent_step_id: stepId, custo: '0.030000' });
      expect(await liquidarReserva(db.pool, { reservaId: id, passo })).toMatchObject({ agentStepId: stepId, custoRealUsd: '0.030000' });
    }
    expect(await contarPassos(db.pool, d.demandaId)).toBe(2);
  });

  it('nao da para reduzir o comprometido da demanda: nem passo negativo ou NaN, nem alterar ou apagar um passo', async () => {
    const d = await demandaComEnvelope(db.pool);
    const outra = await novaDemanda(db.pool);
    await inserirPasso(d.demandaId, { custo_usd: '0.500000' });
    await passoLigado(d.demandaId, d.runId);
    const comprometido = async () =>
      (await db.pool.query<{ c: string }>('SELECT orquestracao_comprometido_usd($1)::text AS c', [d.demandaId])).rows[0]!.c;
    const antes = await situacaoDeCusto(db.pool, d.demandaId);
    expect(antes).toEqual({ limiteUsd: '2.00', comprometidoUsd: '0.530000', disponivelUsd: '1.470000' });
    expect(await comprometido()).toBe('0.530000');

    await expect(inserirPasso(d.demandaId, { custo_usd: '-0.530000' })).rejects.toThrow('agent_steps_custo_usd_check');
    await expect(inserirPasso(d.demandaId, { custo_usd: 'NaN' })).rejects.toThrow('agent_steps_custo_usd_check');
    for (const [sql, params] of [
      ['UPDATE agent_steps SET custo_usd = 0 WHERE demanda_id = $1', [d.demandaId]],
      ['UPDATE agent_steps SET custo_usd = custo_usd / 100 WHERE demanda_id = $1', [d.demandaId]],
      ['UPDATE agent_steps SET demanda_id = NULL WHERE demanda_id = $1', [d.demandaId]],
      ['UPDATE agent_steps SET demanda_id = $2 WHERE demanda_id = $1', [d.demandaId, outra.demandaId]],
    ] as const) {
      await expect(db.pool.query(sql, [...params]), sql).rejects.toThrow(UPDATE_RECUSADO);
    }
    await expect(db.pool.query('DELETE FROM agent_steps WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(DELETE_RECUSADO);

    expect(await situacaoDeCusto(db.pool, d.demandaId)).toEqual(antes);
    expect(await comprometido()).toBe('0.530000');
    // A reserva continua limitada pelo que sobra: 1,47 cabe, um centavo a mais não.
    const reserva = (valorReservadoUsd: string) =>
      reservarCusto(db.pool, {
        demandaId: d.demandaId,
        operacao: 'auditoria',
        modelo: 'claude-sonnet-5',
        valorReservadoUsd,
        validadeSegundos: 600,
        agenteChave: 'frota:gestores',
      });
    expect(await reserva('1.480000')).toMatchObject({ reservada: false, motivo: 'custo_demanda_excedido' });
    expect(await reserva('1.470000')).toMatchObject({ reservada: true });
  });

  it('passo com plano: da mesma demanda do plano, com operacao, e tarefa so com o plano dela', async () => {
    const p = await planoAtivoDeTeste(db.pool);
    const outra = await novaDemanda(db.pool);
    await expect(inserirPasso(outra.demandaId, { plano_id: p.planoId, operacao: 'planejamento' })).rejects.toThrow(
      'agent_steps: o plano precisa ser da mesma demanda do passo',
    );
    await expect(inserirPasso(p.demandaId, { plano_id: p.planoId })).rejects.toThrow('agent_steps_plano_operacao_check');
    await expect(inserirPasso(p.demandaId, { tarefa_id: p.ids.analise })).rejects.toThrow('agent_steps_tarefa_check');
    await expect(inserirPasso(p.demandaId, { plano_id: p.planoId, tarefa_id: randomUUID(), operacao: 'execucao' })).rejects.toThrow(
      'agent_steps_tarefa_plano_fkey',
    );
    const certo = await inserirPasso(p.demandaId, { plano_id: p.planoId, tarefa_id: p.ids.analise, operacao: 'execucao' });
    expect(await linha(certo)).toMatchObject({ plano_id: p.planoId, tarefa_id: p.ids.analise, operacao: 'execucao' });
  });
});
