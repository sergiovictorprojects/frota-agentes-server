import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nomeArquivoSeguro, renderizarArtefatoEntregavel } from '../../src/artifacts/renderizadores.ts';
import { FORMATOS_ENTREGAVEIS, METADADOS_FORMATOS_ENTREGAVEIS, type FormatoEntregavel } from '../../src/domain/artefatos-entregaveis.ts';

const CONTEUDO: Record<FormatoEntregavel, string> = {
  pdf: 'Relatório com acentuação\nSegunda linha',
  docx: 'Documento\nSegundo parágrafo',
  xlsx: '[{"Nome":"Ana","Total":10},{"Nome":"Bia","Total":20}]',
  pptx: '# Visão geral\nResumo\n---\n# Próximos passos\nExecutar',
  csv: 'nome,total\nAna,10',
  tsv: 'nome\ttotal\nAna\t10',
  json: '{"ok":true,"itens":[1,2]}',
  yaml: 'ok: true\nitens:\n  - 1',
  xml: '<resultado><ok>true</ok></resultado>',
  sql: 'SELECT 1;',
  txt: 'Texto simples',
  markdown: '# Título\nTexto',
  html: '<!doctype html><html><body><h1>Olá</h1></body></html>',
  svg: '<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="20">Oi</text></svg>',
  ics: 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR',
  vcf: 'BEGIN:VCARD\nVERSION:4.0\nFN:Ana\nEND:VCARD',
  zip: '{"leia-me.txt":"Olá","dados.json":"{\\"ok\\":true}"}',
};

describe('renderizadores de artefatos entregáveis', () => {
  it.each(FORMATOS_ENTREGAVEIS)('renderiza %s com nome, MIME, tamanho e hash coerentes', (formato) => {
    const a = renderizarArtefatoEntregavel({ nomeArquivo: 'Relatório Final.exe', formato, conteudo: CONTEUDO[formato] });
    expect(a.nomeArquivo).toBe(`relatorio-final.${METADADOS_FORMATOS_ENTREGAVEIS[formato].extensao}`);
    expect(a.mimeType).toBe(METADADOS_FORMATOS_ENTREGAVEIS[formato].mimeType);
    expect(a.bytes).toBe(a.conteudo.length);
    expect(a.sha256).toBe(createHash('sha256').update(a.conteudo).digest('hex'));
    expect(a.bytes).toBeGreaterThan(0);
  });

  it('produz assinaturas reais para PDF, Open XML e ZIP', () => {
    expect(renderizarArtefatoEntregavel({ nomeArquivo: 'x', formato: 'pdf', conteudo: 'x' }).conteudo.subarray(0, 5).toString()).toBe('%PDF-');
    for (const formato of ['docx', 'xlsx', 'pptx', 'zip'] as const) {
      expect(renderizarArtefatoEntregavel({ nomeArquivo: 'x', formato, conteudo: CONTEUDO[formato] }).conteudo.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
  });

  it('é determinístico para a mesma especificação', () => {
    const p = { nomeArquivo: 'Documento', formato: 'docx' as const, conteudo: 'Mesmo conteúdo' };
    expect(renderizarArtefatoEntregavel(p)).toEqual(renderizarArtefatoEntregavel(p));
  });

  it('neutraliza fórmula em planilha e recusa conteúdo ativo ou externo', () => {
    const csv = renderizarArtefatoEntregavel({ nomeArquivo: 'dados', formato: 'csv', conteudo: 'valor\n=1+1' });
    expect(csv.conteudo.toString('utf8')).toContain("'=1+1");
    expect(() => renderizarArtefatoEntregavel({ nomeArquivo: 'x', formato: 'svg', conteudo: '<svg><script>alert(1)</script></svg>' })).toThrow(/ativo/);
    expect(() => renderizarArtefatoEntregavel({ nomeArquivo: 'x', formato: 'html', conteudo: '<script src="https://evil.example/x.js"></script>' })).toThrow(/rede/);
    expect(() => renderizarArtefatoEntregavel({ nomeArquivo: 'x', formato: 'xml', conteudo: '<!DOCTYPE x><x/>' })).toThrow(/inseguro/);
  });

  it('não aceita caminho no nome e sempre impõe a extensão do formato', () => {
    expect(nomeArquivoSeguro('../../Meu Arquivo.PDF', 'json')).toBe('meu-arquivo.json');
  });
});
