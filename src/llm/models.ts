export interface Uso {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Preço em USD por milhão de tokens, como texto decimal (o caminho do teto de custo faz a conta em decimal, sem
// ponto flutuante: src/llm/reserva.ts). Janela de contexto e saída máxima em tokens.
export interface Modelo {
  entrada: string;
  saida: string;
  janelaTokens: number;
  maxSaidaTokens: number;
}

// Tabela fechada dos modelos da API da Anthropic. Reconferir na documentação oficial a cada troca de modelo:
// preços em platform.claude.com/docs/en/about-claude/pricing; janela e saída máxima em
// platform.claude.com/docs/en/build-with-claude/context-windows e nas páginas de cada modelo.
export const MODELOS_VERIFICADOS_EM = '2026-09-29';

const MODELOS: Readonly<Record<string, Modelo>> = {
  'claude-fable-5-1': { entrada: '10', saida: '50', janelaTokens: 1_000_000, maxSaidaTokens: 128_000 },
  'claude-opus-5': { entrada: '5', saida: '25', janelaTokens: 1_000_000, maxSaidaTokens: 128_000 },
  'claude-sonnet-5': { entrada: '2', saida: '10', janelaTokens: 1_000_000, maxSaidaTokens: 128_000 },
  'claude-haiku-4-5': { entrada: '1', saida: '5', janelaTokens: 200_000, maxSaidaTokens: 64_000 },
};

// Escrita no cache de 5 minutos custa 1,25x a entrada; leitura do cache custa 0,1x. A documentação cobra menos
// na leitura do cache de alguns modelos (0,025x no Fable 5.1): 0,1x superestima, nunca subestima.
export const MULTIPLICADOR_CACHE_ESCRITA = '1.25';
export const MULTIPLICADOR_CACHE_LEITURA = '0.1';

export class ModeloDesconhecidoError extends Error {
  constructor(modelo: string) {
    super(`Modelo sem preço cadastrado: ${modelo}. Não é possível contabilizar o custo.`);
    this.name = 'ModeloDesconhecidoError';
  }
}

export function modeloConhecido(modelo: string): boolean {
  return Object.hasOwn(MODELOS, modelo);
}

// Falha de forma fechada: sem preço e janela cadastrados não há como respeitar o teto de gasto nem o limite do
// prompt.
export function dadosDoModelo(modelo: string): Modelo {
  if (!Object.hasOwn(MODELOS, modelo)) throw new ModeloDesconhecidoError(modelo);
  return MODELOS[modelo]!;
}

// Custo em ponto flutuante do fluxo legado (demandas sem envelope), igual ao de antes da tabela ganhar a janela:
// os preços são inteiros, então Number() devolve exatamente os mesmos valores.
export function custoUsd(modelo: string, uso: Uso): number {
  const m = dadosDoModelo(modelo);
  const entrada =
    uso.inputTokens +
    uso.cacheWriteTokens * Number(MULTIPLICADOR_CACHE_ESCRITA) +
    uso.cacheReadTokens * Number(MULTIPLICADOR_CACHE_LEITURA);
  return (entrada * Number(m.entrada) + uso.outputTokens * Number(m.saida)) / 1_000_000;
}
