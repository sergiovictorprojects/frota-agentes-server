import type pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

export async function comTransacao<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}
