export interface Uso {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// USD por milhão de tokens.
interface Preco {
  entrada: number;
  saida: number;
}

// Tabela de preços da API da Anthropic. Reconferir na documentação oficial a cada troca de modelo.
export const PRECOS_VERIFICADOS_EM = '2026-06-24';

const PRECOS: Readonly<Record<string, Preco>> = {
  'claude-fable-5-1': { entrada: 10, saida: 50 },
  'claude-opus-5': { entrada: 5, saida: 25 },
  'claude-sonnet-5': { entrada: 2, saida: 10 },
  'claude-haiku-4-5': { entrada: 1, saida: 5 },
};

// Escrita no cache de 5 minutos custa 1,25x a entrada; leitura do cache custa 0,1x.
const MULTIPLICADOR_CACHE_ESCRITA = 1.25;
const MULTIPLICADOR_CACHE_LEITURA = 0.1;

export class ModeloDesconhecidoError extends Error {
  constructor(modelo: string) {
    super(`Modelo sem preço cadastrado: ${modelo}. Não é possível contabilizar o custo.`);
    this.name = 'ModeloDesconhecidoError';
  }
}

export function modeloConhecido(modelo: string): boolean {
  return Object.hasOwn(PRECOS, modelo);
}

// Falha de forma fechada: sem preço conhecido não há como respeitar o teto de gasto.
export function custoUsd(modelo: string, uso: Uso): number {
  const preco = PRECOS[modelo];
  if (!preco) throw new ModeloDesconhecidoError(modelo);
  const entrada =
    uso.inputTokens +
    uso.cacheWriteTokens * MULTIPLICADOR_CACHE_ESCRITA +
    uso.cacheReadTokens * MULTIPLICADOR_CACHE_LEITURA;
  return (entrada * preco.entrada + uso.outputTokens * preco.saida) / 1_000_000;
}
