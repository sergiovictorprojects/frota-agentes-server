import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  finalizarRun,
  gastoDoMes,
  iniciarRun,
  mesDe,
  obterFlags,
  pausarFrota,
  registrarAlerta,
  registrarPasso,
  retomarFrota,
  ultimaRun,
} from '../../src/db/operacao.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('operacao', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE runs, agent_steps CASCADE');
    await db.pool.query("UPDATE system_flags SET pausado = false, pausado_motivo = NULL, alertas_enviados = '{}'");
  });

  const passo = (custoUsd: number) => ({
    runId: null,
    demandaId: null,
    papel: 'frota:architect',
    modelo: 'claude-sonnet-5',
    tokensIn: 100,
    tokensOut: 50,
    cacheRead: 0,
    cacheWrite: 0,
    custoUsd,
    duracaoMs: 1200,
  });

  it('registra o ciclo de vida de uma run', async () => {
    expect(await ultimaRun(db.pool)).toBeNull();
    const id = await iniciarRun(db.pool, 'cron');
    expect(await ultimaRun(db.pool)).toMatchObject({ id, status: 'rodando', terminadoEm: null, gatilho: 'cron' });

    await finalizarRun(db.pool, id, { status: 'ok', demandasProcessadas: 2 });

    const fim = await ultimaRun(db.pool);
    expect(fim).toMatchObject({ status: 'ok', demandasProcessadas: 2, erro: null });
    expect(fim?.terminadoEm).not.toBeNull();
  });

  it('trunca erros muito longos ao finalizar a run', async () => {
    const id = await iniciarRun(db.pool, 'manual');
    await finalizarRun(db.pool, id, { status: 'erro', demandasProcessadas: 0, erro: 'e'.repeat(5000) });
    expect((await ultimaRun(db.pool))?.erro).toHaveLength(2000);
  });

  it('soma o gasto so do mes corrente (UTC)', async () => {
    const agora = new Date('2026-09-21T12:00:00Z');
    await registrarPasso(db.pool, passo(1.25));
    await registrarPasso(db.pool, passo(0.75));
    await registrarPasso(db.pool, passo(9));
    await db.pool.query(
      `UPDATE agent_steps SET criado_em = '2026-08-31T23:59:59Z' WHERE custo_usd = 9`,
    );
    await db.pool.query(
      `UPDATE agent_steps SET criado_em = '2026-09-10T10:00:00Z' WHERE custo_usd < 9`,
    );

    expect(await gastoDoMes(db.pool, agora)).toBeCloseTo(2, 6);
    expect(await gastoDoMes(db.pool, new Date('2026-08-15T00:00:00Z'))).toBeCloseTo(9, 6);
    expect(await gastoDoMes(db.pool, new Date('2026-07-01T00:00:00Z'))).toBe(0);
  });

  it('formata o mes como AAAA-MM em UTC', () => {
    expect(mesDe(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09');
    expect(mesDe(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10');
  });

  it('pausa e retoma a frota', async () => {
    expect(await obterFlags(db.pool)).toMatchObject({ pausado: false, pausadoMotivo: null });
    await pausarFrota(db.pool, 'orcamento mensal atingido');
    expect(await obterFlags(db.pool)).toMatchObject({ pausado: true, pausadoMotivo: 'orcamento mensal atingido' });
    await retomarFrota(db.pool);
    expect(await obterFlags(db.pool)).toMatchObject({ pausado: false, pausadoMotivo: null });
  });

  it('registra cada alerta de orcamento uma unica vez por mes e limiar', async () => {
    expect(await registrarAlerta(db.pool, '2026-09', 50)).toBe(true);
    expect(await registrarAlerta(db.pool, '2026-09', 50)).toBe(false);
    expect(await registrarAlerta(db.pool, '2026-09', 80)).toBe(true);
    expect(await registrarAlerta(db.pool, '2026-10', 50)).toBe(true);
    expect((await obterFlags(db.pool)).alertasEnviados).toEqual({ '2026-09': [50, 80], '2026-10': [50] });
  });

  it('nao duplica alertas quando duas execucoes registram o mesmo limiar ao mesmo tempo', async () => {
    const resultados = await Promise.all(Array.from({ length: 5 }, () => registrarAlerta(db.pool, '2026-09', 100)));
    expect(resultados.filter(Boolean)).toHaveLength(1);
  });
});
