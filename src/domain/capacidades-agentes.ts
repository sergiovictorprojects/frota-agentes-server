import type { FormatoArtefato } from '../db/artefatos.ts';
import type { PapelAgente } from '../db/agentes.ts';
import {
  FORMATOS_ENTREGAVEIS,
  MAX_BYTES_ARTEFATO_ENTREGAVEL,
  type FormatoEntregavel,
} from './artefatos-entregaveis.ts';
import type { Categoria } from './setores.ts';

export interface CapacidadesAgente {
  gerarArtefatos: readonly FormatoEntregavel[];
  publicarArtefatos: boolean;
  // A ingestão de anexos deliberadamente não faz parte desta entrega. O campo já existe para que ativá-la
  // no futuro exija uma mudança explícita, versionada e auditada no catálogo.
  lerAnexos: boolean;
  maxArtefatosPorDemanda: number;
  maxBytesPorArtefato: number;
}

// Matriz fechada por especialidade. Ela também é copiada para o catálogo persistido pela migration 007;
// esta constante define apenas o valor inicial usado no seed, não substitui o banco em runtime.
const FORMATOS_POR_CATEGORIA: Readonly<Record<Categoria, readonly FormatoEntregavel[]>> = {
  gestores: FORMATOS_ENTREGAVEIS,
  d1: ['pdf', 'docx', 'pptx', 'json', 'yaml', 'xml', 'sql', 'txt', 'markdown', 'html', 'svg', 'zip'],
  d2: ['pdf', 'docx', 'csv', 'json', 'txt', 'markdown', 'html'],
  d3: ['pdf', 'docx', 'csv', 'json', 'txt', 'markdown', 'html'],
  d4: ['pdf', 'docx', 'json', 'yaml', 'xml', 'sql', 'txt', 'markdown', 'html'],
  d5: ['yaml', 'xml', 'sql', 'txt', 'markdown', 'html', 'zip'],
  d6: ['xlsx', 'csv', 'tsv', 'json', 'xml', 'txt', 'markdown', 'html'],
  d7: ['pdf', 'docx', 'pptx', 'json', 'yaml', 'xml', 'txt', 'markdown', 'html', 'svg', 'zip'],
  d8: ['pdf', 'docx', 'pptx', 'txt', 'markdown', 'html'],
  d9: ['json', 'sql', 'txt', 'markdown', 'zip'],
  d10: ['pdf', 'docx', 'xlsx', 'csv', 'tsv', 'json', 'txt', 'markdown', 'html'],
  d11: ['pdf', 'pptx', 'html', 'svg', 'zip'],
  d12: ['pdf', 'docx', 'csv', 'json', 'yaml', 'xml', 'sql', 'txt', 'markdown', 'html', 'zip'],
  d13: ['pdf', 'docx', 'xlsx', 'csv', 'tsv', 'json', 'yaml', 'txt', 'markdown', 'html', 'svg', 'zip'],
  d14: ['csv', 'tsv', 'json', 'yaml', 'xml', 'txt', 'markdown', 'html', 'ics', 'vcf', 'zip'],
  d15: ['pdf', 'docx', 'json', 'yaml', 'xml', 'sql', 'txt', 'markdown', 'html', 'svg', 'zip'],
  d16: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'json', 'txt', 'markdown', 'html', 'svg', 'ics', 'vcf', 'zip'],
  d17: [],
  d18: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'tsv', 'json', 'txt', 'markdown', 'html', 'ics', 'vcf'],
};

export function capacidadesPadraoDoAgente(agente: { categoria: Categoria; papel: PapelAgente }): CapacidadesAgente {
  const gera = agente.papel === 'auditor' || agente.papel === 'avaliador' ? [] : FORMATOS_POR_CATEGORIA[agente.categoria];
  return {
    gerarArtefatos: [...gera],
    publicarArtefatos: agente.papel === 'coordenador',
    lerAnexos: false,
    maxArtefatosPorDemanda: gera.length === 0 ? 0 : agente.papel === 'coordenador' ? 5 : 3,
    maxBytesPorArtefato: gera.length === 0 ? 0 : MAX_BYTES_ARTEFATO_ENTREGAVEL,
  };
}

export function agentePodeGerarArtefatoEntregavel(
  agente: { estado: string; capacidades: CapacidadesAgente },
  formato: FormatoEntregavel,
): boolean {
  return agente.estado === 'ativo' && agente.capacidades.gerarArtefatos.includes(formato);
}

export function agentePodePublicarArtefato(agente: { estado: string; capacidades: CapacidadesAgente }): boolean {
  return agente.estado === 'ativo' && agente.capacidades.publicarArtefatos;
}

// Artefatos intermediários continuam no contrato fechado texto/json da migration 006. Eles não são arquivos
// entregáveis e sua autorização depende do papel da tarefa, não da matriz de formatos finais.
export function agentePodeGerarArtefatoIntermediario(
  agente: { papel: PapelAgente; estado: string },
  formato: FormatoArtefato,
): boolean {
  return agente.estado === 'ativo' && (agente.papel === 'coordenador' || agente.papel === 'executor') && (formato === 'texto' || formato === 'json');
}

// Nome antigo mantido para compatibilidade de importação; a semântica sempre foi a do artefato de tarefa.
export const agentePodeGerarArtefato = agentePodeGerarArtefatoIntermediario;
