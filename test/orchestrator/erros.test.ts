import { describe, expect, it } from 'vitest';
import { LlmError } from '../../src/llm/llm.ts';
import { FrotaPausadaError, OrcamentoExcedidoError } from '../../src/llm/orcamento.ts';
import { ehParadaSistemica, statusDaInterrupcao } from '../../src/orchestrator/erros.ts';

const api = (status: number | null) => new LlmError('api', 'falha', null, status);

describe('ehParadaSistemica', () => {
  it('trata pausa e orcamento como falha de sistema', () => {
    expect(ehParadaSistemica(new FrotaPausadaError('manutencao'))).toBe(true);
    expect(ehParadaSistemica(new OrcamentoExcedidoError(10, 10))).toBe(true);
  });

  it.each([401, 402, 403, 404, 408, 429, 500, 502, 503, 529])('trata o status HTTP %i como falha de sistema', (status) => {
    expect(ehParadaSistemica(api(status))).toBe(true);
  });

  it('trata falha de conexao, sem status HTTP, como falha de sistema', () => {
    expect(ehParadaSistemica(api(null))).toBe(true);
  });

  it.each([400, 413, 422])('trata o status %i como culpa da demanda, para nao travar a fila atras dela', (status) => {
    expect(ehParadaSistemica(api(status))).toBe(false);
  });

  it('nao trata recusa, truncamento, resposta invalida nem erros comuns como falha de sistema', () => {
    expect(ehParadaSistemica(new LlmError('recusa', 'x'))).toBe(false);
    expect(ehParadaSistemica(new LlmError('truncado', 'x'))).toBe(false);
    expect(ehParadaSistemica(new LlmError('invalido', 'x'))).toBe(false);
    expect(ehParadaSistemica(new Error('qualquer'))).toBe(false);
    expect(ehParadaSistemica('texto')).toBe(false);
  });
});

describe('statusDaInterrupcao', () => {
  it('pausa quando o motivo e orcamento ou pausa manual, e erro nos demais casos', () => {
    expect(statusDaInterrupcao(new FrotaPausadaError('x'))).toBe('pausada');
    expect(statusDaInterrupcao(new OrcamentoExcedidoError(1, 1))).toBe('pausada');
    expect(statusDaInterrupcao(api(529))).toBe('erro');
  });
});
