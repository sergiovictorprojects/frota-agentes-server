import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { Db } from './tx.ts';

// Fase 3.2a: contrato do artefato de uma tarefa (seção 5.6 do plano e ADR 0007). O artefato é texto do modelo:
// fica só em artefatos_tarefa, nunca em eventos, logs, dossiê ou interface. O banco repete estas validações
// (migration 006): referencia_url_valida, artefato_referencias_validas, texto_e_json e os CHECK da tabela.

export const LIMITE_BYTES_ARTEFATO_ESPECIALISTA = 65_536;
export const LIMITE_BYTES_ARTEFATO_INTEGRACAO = 131_072;
export const LIMITE_REFERENCIAS = 10;
export const FORMATOS_ARTEFATO = ['texto', 'json'] as const;
export type FormatoArtefato = (typeof FORMATOS_ARTEFATO)[number];

// Caracteres de controle: C0 (inclusive NUL, que o Postgres nem aceita em text), DEL, C1 e os separadores de linha
// e parágrafo. Mesma classe do banco, que não precisa do NUL.
export const CARACTERE_DE_CONTROLE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Contagem em caracteres Unicode, como char_length no banco (string.length conta unidades UTF-16).
export function comprimento(texto: string): number {
  return [...texto].length;
}

const SUBSTITUTO_SOLTO_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Texto que o banco guarda sem trocar nada: sem NUL (o Postgres recusa) e sem substituto UTF-16 solto (o driver
// o trocaria por U+FFFD, e o hash e o tamanho gravados deixariam de bater com o que foi validado).
export function textoArmazenavel(texto: string): boolean {
  return !texto.includes('\u0000') && !SUBSTITUTO_SOLTO_RE.test(texto);
}

export function bytesUtf8(texto: string): number {
  return Buffer.byteLength(texto, 'utf8');
}

// Mesmas expressões de referencia_url_valida (migration 006): https, host com nome e em minúsculas, sem
// credencial, porta, query ou fragmento, e sem trecho com cara de token.
const URL_REFERENCIA_RE = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(\/[A-Za-z0-9._~%!$&'()*+,;=:@-]*)*$/;
const SEQUENCIA_LONGA_RE = /[A-Za-z0-9_]{24,}/;
const SEQUENCIA_COM_DIGITO_RE = /(^|[^A-Za-z0-9_])(?=[A-Za-z0-9_]{16})[A-Za-z_]*[0-9]/;
const UUID_NO_TEXTO_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function urlDeReferenciaValida(url: string): boolean {
  return (
    comprimento(url) <= 500 &&
    URL_REFERENCIA_RE.test(url) &&
    !SEQUENCIA_LONGA_RE.test(url) &&
    !SEQUENCIA_COM_DIGITO_RE.test(url) &&
    !UUID_NO_TEXTO_RE.test(url)
  );
}

export const ReferenciaSchema = z.discriminatedUnion('tipo', [
  z.strictObject({ tipo: z.literal('url'), url: z.string().refine(urlDeReferenciaValida) }),
  z.strictObject({
    tipo: z.literal('fonte'),
    citacao: z
      .string()
      .refine((c) => textoArmazenavel(c) && comprimento(c) >= 1 && comprimento(c) <= 300 && !CARACTERE_DE_CONTROLE_RE.test(c)),
  }),
  z.strictObject({ tipo: z.literal('artefato'), tarefaId: z.string().regex(UUID_RE) }),
]);
export type Referencia = z.infer<typeof ReferenciaSchema>;

// Filtra as referências propostas pelo modelo: fica só o que passa no formato fechado e, para "artefato", o que
// aponta para uma dependência direta da tarefa. Até 10; o resto é descartado e contado, nunca gravado.
export function filtrarReferencias(
  propostas: readonly unknown[],
  dependenciasDiretas: ReadonlySet<string>,
): { referencias: Referencia[]; descartadas: number } {
  const referencias: Referencia[] = [];
  for (const proposta of propostas) {
    const r = ReferenciaSchema.safeParse(proposta);
    if (!r.success) continue;
    if (r.data.tipo === 'artefato' && !dependenciasDiretas.has(r.data.tarefaId)) continue;
    if (referencias.length === LIMITE_REFERENCIAS) break;
    referencias.push(r.data);
  }
  return { referencias, descartadas: propostas.length - referencias.length };
}

// O JSON.parse do Node aceita o que o jsonb do Postgres recusa: número fora da faixa do numeric (1e200000 vira
// Infinity, 1e-99999 vira 0) e aninhamento que estoura a pilha do banco. Estes limites, bem abaixo dos do banco e
// acima do que um artefato precisa, fazem o que passa aqui passar também em texto_e_json (migration 006).
export const PROFUNDIDADE_MAXIMA_JSON = 64;
const NUMERO_JSON_MAX_CARACTERES = 64;
const EXPOENTE_JSON_MAX = 300;

const caractereDeNumero = (c: string): boolean => (c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.' || c === 'e' || c === 'E';

// Uma passada no texto, fora das strings: a profundidade de [ e { e cada número, com até 64 caracteres e expoente
// de -300 a 300. Roda depois de JSON.parse aceitar o texto, então a gramática já está garantida.
function jsonDentroDosLimites(texto: string): boolean {
  let profundidade = 0;
  let i = 0;
  while (i < texto.length) {
    const c = texto[i]!;
    if (c === '"') {
      i++;
      while (i < texto.length && texto[i] !== '"') i += texto[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '[' || c === '{') {
      profundidade++;
      if (profundidade > PROFUNDIDADE_MAXIMA_JSON) return false;
      i++;
    } else if (c === ']' || c === '}') {
      profundidade--;
      i++;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const inicio = i;
      while (i < texto.length && caractereDeNumero(texto[i]!)) i++;
      const numero = texto.slice(inicio, i);
      if (numero.length > NUMERO_JSON_MAX_CARACTERES) return false;
      const expoente = /[eE]([-+]?\d+)$/.exec(numero);
      if (expoente && Math.abs(Number(expoente[1])) > EXPOENTE_JSON_MAX) return false;
    } else {
      i++;
    }
  }
  return true;
}

// JSON que o jsonb do Postgres aceita: JSON.parse aceita, a estrutura cabe nos limites acima, todo número é
// finito e nenhuma string (nem chave) tem NUL ou substituto UTF-16 solto, que o banco recusa. Nunca lança: com a
// profundidade limitada, a visita recursiva não estoura a pilha.
export function jsonAceitoPeloBanco(texto: string): boolean {
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    return false;
  }
  if (!jsonDentroDosLimites(texto)) return false;
  const visitar = (v: unknown): boolean => {
    if (typeof v === 'string') return textoArmazenavel(v);
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(visitar);
    if (v !== null && typeof v === 'object') return Object.entries(v).every(([k, x]) => textoArmazenavel(k) && visitar(x));
    return true;
  };
  return visitar(valor);
}

// A resposta do modelo para uma tarefa. O schema da resposta é folgado de propósito (a API não aplica limites):
// quem recusa é validarArtefato, com o código artefato_invalido.
export const ArtefatoPropostoSchema = z.object({
  formato: z.enum(FORMATOS_ARTEFATO),
  resumo: z.string(),
  conteudo: z.string(),
  referencias: z.array(z.unknown()),
});
export type ArtefatoProposto = z.infer<typeof ArtefatoPropostoSchema>;

export interface ArtefatoValidado {
  formato: FormatoArtefato;
  resumo: string;
  conteudo: string;
  referencias: Referencia[];
}

export type ValidacaoArtefato =
  | { valido: true; artefato: ArtefatoValidado; referenciasDescartadas: number }
  | { valido: false; codigoErro: 'artefato_invalido' };

export function validarArtefato(
  proposto: ArtefatoProposto,
  tipo: 'especialista' | 'integracao',
  dependenciasDiretas: ReadonlySet<string>,
): ValidacaoArtefato {
  const limite = tipo === 'especialista' ? LIMITE_BYTES_ARTEFATO_ESPECIALISTA : LIMITE_BYTES_ARTEFATO_INTEGRACAO;
  const resumoOk =
    textoArmazenavel(proposto.resumo) && comprimento(proposto.resumo) >= 1 && comprimento(proposto.resumo) <= 500;
  const conteudoOk = textoArmazenavel(proposto.conteudo) && bytesUtf8(proposto.conteudo) <= limite;
  const formatoOk = proposto.formato === 'texto' || jsonAceitoPeloBanco(proposto.conteudo);
  if (!resumoOk || !conteudoOk || !formatoOk) {
    return { valido: false, codigoErro: 'artefato_invalido' };
  }
  const { referencias, descartadas } = filtrarReferencias(proposto.referencias, dependenciasDiretas);
  return {
    valido: true,
    artefato: { formato: proposto.formato, resumo: proposto.resumo, conteudo: proposto.conteudo, referencias },
    referenciasDescartadas: descartadas,
  };
}

export function sha256Hex(conteudo: string): string {
  return createHash('sha256').update(conteudo, 'utf8').digest('hex');
}

// Grava o artefato com o hash e o tamanho calculados aqui; o banco confere os dois. Roda na transação de quem
// conclui a tarefa (src/db/tarefas.ts), com a tarefa já travada pelo lease_token.
export async function inserirArtefato(
  cliente: pg.PoolClient,
  p: { tarefaId: string; artefato: ArtefatoValidado },
): Promise<{ id: string; bytes: number; sha256: string }> {
  const bytes = bytesUtf8(p.artefato.conteudo);
  const sha256 = sha256Hex(p.artefato.conteudo);
  const { rows } = await cliente.query<{ id: string }>(
    `INSERT INTO artefatos_tarefa (tarefa_id, formato, resumo, conteudo, bytes, sha256, referencias)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [p.tarefaId, p.artefato.formato, p.artefato.resumo, p.artefato.conteudo, bytes, sha256, JSON.stringify(p.artefato.referencias)],
  );
  return { id: rows[0]!.id, bytes, sha256 };
}

export interface ArtefatoDeDependencia {
  tarefaId: string;
  chave: string;
  formato: FormatoArtefato;
  resumo: string;
  conteudo: string;
  referencias: Referencia[];
  bytes: number;
}

// Artefatos das dependências diretas de uma tarefa, para montar o prompt (PR 3.2b). Uso interno: o conteúdo é
// texto do modelo e só entra no prompt pela serialização canônica.
export async function listarArtefatosDasDependencias(db: Db, tarefaId: string): Promise<ArtefatoDeDependencia[]> {
  const { rows } = await db.query<{
    tarefa_id: string;
    chave: string;
    formato: FormatoArtefato;
    resumo: string;
    conteudo: string;
    referencias: Referencia[];
    bytes: number;
  }>(
    `SELECT a.tarefa_id, d.chave, a.formato, a.resumo, a.conteudo, a.referencias, a.bytes
       FROM tarefas_dependencias td
       JOIN tarefas d ON d.id = td.depende_de_id
       JOIN artefatos_tarefa a ON a.tarefa_id = d.id
      WHERE td.tarefa_id = $1
      ORDER BY d.chave COLLATE "C"`,
    [tarefaId],
  );
  return rows.map((l) => ({
    tarefaId: l.tarefa_id,
    chave: l.chave,
    formato: l.formato,
    resumo: l.resumo,
    conteudo: l.conteudo,
    referencias: l.referencias,
    bytes: l.bytes,
  }));
}
