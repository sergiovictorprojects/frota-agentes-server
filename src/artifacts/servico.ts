import type { Agente } from '../db/agentes.ts';
import {
  agentePodeGerarArtefatoEntregavel,
  agentePodePublicarArtefato,
} from '../domain/capacidades-agentes.ts';
import {
  MAX_ARTEFATOS_ENTREGAVEIS,
  type ArtefatoEntregavelProposto,
  type ArtefatoEntregavelRenderizado,
} from '../domain/artefatos-entregaveis.ts';
import { renderizarArtefatoEntregavel } from './renderizadores.ts';

export class ArtefatoEntregavelInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ArtefatoEntregavelInvalidoError';
  }
}
export function prepararArtefatosEntregaveis(
  propostas: readonly ArtefatoEntregavelProposto[],
  gerador: Agente,
  publicador: Agente,
): ArtefatoEntregavelRenderizado[] {
  const limite = Math.min(MAX_ARTEFATOS_ENTREGAVEIS, gerador.capacidades.maxArtefatosPorDemanda);
  if (propostas.length > limite) {
    throw new ArtefatoEntregavelInvalidoError(`O agente ${gerador.chave} pode gerar no máximo ${limite} arquivo(s) por demanda.`);
  }
  if (propostas.length > 0 && !agentePodePublicarArtefato(publicador)) {
    throw new ArtefatoEntregavelInvalidoError(`O agente ${publicador.chave} não pode publicar artefatos.`);
  }

  const nomes = new Set<string>();
  return propostas.map((proposta) => {
    if (!agentePodeGerarArtefatoEntregavel(gerador, proposta.formato)) {
      throw new ArtefatoEntregavelInvalidoError(`O agente ${gerador.chave} não pode gerar ${proposta.formato}.`);
    }
    let artefato: ArtefatoEntregavelRenderizado;
    try {
      artefato = renderizarArtefatoEntregavel(proposta);
    } catch (erro) {
      throw new ArtefatoEntregavelInvalidoError(erro instanceof Error ? erro.message : 'Não foi possível renderizar o artefato.');
    }
    if (artefato.bytes > gerador.capacidades.maxBytesPorArtefato) {
      throw new ArtefatoEntregavelInvalidoError(`O arquivo ${artefato.nomeArquivo} excede o limite do agente gerador.`);
    }
    if (nomes.has(artefato.nomeArquivo)) {
      throw new ArtefatoEntregavelInvalidoError(`Nome de arquivo duplicado: ${artefato.nomeArquivo}.`);
    }
    nomes.add(artefato.nomeArquivo);
    return artefato;
  });
}
