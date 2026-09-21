import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('createPool', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('conecta ao banco e trata erros de conexoes ociosas em vez de derrubar o processo', async () => {
    const pool = createPool(db.url);
    try {
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
