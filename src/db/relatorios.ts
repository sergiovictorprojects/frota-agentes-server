import type { Db } from './tx.ts';

export interface Metricas {
  acoesRealizadas: string;
  tempoTotal: string;
  indiceGeral: number | null;
  antipadroesCount: number | null;
  regrasCumpridasPercent: number | null;
  auditoriaFalhou?: boolean;
}

export interface Ponderacao {
  setor: string;
  nota: string;
}

export interface NovoRelatorio {
  demandaId: string;
  demandaTitulo: string;
  gerente: string;
  nivelComplexidade: number;
  setoresEnvolvidos: string[];
  fontesUtilizadas: string | null;
  metricas: Metricas;
  ganhos: string | null;
  perdas: string | null;
  aprendizado: string | null;
  ponderacoes: Ponderacao[];
  entregaUrl: string | null;
}

export interface Relatorio extends NovoRelatorio {
  id: string;
  criadoEm: string;
}

interface LinhaRelatorio {
  id: string;
  demanda_id: string;
  demanda_titulo: string;
  gerente: string;
  nivel_complexidade: number;
  setores_envolvidos: string[];
  fontes_utilizadas: string | null;
  metricas: Metricas;
  ganhos: string | null;
  perdas: string | null;
  aprendizado: string | null;
  ponderacoes: Ponderacao[];
  entrega_url: string | null;
  criado_em: Date;
}

const COLUNAS_RELATORIO = `id, demanda_id, demanda_titulo, gerente, nivel_complexidade, setores_envolvidos,
  fontes_utilizadas, metricas, ganhos, perdas, aprendizado, ponderacoes, entrega_url, criado_em`;

function mapearRelatorio(l: LinhaRelatorio): Relatorio {
  return {
    id: l.id,
    demandaId: l.demanda_id,
    demandaTitulo: l.demanda_titulo,
    gerente: l.gerente,
    nivelComplexidade: l.nivel_complexidade,
    setoresEnvolvidos: l.setores_envolvidos,
    fontesUtilizadas: l.fontes_utilizadas,
    metricas: l.metricas,
    ganhos: l.ganhos,
    perdas: l.perdas,
    aprendizado: l.aprendizado,
    ponderacoes: l.ponderacoes,
    entregaUrl: l.entrega_url,
    criadoEm: l.criado_em.toISOString(),
  };
}

export async function salvarRelatorio(db: Db, r: NovoRelatorio): Promise<Relatorio> {
  const { rows } = await db.query<LinhaRelatorio>(
    `INSERT INTO relatorios (demanda_id, demanda_titulo, gerente, nivel_complexidade, setores_envolvidos,
       fontes_utilizadas, metricas, ganhos, perdas, aprendizado, ponderacoes, entrega_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUNAS_RELATORIO}`,
    [
      r.demandaId,
      r.demandaTitulo,
      r.gerente,
      r.nivelComplexidade,
      r.setoresEnvolvidos,
      r.fontesUtilizadas,
      JSON.stringify(r.metricas),
      r.ganhos,
      r.perdas,
      r.aprendizado,
      JSON.stringify(r.ponderacoes),
      r.entregaUrl,
    ],
  );
  return mapearRelatorio(rows[0]!);
}

export async function listarRelatorios(db: Db, limite = 50): Promise<Relatorio[]> {
  const { rows } = await db.query<LinhaRelatorio>(
    `SELECT ${COLUNAS_RELATORIO} FROM relatorios ORDER BY criado_em DESC LIMIT $1`,
    [limite],
  );
  return rows.map(mapearRelatorio);
}

export async function relatorioMaisRecente(db: Db, demandaId: string): Promise<Relatorio | null> {
  const { rows } = await db.query<LinhaRelatorio>(
    `SELECT ${COLUNAS_RELATORIO} FROM relatorios WHERE demanda_id = $1 ORDER BY criado_em DESC LIMIT 1`,
    [demandaId],
  );
  return rows[0] ? mapearRelatorio(rows[0]) : null;
}

export interface EntradaAprendizado {
  id: string;
  data: string;
  demanda: string;
  nivel: number;
  aprendizado: string;
  indice: number | null;
}

export async function registrarAprendizado(
  db: Db,
  e: { demanda: string; nivel: number; aprendizado: string; indice: number | null },
): Promise<void> {
  await db.query('INSERT INTO aprendizado_evolucao (demanda, nivel, aprendizado, indice) VALUES ($1, $2, $3, $4)', [
    e.demanda,
    e.nivel,
    e.aprendizado,
    e.indice,
  ]);
}

export async function listarAprendizado(db: Db, limite = 50): Promise<EntradaAprendizado[]> {
  const { rows } = await db.query<EntradaAprendizado>(
    `SELECT id, data::text AS data, demanda, nivel, aprendizado, indice
       FROM aprendizado_evolucao ORDER BY criado_em DESC LIMIT $1`,
    [limite],
  );
  return rows;
}

export interface Entrega {
  id: string;
  demandaId: string;
  titulo: string;
  conteudo: string;
  statusPromocao: 'pendente' | 'promovida' | 'dispensada';
  artifactUrl: string | null;
  criadoEm: string;
}

interface LinhaEntrega {
  id: string;
  demanda_id: string;
  titulo: string;
  conteudo: string;
  status_promocao: Entrega['statusPromocao'];
  artifact_url: string | null;
  criado_em: Date;
}

export async function criarEntrega(
  db: Db,
  e: { demandaId: string; titulo: string; conteudo: string },
): Promise<Entrega> {
  const { rows } = await db.query<LinhaEntrega>(
    `INSERT INTO entregas (demanda_id, titulo, conteudo) VALUES ($1, $2, $3)
     RETURNING id, demanda_id, titulo, conteudo, status_promocao, artifact_url, criado_em`,
    [e.demandaId, e.titulo, e.conteudo],
  );
  return mapearEntrega(rows[0]!);
}

export async function obterEntrega(db: Db, id: string): Promise<Entrega | null> {
  const { rows } = await db.query<LinhaEntrega>(
    `SELECT id, demanda_id, titulo, conteudo, status_promocao, artifact_url, criado_em
       FROM entregas WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapearEntrega(rows[0]) : null;
}

function mapearEntrega(l: LinhaEntrega): Entrega {
  return {
    id: l.id,
    demandaId: l.demanda_id,
    titulo: l.titulo,
    conteudo: l.conteudo,
    statusPromocao: l.status_promocao,
    artifactUrl: l.artifact_url,
    criadoEm: l.criado_em.toISOString(),
  };
}
