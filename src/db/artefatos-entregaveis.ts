import type { ArtefatoEntregavelRenderizado, FormatoEntregavel } from '../domain/artefatos-entregaveis.ts';
import type { Db } from './tx.ts';

export interface ArtefatoEntregavelResumo {
  id: string;
  demandaId: string;
  entregaId: string;
  ordem: number;
  formato: FormatoEntregavel;
  nomeArquivo: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  geradoPor: string;
  publicadoPor: string;
  classificacao: 'interna';
  criadoEm: string;
}
export interface ArtefatoEntregavel extends ArtefatoEntregavelResumo {
  conteudo: Buffer;
}

interface LinhaResumo {
  id: string;
  demanda_id: string;
  entrega_id: string;
  ordem: number;
  formato: FormatoEntregavel;
  nome_arquivo: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  gerado_por: string;
  publicado_por: string;
  classificacao: 'interna';
  criado_em: Date;
}

interface LinhaCompleta extends LinhaResumo {
  conteudo: Buffer;
}

const COLUNAS = `id, demanda_id, entrega_id, ordem, formato, nome_arquivo, mime_type, bytes, sha256,
  gerado_por, publicado_por, classificacao, criado_em`;

function mapear(linha: LinhaResumo): ArtefatoEntregavelResumo {
  return {
    id: linha.id,
    demandaId: linha.demanda_id,
    entregaId: linha.entrega_id,
    ordem: linha.ordem,
    formato: linha.formato,
    nomeArquivo: linha.nome_arquivo,
    mimeType: linha.mime_type,
    bytes: linha.bytes,
    sha256: linha.sha256,
    geradoPor: linha.gerado_por,
    publicadoPor: linha.publicado_por,
    classificacao: linha.classificacao,
    criadoEm: linha.criado_em.toISOString(),
  };
}

export async function inserirArtefatosEntregaveis(
  db: Db,
  p: {
    demandaId: string;
    entregaId: string;
    geradoPor: string;
    publicadoPor: string;
    artefatos: readonly ArtefatoEntregavelRenderizado[];
  },
): Promise<ArtefatoEntregavelResumo[]> {
  const inseridos: ArtefatoEntregavelResumo[] = [];
  for (const [indice, artefato] of p.artefatos.entries()) {
    const { rows } = await db.query<LinhaResumo>(
      `INSERT INTO artefatos_entregaveis
         (demanda_id, entrega_id, ordem, formato, nome_arquivo, mime_type, conteudo, bytes, sha256, gerado_por, publicado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUNAS}`,
      [
        p.demandaId,
        p.entregaId,
        indice + 1,
        artefato.formato,
        artefato.nomeArquivo,
        artefato.mimeType,
        artefato.conteudo,
        artefato.bytes,
        artefato.sha256,
        p.geradoPor,
        p.publicadoPor,
      ],
    );
    inseridos.push(mapear(rows[0]!));
  }
  return inseridos;
}

export async function listarArtefatosEntregaveisDaDemanda(db: Db, demandaId: string): Promise<ArtefatoEntregavelResumo[]> {
  const { rows } = await db.query<LinhaResumo>(
    `SELECT ${COLUNAS} FROM artefatos_entregaveis WHERE demanda_id = $1 ORDER BY criado_em, entrega_id, ordem`,
    [demandaId],
  );
  return rows.map(mapear);
}

export async function obterArtefatoEntregavel(db: Db, id: string): Promise<ArtefatoEntregavel | null> {
  const { rows } = await db.query<LinhaCompleta>(
    `SELECT ${COLUNAS}, conteudo FROM artefatos_entregaveis WHERE id = $1`,
    [id],
  );
  const linha = rows[0];
  return linha ? { ...mapear(linha), conteudo: linha.conteudo } : null;
}
