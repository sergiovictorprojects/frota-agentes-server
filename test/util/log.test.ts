import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, mensagemDeErro } from '../../src/util/log.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log', () => {
  it('escreve uma linha JSON com data, nivel, tipo e os dados', () => {
    const saida = vi.spyOn(console, 'log').mockImplementation(() => {});
    log('info', 'servico_iniciado', { porta: 3000 });
    const linha = JSON.parse(saida.mock.calls[0]![0] as string);
    expect(linha).toMatchObject({ nivel: 'info', tipo: 'servico_iniciado', porta: 3000 });
    expect(new Date(linha.ts).toString()).not.toBe('Invalid Date');
  });

  it('envia nivel erro para stderr e os demais para stdout', () => {
    const saida = vi.spyOn(console, 'log').mockImplementation(() => {});
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    log('erro', 'falha');
    log('aviso', 'atencao');
    expect(erro).toHaveBeenCalledTimes(1);
    expect(saida).toHaveBeenCalledTimes(1);
  });
});

describe('mensagemDeErro', () => {
  it('usa a mensagem de um Error', () => {
    expect(mensagemDeErro(new Error('boom'))).toBe('boom');
  });

  it('serializa objetos que nao sao Error em vez de mostrar [object Object]', () => {
    expect(mensagemDeErro({ code: 'X', detalhe: 1 })).toBe('{"code":"X","detalhe":1}');
  });

  it('nao quebra com objetos circulares', () => {
    const circular: Record<string, unknown> = {};
    circular.eu = circular;
    expect(mensagemDeErro(circular)).toBe('[object Object]');
  });

  it('converte valores simples em texto', () => {
    expect(mensagemDeErro('falhou')).toBe('falhou');
    expect(mensagemDeErro(42)).toBe('42');
    expect(mensagemDeErro(null)).toBe('null');
    expect(mensagemDeErro(undefined)).toBe('undefined');
  });
});
