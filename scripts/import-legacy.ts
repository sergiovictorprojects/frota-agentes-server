import { readFile } from 'node:fs/promises';
import { migrate } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import { importarLegado } from '../src/legacy/importar.ts';

const [caminho] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!caminho || !url) {
  console.error('Uso: DATABASE_URL=postgres://… npm run import:legacy -- <arquivo.json>');
  process.exit(2);
}

const pool = createPool(url);
try {
  await migrate(pool);
  const bruto: unknown = JSON.parse(await readFile(caminho, 'utf8'));
  console.log(JSON.stringify(await importarLegado(pool, bruto), null, 2));
} finally {
  await pool.end();
}
