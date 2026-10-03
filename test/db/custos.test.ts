import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDemanda } from '../../src/db/demandas.ts';
import { registrarPasso } from '../../src/db/operacao.ts';
import { resumoCustoDaDemanda } from '../../src/db/custos.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('resumoCustoDaDemanda', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs CASCADE');
  });

  it('agrega chamadas, tokens e custo por demanda e por agente', async () => {
    const demanda = await criarDemanda(db.pool, { titulo: 'Custo', categoria: 'd1' });
    const outra = await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd1' });
    await registrarPasso(db.pool, {
      runId: null,
      demandaId: demanda.id,
      papel: 'frota:architect',
      modelo: 'claude-sonnet-5',
      tokensIn: 100,
      tokensOut: 20,
      cacheRead: 10,
      cacheWrite: 5,
      custoUsd: 0.001,
      duracaoMs: 100,
    });
    await registrarPasso(db.pool, {
      runId: null,
      demandaId: demanda.id,
      papel: 'frota:architect',
      modelo: 'claude-sonnet-5',
      tokensIn: 200,
      tokensOut: 30,
      cacheRead: 0,
      cacheWrite: 0,
      custoUsd: 0.002,
      duracaoMs: 200,
    });
    await registrarPasso(db.pool, {
      runId: null,
      demandaId: demanda.id,
      papel: 'frota:agent-evaluator',
      modelo: 'claude-sonnet-5',
      tokensIn: 50,
      tokensOut: 10,
      cacheRead: 0,
      cacheWrite: 0,
      custoUsd: 0.0005,
      duracaoMs: null,
    });
    await registrarPasso(db.pool, {
      runId: null,
      demandaId: outra.id,
      papel: 'frota:architect',
      modelo: 'claude-sonnet-5',
      tokensIn: 999,
      tokensOut: 999,
      cacheRead: 0,
      cacheWrite: 0,
      custoUsd: 9,
      duracaoMs: 999,
    });

    const resumo = await resumoCustoDaDemanda(db.pool, demanda.id);

    expect(resumo).toMatchObject({
      chamadas: 3,
      tokensEntrada: 350,
      tokensSaida: 60,
      tokensCacheRead: 10,
      tokensCacheWrite: 5,
      tokensTotal: 425,
      custoUsd: '0.003500',
    });
    expect(resumo.porPapel).toEqual([
      {
        papel: 'frota:architect',
        chamadas: 2,
        tokensEntrada: 300,
        tokensSaida: 50,
        tokensCacheRead: 10,
        tokensCacheWrite: 5,
        tokensTotal: 365,
        custoUsd: '0.003000',
        duracaoMediaMs: 150,
      },
      {
        papel: 'frota:agent-evaluator',
        chamadas: 1,
        tokensEntrada: 50,
        tokensSaida: 10,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        tokensTotal: 60,
        custoUsd: '0.000500',
        duracaoMediaMs: null,
      },
    ]);
  });
});

