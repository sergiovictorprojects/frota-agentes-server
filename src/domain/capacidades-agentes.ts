import type { FormatoArtefato } from '../db/artefatos.ts';
import type { Agente, PapelAgente } from '../db/agentes.ts';

// Capacidades deliberadamente fechadas. Elas são o contrato que faltava entre o catálogo de agentes e a
// geração de artefatos: o agente não escolhe livremente um formato, e uma alteração de permissão passa por
// revisão de código até existir uma superfície administrativa versionada para isso.
export interface CapacidadesAgente {
  gerarArtefatos: readonly FormatoArtefato[];
  publicarArtefatos: boolean;
  lerAnexos: boolean;
  maxArtefatosPorDemanda: number;
  maxBytesPorArtefato: number;
}

const FORMATOS_GERADOR: readonly FormatoArtefato[] = ['texto', 'json'];

const POR_PAPEL: Readonly<Record<PapelAgente, CapacidadesAgente>> = {
  coordenador: {
    gerarArtefatos: FORMATOS_GERADOR,
    publicarArtefatos: true,
    lerAnexos: false,
    maxArtefatosPorDemanda: 1,
    maxBytesPorArtefato: 131_072,
  },
  executor: {
    gerarArtefatos: FORMATOS_GERADOR,
    publicarArtefatos: false,
    lerAnexos: false,
    maxArtefatosPorDemanda: 1,
    maxBytesPorArtefato: 65_536,
  },
  avaliador: {
    gerarArtefatos: [],
    publicarArtefatos: false,
    lerAnexos: false,
    maxArtefatosPorDemanda: 0,
    maxBytesPorArtefato: 0,
  },
  auditor: {
    gerarArtefatos: [],
    publicarArtefatos: false,
    lerAnexos: false,
    maxArtefatosPorDemanda: 0,
    maxBytesPorArtefato: 0,
  },
};

export function capacidadesDoAgente(agente: Pick<Agente, 'papel'>): CapacidadesAgente {
  const capacidade = POR_PAPEL[agente.papel];
  return {
    ...capacidade,
    gerarArtefatos: [...capacidade.gerarArtefatos],
  };
}

export function agentePodeGerarArtefato(
  agente: Pick<Agente, 'papel' | 'estado'>,
  formato: FormatoArtefato,
): boolean {
  return agente.estado === 'ativo' && capacidadesDoAgente(agente).gerarArtefatos.includes(formato);
}

export function agentePodePublicarArtefato(agente: Pick<Agente, 'papel' | 'estado'>): boolean {
  return agente.estado === 'ativo' && capacidadesDoAgente(agente).publicarArtefatos;
}
