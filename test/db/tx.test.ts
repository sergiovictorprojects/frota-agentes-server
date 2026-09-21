import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDemanda, listarDemandas } from '../../src/db/demandas.ts';
import { comTransacao } from '../../src/db/tx.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('comTransacao', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas CASCADE');
  });

  it('confirma as escritas e devolve o resultado da funcao', async () => {
    const titulo = await comTransacao(db.pool, async (c) => {
      const d = await criarDemanda(c, { titulo: 'Dentro da transacao', categoria: 'd1' });
      return d.titulo;
    });

    expect(titulo).toBe('Dentro da transacao');
    expect(await listarDemandas(db.pool)).toHaveLength(1);
  });

  it('desfaz tudo e repassa o erro quando a funcao falha', async () => {
    await expect(
      comTransacao(db.pool, async (c) => {
        await criarDemanda(c, { titulo: 'Sera desfeita', categoria: 'd1' });
        throw new Error('falha no meio');
      }),
    ).rejects.toThrow('falha no meio');

    expect(await listarDemandas(db.pool)).toHaveLength(0);
  });

  it('devolve a conexao ao pool mesmo depois de uma falha', async () => {
    for (let i = 0; i < 15; i++) {
      await comTransacao(db.pool, async () => {
        throw new Error('falha');
      }).catch(() => undefined);
    }
    const { rows } = await db.pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
  });
});
