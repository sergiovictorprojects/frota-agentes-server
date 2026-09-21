import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.ts';

export interface TestDb {
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(opcoes: { migrar?: boolean } = {}): Promise<TestDb> {
  const adminUrl = process.env.TEST_PG_URL;
  if (!adminUrl) throw new Error('TEST_PG_URL ausente: o global-setup do vitest nao rodou');

  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = adminUrl.replace(/\/[^/]*$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  if (opcoes.migrar !== false) await migrate(pool);

  return {
    pool,
    url,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
