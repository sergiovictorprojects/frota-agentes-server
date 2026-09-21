import pg from 'pg';
import { log, mensagemDeErro } from '../util/log.ts';

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  // Sem este handler, um erro numa conexão ociosa derruba o processo inteiro.
  pool.on('error', (erro) => log('erro', 'erro_pool', { erro: mensagemDeErro(erro) }));
  return pool;
}
