import { dadosDoModelo, MULTIPLICADOR_CACHE_ESCRITA, MULTIPLICADOR_CACHE_LEITURA, type Uso } from './models.ts';

// Fase 3.2a: custo e reserva em decimal, para o teto de custo por demanda (seção 6 do plano e ADR 0007). Nada de
// ponto flutuante neste caminho: preços chegam como texto decimal da tabela fechada, tokens e bytes são inteiros,
// e a conta é feita em bigint. O resultado é texto com 6 casas, a mesma escala de numeric(12,6) no banco.
// O fluxo legado (demandas sem envelope) continua com custoUsd, em ponto flutuante, como antes.

const CASAS_USD = 6;
const ESCALA_PRECO = 1_000_000n; // preço por milhão de tokens, com até 6 casas
const ESCALA_MULTIPLICADOR = 100n; // multiplicadores de cache, com até 2 casas
// micro-dólares = tokens × preço (USD por milhão de tokens); o preço e o multiplicador entram escalados.
const DIVISOR = ESCALA_PRECO * ESCALA_MULTIPLICADOR;

// Texto decimal não negativo ("2", "0.80", "1.25") para inteiro na escala pedida. Recusa sinal, expoente e casas
// além da escala, em vez de arredondar em silêncio.
export function decimalParaInteiro(texto: string, casas: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(texto);
  if (!m) throw new Error(`Valor decimal inválido: "${texto}".`);
  const fracao = m[2] ?? '';
  if (fracao.length > casas) throw new Error(`Valor com mais de ${casas} casas decimais: "${texto}".`);
  return BigInt(m[1]!) * 10n ** BigInt(casas) + BigInt(fracao.padEnd(casas, '0') || '0');
}

// Micro-dólares (inteiro) para texto com 6 casas: 123456n → "0.123456".
export function microParaUsd(micro: bigint): string {
  if (micro < 0n) throw new Error('Valor em dólar negativo.');
  const texto = micro.toString().padStart(CASAS_USD + 1, '0');
  return `${texto.slice(0, -CASAS_USD)}.${texto.slice(-CASAS_USD)}`;
}

export function usdParaMicro(usd: string): bigint {
  return decimalParaInteiro(usd, CASAS_USD);
}

function inteiroNaoNegativo(nome: string, valor: number): bigint {
  if (!Number.isSafeInteger(valor) || valor < 0) throw new Error(`${nome} precisa ser um inteiro não negativo.`);
  return BigInt(valor);
}

function precos(modelo: string): { entrada: bigint; saida: bigint } {
  const m = dadosDoModelo(modelo);
  return { entrada: decimalParaInteiro(m.entrada, 6), saida: decimalParaInteiro(m.saida, 6) };
}

// Custo real de uma chamada, arredondado para o mais próximo (metade para cima), com 6 casas. Mesma regra de
// custoUsd: escrita no cache a 1,25x a entrada, leitura a 0,1x.
export function custoRealUsd(modelo: string, uso: Uso): string {
  const p = precos(modelo);
  const escrita = decimalParaInteiro(MULTIPLICADOR_CACHE_ESCRITA, 2);
  const leitura = decimalParaInteiro(MULTIPLICADOR_CACHE_LEITURA, 2);
  const entrada =
    inteiroNaoNegativo('inputTokens', uso.inputTokens) * ESCALA_MULTIPLICADOR +
    inteiroNaoNegativo('cacheWriteTokens', uso.cacheWriteTokens) * escrita +
    inteiroNaoNegativo('cacheReadTokens', uso.cacheReadTokens) * leitura;
  const numerador = entrada * p.entrada + inteiroNaoNegativo('outputTokens', uso.outputTokens) * ESCALA_MULTIPLICADOR * p.saida;
  return microParaUsd((numerador + DIVISOR / 2n) / DIVISOR);
}

// Reserva de uma chamada, arredondada para cima: (bytes de entrada) × preço de entrada × 1,25 + max_tokens × preço
// de saída. Cada token tem pelo menos um byte, então contar bytes nunca subestima a entrada; o 1,25 cobre a
// entrada inteira escrita no cache. bytesEntrada já inclui sistema, usuário serializado, schema e a margem
// (medirEntrada em src/orchestrator/serializacao.ts). Modelo sem preço ou max_tokens acima da saída máxima do
// modelo falham antes de qualquer reserva.
export function reservaUsd(modelo: string, c: { bytesEntrada: number; maxTokens: number }): string {
  const p = precos(modelo);
  const maxTokens = inteiroNaoNegativo('maxTokens', c.maxTokens);
  if (maxTokens === 0n || maxTokens > BigInt(dadosDoModelo(modelo).maxSaidaTokens)) {
    throw new Error(`max_tokens fora do permitido para ${modelo}.`);
  }
  const escrita = decimalParaInteiro(MULTIPLICADOR_CACHE_ESCRITA, 2);
  const numerador =
    inteiroNaoNegativo('bytesEntrada', c.bytesEntrada) * escrita * p.entrada + maxTokens * ESCALA_MULTIPLICADOR * p.saida;
  return microParaUsd((numerador + DIVISOR - 1n) / DIVISOR);
}
