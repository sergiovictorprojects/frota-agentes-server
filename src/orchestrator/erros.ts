import type { CodigoErro } from '../db/eventos.ts';
import { LlmError } from '../llm/llm.ts';
import { FrotaPausadaError, OrcamentoExcedidoError } from '../llm/orcamento.ts';
import { PrazoRunExcedidoError } from './prazo-run.ts';

// Estados HTTP que apontam para a conta, o serviço ou o momento, e não para o conteúdo da demanda.
const STATUS_DE_SISTEMA = new Set([401, 402, 403, 404, 408, 429]);

export interface Interrupcao {
  motivo: string;
  status: 'pausada' | 'erro';
}

// Agente sem linha no catálogo, suspenso, ou só sob_demanda sem acionamento explícito. Determinístico
// para aquele agente — não é parada sistêmica (não interrompe a run inteira, só esta demanda), e retry
// só ajuda depois que um operador reativar o agente no catálogo.
export class AgenteNaoAutorizadoError extends Error {
  readonly chave: string;

  constructor(chave: string) {
    super(`Agente "${chave}" não está ativo no catálogo.`);
    this.name = 'AgenteNaoAutorizadoError';
    this.chave = chave;
  }
}

// Erro que não é culpa da demanda: tentar de novo mais tarde pode dar certo e a tentativa não conta.
// Um 400, 413 ou 422 é determinístico para aquele conteúdo: tratá-lo como falha de sistema repetiria o
// mesmo erro a cada execução e travaria a fila, porque a demanda problemática é sempre a mais antiga.
export function ehParadaSistemica(erro: unknown): boolean {
  if (erro instanceof FrotaPausadaError || erro instanceof OrcamentoExcedidoError) return true;
  if (!(erro instanceof LlmError) || erro.tipo !== 'api') return false;
  return erro.status === null || erro.status >= 500 || STATUS_DE_SISTEMA.has(erro.status);
}

export function statusDaInterrupcao(erro: unknown): 'pausada' | 'erro' {
  return erro instanceof FrotaPausadaError || erro instanceof OrcamentoExcedidoError ? 'pausada' : 'erro';
}

// Classifica qualquer erro num código fechado, para o ledger — nunca a mensagem do erro em si, que pode
// carregar detalhe interno ou fragmento da resposta do modelo.
export function codigoDoErro(erro: unknown): CodigoErro {
  if (erro instanceof OrcamentoExcedidoError) return 'orcamento_excedido';
  if (erro instanceof FrotaPausadaError) return 'frota_pausada';
  if (erro instanceof AgenteNaoAutorizadoError) return 'agente_nao_autorizado';
  if (erro instanceof PrazoRunExcedidoError) return 'prazo_da_run';
  if (erro instanceof LlmError) {
    if (erro.tipo === 'recusa') return 'llm_recusa';
    if (erro.tipo === 'truncado') return 'llm_truncado';
    if (erro.tipo === 'invalido') return 'llm_invalido';
    if (erro.tipo === 'timeout') return 'llm_timeout';
    return 'llm_api';
  }
  return 'falha_inesperada';
}
