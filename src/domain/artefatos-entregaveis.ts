import { z } from 'zod';

// Arquivos finais oferecidos ao solicitante. Não confundir com `FormatoArtefato` de db/artefatos.ts:
// aqueles são mensagens intermediárias texto/json entre tarefas e nunca saem na interface.
export const FORMATOS_ENTREGAVEIS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'tsv',
  'json',
  'yaml',
  'xml',
  'sql',
  'txt',
  'markdown',
  'html',
  'svg',
  'ics',
  'vcf',
  'zip',
] as const;

export type FormatoEntregavel = (typeof FORMATOS_ENTREGAVEIS)[number];

export interface MetadadosFormatoEntregavel {
  extensao: string;
  mimeType: string;
}

export const METADADOS_FORMATOS_ENTREGAVEIS: Readonly<Record<FormatoEntregavel, MetadadosFormatoEntregavel>> = {
  pdf: { extensao: 'pdf', mimeType: 'application/pdf' },
  docx: { extensao: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { extensao: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { extensao: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  csv: { extensao: 'csv', mimeType: 'text/csv; charset=utf-8' },
  tsv: { extensao: 'tsv', mimeType: 'text/tab-separated-values; charset=utf-8' },
  json: { extensao: 'json', mimeType: 'application/json' },
  yaml: { extensao: 'yaml', mimeType: 'application/yaml' },
  xml: { extensao: 'xml', mimeType: 'application/xml' },
  sql: { extensao: 'sql', mimeType: 'application/sql' },
  txt: { extensao: 'txt', mimeType: 'text/plain; charset=utf-8' },
  markdown: { extensao: 'md', mimeType: 'text/markdown; charset=utf-8' },
  html: { extensao: 'html', mimeType: 'text/html; charset=utf-8' },
  svg: { extensao: 'svg', mimeType: 'image/svg+xml' },
  ics: { extensao: 'ics', mimeType: 'text/calendar; charset=utf-8' },
  vcf: { extensao: 'vcf', mimeType: 'text/vcard; charset=utf-8' },
  zip: { extensao: 'zip', mimeType: 'application/zip' },
};

export const MAX_ARTEFATOS_ENTREGAVEIS = 5;
export const MAX_BYTES_ARTEFATO_ENTREGAVEL = 5 * 1024 * 1024;

// O modelo descreve o arquivo; somente o servidor decide os bytes, MIME, extensão, hash e nome final.
// O limite de caracteres é superior ao que cabe na resposta normal do modelo e evita estruturas sem teto
// nos testes e em caminhos que não passam pela API real.
export const ArtefatoEntregavelPropostoSchema = z.object({
  nomeArquivo: z.string().min(1).max(120),
  formato: z.enum(FORMATOS_ENTREGAVEIS),
  conteudo: z.string().max(500_000),
});

export type ArtefatoEntregavelProposto = z.infer<typeof ArtefatoEntregavelPropostoSchema>;

export interface ArtefatoEntregavelRenderizado {
  formato: FormatoEntregavel;
  nomeArquivo: string;
  mimeType: string;
  conteudo: Buffer;
  bytes: number;
  sha256: string;
}
