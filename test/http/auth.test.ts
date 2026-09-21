import { describe, expect, it } from 'vitest';
import { credenciaisValidas, origemConfiavel } from '../../src/http/auth.ts';

const basic = (usuario: string, senha: string): string => `Basic ${Buffer.from(`${usuario}:${senha}`).toString('base64')}`;

describe('credenciaisValidas', () => {
  it('aceita usuario e senha corretos, inclusive com dois pontos e acentos na senha', () => {
    expect(credenciaisValidas(basic('frota', 'segredo-123'), 'frota', 'segredo-123')).toBe(true);
    expect(credenciaisValidas(basic('frota', 'a:b:ção'), 'frota', 'a:b:ção')).toBe(true);
  });

  it('rejeita senha errada, usuario errado e as duas coisas erradas', () => {
    expect(credenciaisValidas(basic('frota', 'errada'), 'frota', 'segredo-123')).toBe(false);
    expect(credenciaisValidas(basic('outro', 'segredo-123'), 'frota', 'segredo-123')).toBe(false);
    expect(credenciaisValidas(basic('outro', 'errada'), 'frota', 'segredo-123')).toBe(false);
  });

  it('rejeita cabecalho ausente, de outro esquema ou mal formado', () => {
    expect(credenciaisValidas(undefined, 'frota', 'x')).toBe(false);
    expect(credenciaisValidas('Bearer abc', 'frota', 'x')).toBe(false);
    expect(credenciaisValidas('Basic ', 'frota', 'x')).toBe(false);
    expect(credenciaisValidas(`Basic ${Buffer.from('semdoispontos').toString('base64')}`, 'frota', 'x')).toBe(false);
  });

  it('nao confunde senha que e prefixo da correta', () => {
    expect(credenciaisValidas(basic('frota', 'segredo'), 'frota', 'segredo-123')).toBe(false);
  });
});

describe('origemConfiavel', () => {
  it('confia em Sec-Fetch-Site same-origin e none, e rejeita cross-site e same-site', () => {
    expect(origemConfiavel({ secFetchSite: 'same-origin' })).toBe(true);
    expect(origemConfiavel({ secFetchSite: 'none' })).toBe(true);
    expect(origemConfiavel({ secFetchSite: 'cross-site' })).toBe(false);
    expect(origemConfiavel({ secFetchSite: 'same-site' })).toBe(false);
  });

  it('sem Sec-Fetch-Site, compara o host da Origin com o Host da requisicao', () => {
    expect(origemConfiavel({ origin: 'https://frota.exemplo.com', host: 'frota.exemplo.com' })).toBe(true);
    expect(origemConfiavel({ origin: 'https://evil.example', host: 'frota.exemplo.com' })).toBe(false);
    expect(origemConfiavel({ origin: 'null', host: 'frota.exemplo.com' })).toBe(false);
  });

  it('Sec-Fetch-Site tem prioridade sobre Origin', () => {
    expect(origemConfiavel({ secFetchSite: 'cross-site', origin: 'https://frota.exemplo.com', host: 'frota.exemplo.com' })).toBe(false);
  });

  it('sem nenhuma dessas informacoes a chamada nao vem de um navegador', () => {
    expect(origemConfiavel({ host: 'frota.exemplo.com' })).toBe(true);
  });
});
