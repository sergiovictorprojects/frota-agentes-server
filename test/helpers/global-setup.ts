import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

function livre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('porta indisponivel'))));
    });
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'frota-pg-'));
  const port = await livre();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    // Banco descartável: durabilidade em disco só deixaria os testes e o desligamento mais lentos.
    postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  process.env.TEST_PG_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

  return async () => {
    await pg.stop();
    await rm(dir, { recursive: true, force: true });
  };
}
