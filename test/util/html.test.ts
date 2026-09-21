import { describe, expect, it } from 'vitest';
import { escaparHtml, paginaDeTexto } from '../../src/util/html.ts';

describe('escaparHtml', () => {
  it('escapa os cinco caracteres perigosos', () => {
    expect(escaparHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('nao altera texto comum nem acentos', () => {
    expect(escaparHtml('Análise de estoque 📦')).toBe('Análise de estoque 📦');
  });

  it('nao escapa duas vezes uma entidade ja escapada por engano do chamador', () => {
    expect(escaparHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('paginaDeTexto', () => {
  it('gera um documento completo em portugues com titulo e corpo', () => {
    const html = paginaDeTexto('Relatório', 'linha 1\nlinha 2');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain('<title>Relatório</title>');
    expect(html).toContain('<pre>linha 1\nlinha 2</pre>');
  });

  it('neutraliza marcacao e scripts no titulo e no corpo', () => {
    const html = paginaDeTexto('<script>alert(1)</script>', '<img src=x onerror=alert(2)>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });
});
