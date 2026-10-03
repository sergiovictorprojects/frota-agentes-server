import type { Db } from './tx.ts';

export interface CustoPorPapel {
  papel: string;
  chamadas: number;
  tokensEntrada: number;
  tokensSaida: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensTotal: number;
  custoUsd: string;
  duracaoMediaMs: number | null;
}

export interface ResumoCustoDemanda {
  chamadas: number;
  tokensEntrada: number;
  tokensSaida: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensTotal: number;
  custoUsd: string;
  porPapel: CustoPorPapel[];
}

interface LinhaCusto {
  papel: string;
  chamadas: number;
  tokens_entrada: number;
  tokens_saida: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  custo_usd: string;
  duracao_media_ms: number | null;
}

function mapear(l: LinhaCusto): CustoPorPapel {
  return {
    papel: l.papel,
    chamadas: l.chamadas,
    tokensEntrada: l.tokens_entrada,
    tokensSaida: l.tokens_saida,
    tokensCacheRead: l.tokens_cache_read,
    tokensCacheWrite: l.tokens_cache_write,
    tokensTotal: l.tokens_entrada + l.tokens_saida + l.tokens_cache_read + l.tokens_cache_write,
    custoUsd: l.custo_usd,
    duracaoMediaMs: l.duracao_media_ms,
  };
}

export async function resumoCustoDaDemanda(db: Db, demandaId: string): Promise<ResumoCustoDemanda> {
  const { rows } = await db.query<LinhaCusto>(
    `SELECT papel,
            count(*)::int AS chamadas,
            COALESCE(sum(tokens_in), 0)::int AS tokens_entrada,
            COALESCE(sum(tokens_out), 0)::int AS tokens_saida,
            COALESCE(sum(cache_read), 0)::int AS tokens_cache_read,
            COALESCE(sum(cache_write), 0)::int AS tokens_cache_write,
            COALESCE(sum(custo_usd), 0)::numeric(12,6)::text AS custo_usd,
            round(avg(duracao_ms))::int AS duracao_media_ms
       FROM agent_steps
      WHERE demanda_id = $1
      GROUP BY papel
      ORDER BY sum(custo_usd) DESC, papel ASC`,
    [demandaId],
  );
  const porPapel = rows.map(mapear);
  const total = porPapel.reduce(
    (acc, p) => ({
      chamadas: acc.chamadas + p.chamadas,
      tokensEntrada: acc.tokensEntrada + p.tokensEntrada,
      tokensSaida: acc.tokensSaida + p.tokensSaida,
      tokensCacheRead: acc.tokensCacheRead + p.tokensCacheRead,
      tokensCacheWrite: acc.tokensCacheWrite + p.tokensCacheWrite,
      custo: acc.custo + Number(p.custoUsd),
    }),
    { chamadas: 0, tokensEntrada: 0, tokensSaida: 0, tokensCacheRead: 0, tokensCacheWrite: 0, custo: 0 },
  );
  return {
    chamadas: total.chamadas,
    tokensEntrada: total.tokensEntrada,
    tokensSaida: total.tokensSaida,
    tokensCacheRead: total.tokensCacheRead,
    tokensCacheWrite: total.tokensCacheWrite,
    tokensTotal: total.tokensEntrada + total.tokensSaida + total.tokensCacheRead + total.tokensCacheWrite,
    custoUsd: total.custo.toFixed(6),
    porPapel,
  };
}

