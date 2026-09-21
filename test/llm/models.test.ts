import { describe, expect, it } from 'vitest';
import { custoUsd, modeloConhecido, ModeloDesconhecidoError } from '../../src/llm/models.ts';

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('custoUsd', () => {
  it('cobra entrada e saida pelo preco por milhao de tokens do modelo', () => {
    expect(custoUsd('claude-sonnet-5', { ...zero, inputTokens: 1_000_000 })).toBeCloseTo(2, 9);
    expect(custoUsd('claude-sonnet-5', { ...zero, outputTokens: 1_000_000 })).toBeCloseTo(10, 9);
    expect(custoUsd('claude-opus-5', { ...zero, inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(30, 9);
    expect(custoUsd('claude-haiku-4-5', { ...zero, inputTokens: 2_000_000 })).toBeCloseTo(2, 9);
  });

  it('cobra 1,25x a entrada na escrita do cache e 0,1x na leitura', () => {
    expect(custoUsd('claude-sonnet-5', { ...zero, cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5, 9);
    expect(custoUsd('claude-sonnet-5', { ...zero, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2, 9);
  });

  it('soma todas as parcelas de uma chamada real', () => {
    const uso = { inputTokens: 40_000, outputTokens: 6_000, cacheReadTokens: 10_000, cacheWriteTokens: 5_000 };
    // (40000 + 5000*1.25 + 10000*0.1) * 2/1e6 + 6000 * 10/1e6
    expect(custoUsd('claude-sonnet-5', uso)).toBeCloseTo(0.09450 + 0.06, 6);
  });

  it('custa zero quando nao houve uso', () => {
    expect(custoUsd('claude-sonnet-5', zero)).toBe(0);
  });

  it('recusa modelo sem preco cadastrado em vez de assumir um valor', () => {
    expect(() => custoUsd('modelo-inventado', zero)).toThrowError(ModeloDesconhecidoError);
  });
});

describe('modeloConhecido', () => {
  it('reconhece os modelos cadastrados e rejeita o resto, inclusive nomes herdados de Object', () => {
    expect(modeloConhecido('claude-sonnet-5')).toBe(true);
    expect(modeloConhecido('gpt-5')).toBe(false);
    expect(modeloConhecido('toString')).toBe(false);
    expect(modeloConhecido('__proto__')).toBe(false);
  });
});
