import { describe, expect, it } from 'vitest';
import {
  classificarArtefatoExterno,
  hostLocal,
  hostReservado,
  problemaNaOrigemPublica,
  uuidCandidatoInterno,
} from '../../src/domain/links-entrega.ts';

const ORIGEM = 'https://frota.minhaempresa.com.br';
const ID = '0b5c7f0e-6a1d-4c35-9a52-3f1f4b6f8d21';

describe('hostReservado', () => {
  it.each([
    'exemplo.com',
    'frota.exemplo.com',
    'FROTA.EXEMPLO.COM.',
    'app.exemplo.com.br',
    'example.com',
    'www.example.net',
    'x.example.org',
    'frota.example',
    'frota.example.invalid',
    'algo.test',
    'app.localhost',
    'frota.seudominio.com.br',
    'yourdomain.com',
  ])('%s e reservado', (host) => expect(hostReservado(host)).toBe(true));

  it.each(['frota.minhaempresa.com.br', 'frota-app.up.railway.app', 'claude.ai', 'localhost', 'exemplo.com.evil.net', 'meuexemplo.com'])(
    '%s nao e reservado',
    (host) => expect(hostReservado(host)).toBe(false),
  );

  it('reconhece so os hosts de desenvolvimento local', () => {
    expect(['localhost', '127.0.0.1', '[::1]'].every(hostLocal)).toBe(true);
    expect(hostLocal('127.0.0.2')).toBe(false);
    expect(hostLocal('frota.localhost')).toBe(false);
  });
});

describe('problemaNaOrigemPublica', () => {
  it.each([
    'https://frota.minhaempresa.com.br',
    'https://frota.minhaempresa.com.br/',
    'https://frota-app.up.railway.app',
    'http://localhost:3000',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
  ])('aceita %s', (valor) => expect(problemaNaOrigemPublica(valor)).toBeNull());

  it.each([
    ['nao e URL', 'frota.minhaempresa.com.br'],
    ['esquema estranho', 'ftp://frota.minhaempresa.com.br'],
    ['http fora de localhost', 'http://frota.minhaempresa.com.br'],
    ['credenciais', 'https://usuario:senha@frota.minhaempresa.com.br'],
    ['caminho', 'https://frota.minhaempresa.com.br/app'],
    ['query', 'https://frota.minhaempresa.com.br/?x=1'],
    ['fragmento', 'https://frota.minhaempresa.com.br/#x'],
    ['placeholder do incidente', 'https://frota.exemplo.com'],
    ['exemplo do .env.example', 'https://frota.example.invalid'],
    ['example.com', 'https://example.com'],
    ['subdominio de example.org', 'https://app.example.org'],
    ['TLD .test', 'https://frota.test'],
    ['TLD .example', 'https://frota.example'],
    ['subdominio de localhost', 'https://frota.localhost'],
  ])('rejeita %s', (_caso, valor) => expect(problemaNaOrigemPublica(valor)).not.toBeNull());

  it('nunca cita o valor recebido na mensagem', () => {
    const valor = 'https://usuario:segredo123@frota.exemplo.com/caminho';
    expect(problemaNaOrigemPublica(valor)).not.toContain('segredo123');
    expect(problemaNaOrigemPublica(valor)).not.toContain('exemplo');
  });
});

describe('uuidCandidatoInterno', () => {
  it('aceita a origem configurada e o host de exemplo do incidente, com caminho exato', () => {
    expect(uuidCandidatoInterno(`${ORIGEM}/entregas/${ID}`, ORIGEM)).toBe(ID);
    expect(uuidCandidatoInterno(`https://frota.exemplo.com/entregas/${ID.toUpperCase()}`, ORIGEM)).toBe(ID);
    expect(uuidCandidatoInterno(`https://frota.example.invalid/entregas/${ID}`, ORIGEM)).toBe(ID);
  });

  it.each([
    ['nulo', null],
    ['vazio', ''],
    ['host arbitrario', `https://evil.attacker.net/entregas/${ID}`],
    ['protocol-relative', `//evil.attacker.net/entregas/${ID}`],
    ['relativo', `/entregas/${ID}`],
    ['javascript:', `javascript:alert('/entregas/${ID}')`],
    ['data:', `data:text/html,/entregas/${ID}`],
    ['sufixo no caminho', `${ORIGEM}/entregas/${ID}/conteudo`],
    ['prefixo no caminho', `${ORIGEM}/x/entregas/${ID}`],
    ['query', `${ORIGEM}/entregas/${ID}?x=1`],
    ['fragmento', `${ORIGEM}/entregas/${ID}#x`],
    ['credenciais', `https://u:p@frota.minhaempresa.com.br/entregas/${ID}`],
    ['uuid invalido', `${ORIGEM}/entregas/nao-e-uuid`],
    ['outra porta na origem', `https://frota.minhaempresa.com.br:8443/entregas/${ID}`],
    ['malformada', 'https://'],
  ])('rejeita %s', (_caso, url) => expect(uuidCandidatoInterno(url, ORIGEM)).toBeNull());
});

describe('classificarArtefatoExterno', () => {
  it('aceita so claude.ai em https', () => {
    expect(classificarArtefatoExterno('https://claude.ai/artifact/abc')).toEqual({ href: 'https://claude.ai/artifact/abc', host: 'claude.ai' });
  });

  it.each([
    null,
    'http://claude.ai/artifact/abc',
    'https://claude.ai.evil.net/artifact/abc',
    'https://evil.net/https://claude.ai/',
    'https://u:p@claude.ai/artifact/abc',
    '//claude.ai/artifact/abc',
    'javascript:alert(1)',
    'data:text/html,x',
    `${ORIGEM}/entregas/${ID}`,
  ])('rejeita %s', (url) => expect(classificarArtefatoExterno(url)).toBeNull());
});
