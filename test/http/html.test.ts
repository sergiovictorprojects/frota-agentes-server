import { describe, expect, it } from 'vitest';
import { bruto, html } from '../../src/http/ui/html.ts';

describe('html (template com escape automatico)', () => {
  it('escapa valores interpolados', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.valor).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapa aspas para nao permitir sair de um atributo', () => {
    expect(html`<a title="${'x" onmouseover="alert(1)'}">`.valor).toBe('<a title="x&quot; onmouseover=&quot;alert(1)">');
  });

  it('nao escapa duas vezes um trecho ja montado com html', () => {
    const interno = html`<b>${'a & b'}</b>`;
    expect(html`<p>${interno}</p>`.valor).toBe('<p><b>a &amp; b</b></p>');
  });

  it('renderiza listas, numeros e ignora null, undefined e false', () => {
    const itens = ['a', 'b<'].map((t) => html`<li>${t}</li>`);
    expect(html`<ul>${itens}</ul>${null}${undefined}${false}${7}`.valor).toBe('<ul><li>a</li><li>b&lt;</li></ul>7');
  });

  it('so confia em HTML explicitamente marcado como bruto', () => {
    expect(html`${bruto('<i>ok</i>')}`.valor).toBe('<i>ok</i>');
    expect(html`${'<i>ok</i>'}`.valor).toBe('&lt;i&gt;ok&lt;/i&gt;');
  });
});
