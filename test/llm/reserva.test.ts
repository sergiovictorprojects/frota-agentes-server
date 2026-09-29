import { describe, expect, it } from 'vitest';
import { custoUsd, dadosDoModelo, ModeloDesconhecidoError, type Uso } from '../../src/llm/models.ts';
import { custoRealUsd, decimalParaInteiro, microParaUsd, reservaUsd, usdParaMicro } from '../../src/llm/reserva.ts';

const zero: Uso = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('decimal sem ponto flutuante', () => {
  it('converte texto decimal para inteiro na escala pedida', () => {
    expect(decimalParaInteiro('2', 6)).toBe(2_000_000n);
    expect(decimalParaInteiro('0.80', 2)).toBe(80n);
    expect(decimalParaInteiro('1.25', 2)).toBe(125n);
    expect(decimalParaInteiro('0.000001', 6)).toBe(1n);
    expect(decimalParaInteiro('20.00', 2)).toBe(2000n);
  });

  it('recusa sinal, expoente, casas demais e texto que nao e numero, em vez de arredondar em silencio', () => {
    for (const texto of ['-1', '+1', '1e3', '1.', '.5', '1.234', 'abc', '', ' 1', '1,5', 'NaN', 'Infinity', '0x10']) {
      expect(() => decimalParaInteiro(texto, 2), texto).toThrow();
    }
  });

  it('micro-dolares viram texto com 6 casas e voltam iguais', () => {
    expect(microParaUsd(0n)).toBe('0.000000');
    expect(microParaUsd(1n)).toBe('0.000001');
    expect(microParaUsd(154_500n)).toBe('0.154500');
    expect(microParaUsd(12_345_678n)).toBe('12.345678');
    expect(usdParaMicro('0.1545')).toBe(154_500n);
    expect(usdParaMicro(microParaUsd(987_654_321n))).toBe(987_654_321n);
    expect(() => microParaUsd(-1n)).toThrow();
  });
});

describe('custoRealUsd (decimal, arredondado para o mais proximo)', () => {
  it('bate com o custo em ponto flutuante do legado numa chamada real', () => {
    const uso = { inputTokens: 40_000, outputTokens: 6_000, cacheReadTokens: 10_000, cacheWriteTokens: 5_000 };
    // (40000 + 5000*1.25 + 10000*0.1) * 2/1e6 + 6000 * 10/1e6 = 0.0945 + 0.06
    expect(custoRealUsd('claude-sonnet-5', uso)).toBe('0.154500');
    expect(custoRealUsd('claude-sonnet-5', zero)).toBe('0.000000');
  });

  it('arredonda meio micro-dolar para cima, e menos que meio para baixo', () => {
    // Haiku 4.5: US$ 1 por milhão na entrada; a leitura do cache custa 0,1x, ou seja, 0,1 micro-dólar por token.
    expect(custoRealUsd('claude-haiku-4-5', { ...zero, cacheReadTokens: 4 })).toBe('0.000000');
    expect(custoRealUsd('claude-haiku-4-5', { ...zero, cacheReadTokens: 5 })).toBe('0.000001');
    expect(custoRealUsd('claude-haiku-4-5', { ...zero, cacheReadTokens: 15 })).toBe('0.000002');
  });

  it('fica a meio micro-dolar do custo em ponto flutuante, para qualquer uso', () => {
    let semente = 7;
    const aleatorio = (max: number) => {
      semente = (semente * 1_103_515_245 + 12_345) % 2_147_483_648;
      return semente % max;
    };
    for (const modelo of ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      for (let i = 0; i < 200; i++) {
        const uso = {
          inputTokens: aleatorio(300_000),
          outputTokens: aleatorio(64_000),
          cacheReadTokens: aleatorio(100_000),
          cacheWriteTokens: aleatorio(100_000),
        };
        expect(Math.abs(Number(custoRealUsd(modelo, uso)) - custoUsd(modelo, uso))).toBeLessThanOrEqual(0.0000005 + 1e-12);
      }
    }
  });

  it('recusa modelo sem preco e contagem de tokens invalida', () => {
    expect(() => custoRealUsd('modelo-inventado', zero)).toThrowError(ModeloDesconhecidoError);
    expect(() => custoRealUsd('claude-sonnet-5', { ...zero, inputTokens: -1 })).toThrow(/inteiro não negativo/);
    expect(() => custoRealUsd('claude-sonnet-5', { ...zero, outputTokens: 1.5 })).toThrow(/inteiro não negativo/);
  });
});

describe('reservaUsd (decimal, arredondada para cima)', () => {
  it('reserva a entrada inteira como escrita no cache (1,25x) mais max_tokens de saida', () => {
    // 1000 bytes × US$ 2 × 1,25 / 1e6 + 2000 × US$ 10 / 1e6
    expect(reservaUsd('claude-sonnet-5', { bytesEntrada: 1_000, maxTokens: 2_000 })).toBe('0.022500');
    // Planejamento com o prompt de usuário no limite (seção 6.8 do plano): 262.144 + 4.096 bytes.
    expect(reservaUsd('claude-sonnet-5', { bytesEntrada: 266_240, maxTokens: 2_000 })).toBe('0.685600');
  });

  it('arredonda qualquer fracao de micro-dolar para cima', () => {
    // 1 byte × US$ 1 × 1,25 / 1e6 + 1 token × US$ 5 / 1e6 = 6,25 micro-dólares.
    expect(reservaUsd('claude-haiku-4-5', { bytesEntrada: 1, maxTokens: 1 })).toBe('0.000007');
  });

  it('nunca fica abaixo do custo real de uma chamada que caiba na reserva', () => {
    // Cada token tem pelo menos um byte: com todos os tokens de entrada contidos nos bytes e a saída em
    // max_tokens, o custo real nunca passa da reserva, qualquer que seja a mistura de cache.
    const casos: [number, Uso][] = [
      [10_000, { inputTokens: 10_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      [10_000, { inputTokens: 0, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 10_000 }],
      [10_000, { inputTokens: 3_000, outputTokens: 4_000, cacheReadTokens: 3_000, cacheWriteTokens: 4_000 }],
    ];
    for (const [bytesEntrada, uso] of casos) {
      const reserva = usdParaMicro(reservaUsd('claude-sonnet-5', { bytesEntrada, maxTokens: 4_000 }));
      expect(usdParaMicro(custoRealUsd('claude-sonnet-5', uso))).toBeLessThanOrEqual(reserva);
    }
  });

  it('falha antes de qualquer reserva com modelo sem preco ou max_tokens fora da saida maxima do modelo', () => {
    expect(() => reservaUsd('modelo-inventado', { bytesEntrada: 1, maxTokens: 1 })).toThrowError(ModeloDesconhecidoError);
    expect(() => reservaUsd('claude-sonnet-5', { bytesEntrada: 1, maxTokens: 0 })).toThrow(/max_tokens fora do permitido/);
    expect(() => reservaUsd('claude-sonnet-5', { bytesEntrada: 1, maxTokens: 128_001 })).toThrow(/max_tokens fora do permitido/);
    expect(() => reservaUsd('claude-haiku-4-5', { bytesEntrada: 1, maxTokens: 64_001 })).toThrow(/max_tokens fora do permitido/);
    expect(reservaUsd('claude-haiku-4-5', { bytesEntrada: 0, maxTokens: dadosDoModelo('claude-haiku-4-5').maxSaidaTokens })).toBe(
      '0.320000',
    );
    expect(() => reservaUsd('claude-sonnet-5', { bytesEntrada: -1, maxTokens: 1 })).toThrow(/inteiro não negativo/);
  });
});
