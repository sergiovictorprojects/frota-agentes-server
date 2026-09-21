import type { Db } from './tx.ts';

export type StatusRun = 'rodando' | 'ok' | 'erro' | 'pausada';

export interface Run {
  id: string;
  iniciadoEm: string;
  terminadoEm: string | null;
  gatilho: 'cron' | 'manual';
  demandasProcessadas: number;
  status: StatusRun;
  erro: string | null;
}

interface LinhaRun {
  id: string;
  iniciado_em: Date;
  terminado_em: Date | null;
  gatilho: 'cron' | 'manual';
  demandas_processadas: number;
  status: StatusRun;
  erro: string | null;
}

const LIMITE_ERRO = 2000;

export async function iniciarRun(db: Db, gatilho: 'cron' | 'manual' = 'cron'): Promise<string> {
  const { rows } = await db.query<{ id: string }>('INSERT INTO runs (gatilho) VALUES ($1) RETURNING id', [gatilho]);
  return rows[0]!.id;
}

export async function finalizarRun(
  db: Db,
  id: string,
  r: { status: Exclude<StatusRun, 'rodando'>; demandasProcessadas: number; erro?: string | null },
): Promise<void> {
  await db.query(
    'UPDATE runs SET terminado_em = now(), status = $2, demandas_processadas = $3, erro = $4 WHERE id = $1',
    [id, r.status, r.demandasProcessadas, r.erro ? r.erro.slice(0, LIMITE_ERRO) : null],
  );
}

export async function ultimaRun(db: Db): Promise<Run | null> {
  const { rows } = await db.query<LinhaRun>(
    `SELECT id, iniciado_em, terminado_em, gatilho, demandas_processadas, status, erro
       FROM runs ORDER BY iniciado_em DESC LIMIT 1`,
  );
  const l = rows[0];
  if (!l) return null;
  return {
    id: l.id,
    iniciadoEm: l.iniciado_em.toISOString(),
    terminadoEm: l.terminado_em ? l.terminado_em.toISOString() : null,
    gatilho: l.gatilho,
    demandasProcessadas: l.demandas_processadas,
    status: l.status,
    erro: l.erro,
  };
}

export interface NovoPasso {
  runId: string | null;
  demandaId: string | null;
  papel: string;
  modelo: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  custoUsd: number;
  duracaoMs: number | null;
}

export async function registrarPasso(db: Db, p: NovoPasso): Promise<void> {
  await db.query(
    `INSERT INTO agent_steps (run_id, demanda_id, papel, modelo, tokens_in, tokens_out, cache_read, cache_write,
       custo_usd, duracao_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [p.runId, p.demandaId, p.papel, p.modelo, p.tokensIn, p.tokensOut, p.cacheRead, p.cacheWrite, p.custoUsd, p.duracaoMs],
  );
}

export function mesDe(agora: Date): string {
  return agora.toISOString().slice(0, 7);
}

// O mês de cobrança da Anthropic é o mês civil em UTC.
export async function gastoDoMes(db: Db, agora: Date = new Date()): Promise<number> {
  const inicio = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
  const fim = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 1));
  const { rows } = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(custo_usd), 0)::float8 AS total FROM agent_steps WHERE criado_em >= $1 AND criado_em < $2',
    [inicio, fim],
  );
  return rows[0]?.total ?? 0;
}

export interface Flags {
  pausado: boolean;
  pausadoMotivo: string | null;
  alertasEnviados: Record<string, number[]>;
}

export async function obterFlags(db: Db): Promise<Flags> {
  const { rows } = await db.query<{
    pausado: boolean;
    pausado_motivo: string | null;
    alertas_enviados: Record<string, number[]>;
  }>('SELECT pausado, pausado_motivo, alertas_enviados FROM system_flags WHERE id = 1');
  const l = rows[0]!;
  return { pausado: l.pausado, pausadoMotivo: l.pausado_motivo, alertasEnviados: l.alertas_enviados };
}

export async function pausarFrota(db: Db, motivo: string): Promise<void> {
  await db.query('UPDATE system_flags SET pausado = true, pausado_motivo = $1, atualizado_em = now() WHERE id = 1', [
    motivo.slice(0, 500),
  ]);
}

export async function retomarFrota(db: Db): Promise<void> {
  await db.query('UPDATE system_flags SET pausado = false, pausado_motivo = NULL, atualizado_em = now() WHERE id = 1');
}

// Devolve true só na primeira vez que o limiar é registrado no mês: evita alertas repetidos.
export async function registrarAlerta(db: Db, mes: string, limiar: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE system_flags
        SET alertas_enviados = jsonb_set(
              alertas_enviados, ARRAY[$1::text],
              COALESCE(alertas_enviados -> $1::text, '[]'::jsonb) || to_jsonb($2::int)),
            atualizado_em = now()
      WHERE id = 1 AND NOT (COALESCE(alertas_enviados -> $1::text, '[]'::jsonb) @> to_jsonb($2::int))`,
    [mes, limiar],
  );
  return rowCount === 1;
}
