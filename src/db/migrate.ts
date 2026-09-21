import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');
const ADVISORY_LOCK_KEY = 727_001;

// Aplica em ordem alfabética as migrações ainda não registradas. O lock de sessão
// impede que dois processos migrem o mesmo banco ao mesmo tempo.
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const jaAplicadas = new Set(rows.map((r) => r.name));
    const arquivos = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    const aplicadas: string[] = [];
    for (const arquivo of arquivos) {
      if (jaAplicadas.has(arquivo)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, arquivo), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [arquivo]);
        await client.query('COMMIT');
        aplicadas.push(arquivo);
      } catch (erro) {
        await client.query('ROLLBACK');
        throw erro;
      }
    }
    return aplicadas;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export async function listarMigracoesDisponiveis(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}
