import type { Db } from './tx.ts';

export const LIMITE_TEXTO_MENSAGEM = 4000;

export interface Mensagem {
  id: string;
  demandaId: string;
  autor: 'solicitante' | 'agente';
  setor: string | null;
  agente: string | null;
  texto: string;
  criadoEm: string;
}

export interface NovaMensagem {
  demandaId: string;
  autor: 'solicitante' | 'agente';
  setor?: string | null;
  agente?: string | null;
  texto: string;
}

interface Linha {
  id: string;
  demanda_id: string;
  autor: 'solicitante' | 'agente';
  setor: string | null;
  agente: string | null;
  texto: string;
  criado_em: Date;
}

function mapear(l: Linha): Mensagem {
  return {
    id: l.id,
    demandaId: l.demanda_id,
    autor: l.autor,
    setor: l.setor,
    agente: l.agente,
    texto: l.texto,
    criadoEm: l.criado_em.toISOString(),
  };
}

export async function adicionarMensagem(db: Db, m: NovaMensagem): Promise<Mensagem> {
  const texto =
    m.texto.length > LIMITE_TEXTO_MENSAGEM ? `${m.texto.slice(0, LIMITE_TEXTO_MENSAGEM - 1)}…` : m.texto;
  const { rows } = await db.query<Linha>(
    `INSERT INTO mensagens (demanda_id, autor, setor, agente, texto)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, demanda_id, autor, setor, agente, texto, criado_em`,
    [m.demandaId, m.autor, m.setor ?? null, m.agente ?? null, texto],
  );
  return mapear(rows[0]!);
}

export async function listarMensagens(db: Db, demandaId: string): Promise<Mensagem[]> {
  const { rows } = await db.query<Linha>(
    `SELECT id, demanda_id, autor, setor, agente, texto, criado_em
       FROM mensagens WHERE demanda_id = $1 ORDER BY criado_em ASC`,
    [demandaId],
  );
  return rows.map(mapear);
}
