import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedAgentesPadrao } from '../../src/db/agentes.ts';
import { migrate } from '../../src/db/migrate.ts';

const MODELO_PADRAO_TESTES = 'claude-sonnet-5';

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
  if (opcoes.migrar !== false) {
    await migrate(pool);
    // Espelha o boot real (src/main.ts): sem isto, a checagem de autorização do agente em
    // processarDemanda falharia para toda demanda em todos os testes, já que nenhum agente existiria.
    // Todo fixture de teste usa o mesmo modelo para modeloTrabalho e modeloAuditoria, então um único
    // MODELO_PADRAO_TESTES para os dois parâmetros mantém paridade total com esses fixtures.
    await seedAgentesPadrao(pool, MODELO_PADRAO_TESTES, MODELO_PADRAO_TESTES);
  }

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
