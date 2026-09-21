import { LlmError } from '../llm/llm.ts';
import { FrotaPausadaError, OrcamentoExcedidoError } from '../llm/orcamento.ts';

// Estados HTTP que apontam para a conta, o serviço ou o momento, e não para o conteúdo da demanda.
const STATUS_DE_SISTEMA = new Set([401, 402, 403, 404, 408, 429]);

export interface Interrupcao {
  motivo: string;
  status: 'pausada' | 'erro';
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
