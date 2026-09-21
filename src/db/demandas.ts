import type { Categoria, Prioridade, StatusDemanda } from '../domain/setores.ts';
import type { Db } from './tx.ts';

export type AlternativaInsumo = 'A' | 'B' | 'C';

// Depois de N reivindicações sem sucesso a demanda vira "Falhou" em vez de voltar para a fila.
export const MAX_TENTATIVAS = 3;

export interface Demanda {
  id: string;
  titulo: string;
  descricao: string;
  categoria: Categoria;
  prioridade: Prioridade;
  prazo: string | null;
  solicitante: string | null;
  referencias: string | null;
  status: StatusDemanda;
  entregaUrl: string | null;
  criadoEm: string;
  atualizadoEm: string;
  claimedByRun: string | null;
  claimedAt: string | null;
  alternativaInsumo: AlternativaInsumo | null;
  bloqueioHumano: unknown;
  tentativas: number;
}

export interface NovaDemanda {
  titulo: string;
  descricao?: string;
  categoria: Categoria;
  prioridade?: Prioridade;
  prazo?: string | null;
  solicitante?: string | null;
  referencias?: string | null;
}

export interface PatchDemanda {
  status?: StatusDemanda;
  entregaUrl?: string | null;
  alternativaInsumo?: AlternativaInsumo | null;
  bloqueioHumano?: unknown;
}

interface Linha {
  id: string;
  titulo: string;
  descricao: string;
  categoria: Categoria;
  prioridade: Prioridade;
  prazo: string | null;
  solicitante: string | null;
  referencias: string | null;
  status: StatusDemanda;
  entrega_url: string | null;
  criado_em: Date;
  atualizado_em: Date;
  claimed_by_run: string | null;
  claimed_at: Date | null;
  alternativa_insumo: AlternativaInsumo | null;
  bloqueio_humano: unknown;
  tentativas: number;
}

const COLUNAS = `id, titulo, descricao, categoria, prioridade, prazo::text AS prazo, solicitante, referencias,
  status, entrega_url, criado_em, atualizado_em, claimed_by_run, claimed_at, alternativa_insumo,
  bloqueio_humano, tentativas`;

function mapear(l: Linha): Demanda {
  return {
    id: l.id,
    titulo: l.titulo,
    descricao: l.descricao,
    categoria: l.categoria,
    prioridade: l.prioridade,
    prazo: l.prazo,
    solicitante: l.solicitante,
    referencias: l.referencias,
    status: l.status,
    entregaUrl: l.entrega_url,
    criadoEm: l.criado_em.toISOString(),
    atualizadoEm: l.atualizado_em.toISOString(),
    claimedByRun: l.claimed_by_run,
    claimedAt: l.claimed_at ? l.claimed_at.toISOString() : null,
    alternativaInsumo: l.alternativa_insumo,
    bloqueioHumano: l.bloqueio_humano ?? null,
    tentativas: l.tentativas,
  };
}

export async function criarDemanda(db: Db, d: NovaDemanda): Promise<Demanda> {
  const { rows } = await db.query<Linha>(
    `INSERT INTO demandas (titulo, descricao, categoria, prioridade, prazo, solicitante, referencias)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUNAS}`,
    [
      d.titulo,
      d.descricao ?? '',
      d.categoria,
      d.prioridade ?? 'MEDIUM',
      d.prazo ?? null,
      d.solicitante ?? null,
      d.referencias ?? null,
    ],
  );
  return mapear(rows[0]!);
}

export async function obterDemanda(db: Db, id: string): Promise<Demanda | null> {
  const { rows } = await db.query<Linha>(`SELECT ${COLUNAS} FROM demandas WHERE id = $1`, [id]);
  return rows[0] ? mapear(rows[0]) : null;
}

export async function listarDemandas(
  db: Db,
  filtro: { status?: StatusDemanda; limite?: number } = {},
): Promise<Demanda[]> {
  const { rows } = await db.query<Linha>(
    `SELECT ${COLUNAS} FROM demandas WHERE ($1::text IS NULL OR status = $1) ORDER BY criado_em DESC LIMIT $2`,
    [filtro.status ?? null, filtro.limite ?? 100],
  );
  return rows.map(mapear);
}

export async function existeDemandaNova(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ existe: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM demandas WHERE status = 'Nova') AS existe",
  );
  return rows[0]?.existe === true;
}

export async function contarPorStatus(db: Db): Promise<Partial<Record<StatusDemanda, number>>> {
  const { rows } = await db.query<{ status: StatusDemanda; total: number }>(
    'SELECT status, count(*)::int AS total FROM demandas GROUP BY status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.total]));
}

// FOR UPDATE SKIP LOCKED: execuções simultâneas nunca pegam a mesma demanda. Reivindicar não conta como
// tentativa: um lote reivindicado e nunca iniciado (processo caiu) não pode levar demandas a "Falhou".
export async function reivindicarDemandas(db: Db, runId: string, limite: number): Promise<Demanda[]> {
  const { rows } = await db.query<Linha>(
    `UPDATE demandas
        SET status = 'Em andamento', claimed_by_run = $1, claimed_at = now(), atualizado_em = now()
      WHERE id IN (
        SELECT id FROM demandas WHERE status = 'Nova'
         ORDER BY criado_em ASC, id ASC LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      RETURNING ${COLUNAS}`,
    [runId, limite],
  );
  return rows.map(mapear).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

// Recupera demandas presas em "Em andamento" por um processo que morreu no meio do trabalho.
export async function liberarDemandasAbandonadas(
  db: Db,
  minutos: number,
  maxTentativas: number = MAX_TENTATIVAS,
): Promise<{ id: string; status: StatusDemanda }[]> {
  const { rows } = await db.query<{ id: string; status: StatusDemanda }>(
    `UPDATE demandas
        SET status = CASE WHEN tentativas >= $2 THEN 'Falhou' ELSE 'Nova' END,
            claimed_by_run = NULL, claimed_at = NULL, atualizado_em = now()
      WHERE status = 'Em andamento' AND claimed_at < now() - make_interval(mins => $1::int)
      RETURNING id, status`,
    [minutos, maxTentativas],
  );
  return rows;
}

// A tentativa passa a contar quando o trabalho de fato começa.
export async function registrarTentativa(db: Db, id: string): Promise<void> {
  await db.query('UPDATE demandas SET tentativas = tentativas + 1, atualizado_em = now() WHERE id = $1', [id]);
}

// Devolve à fila quando o motivo não é culpa da demanda (orçamento, pausa, API fora do ar).
// `desfazerTentativa` é true para a demanda que já tinha começado: aquela tentativa não vale.
export async function devolverParaFila(db: Db, id: string, desfazerTentativa = false): Promise<void> {
  await db.query(
    `UPDATE demandas
        SET status = 'Nova', claimed_by_run = NULL, claimed_at = NULL,
            tentativas = CASE WHEN $2 THEN GREATEST(tentativas - 1, 0) ELSE tentativas END,
            atualizado_em = now()
      WHERE id = $1 AND status = 'Em andamento'`,
    [id, desfazerTentativa],
  );
}

// Recoloca na fila o que falhou ou espera resposta, zerando as tentativas.
export async function reabrirDemanda(db: Db, id: string): Promise<Demanda | null> {
  const { rows } = await db.query<Linha>(
    `UPDATE demandas
        SET status = 'Nova', tentativas = 0, claimed_by_run = NULL, claimed_at = NULL,
            bloqueio_humano = NULL, atualizado_em = now()
      WHERE id = $1 AND status IN ('Falhou', 'Aguardando humano', 'Aguardando insumo')
      RETURNING ${COLUNAS}`,
    [id],
  );
  return rows[0] ? mapear(rows[0]) : null;
}

// Nunca arquiva o que está em andamento: a execução ainda vai gravar o resultado.
export async function arquivarDemanda(db: Db, id: string): Promise<Demanda | null> {
  const { rows } = await db.query<Linha>(
    `UPDATE demandas SET status = 'Arquivada', claimed_by_run = NULL, claimed_at = NULL, atualizado_em = now()
      WHERE id = $1 AND status NOT IN ('Em andamento', 'Arquivada')
      RETURNING ${COLUNAS}`,
    [id],
  );
  return rows[0] ? mapear(rows[0]) : null;
}

export async function atualizarDemanda(db: Db, id: string, patch: PatchDemanda): Promise<Demanda | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (coluna: string, valor: unknown): void => {
    params.push(valor);
    sets.push(`${coluna} = $${params.length}`);
  };

  if (patch.status !== undefined) {
    add('status', patch.status);
    if (patch.status !== 'Em andamento') sets.push('claimed_by_run = NULL', 'claimed_at = NULL');
  }
  if (patch.entregaUrl !== undefined) add('entrega_url', patch.entregaUrl);
  if (patch.alternativaInsumo !== undefined) add('alternativa_insumo', patch.alternativaInsumo);
  if (patch.bloqueioHumano !== undefined) {
    add('bloqueio_humano', patch.bloqueioHumano === null ? null : JSON.stringify(patch.bloqueioHumano));
  }
  if (sets.length === 0) return obterDemanda(db, id);

  sets.push('atualizado_em = now()');
  const { rows } = await db.query<Linha>(
    `UPDATE demandas SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUNAS}`,
    params,
  );
  return rows[0] ? mapear(rows[0]) : null;
}
