import { createHash } from 'node:crypto';
import {
  MAX_BYTES_ARTEFATO_ENTREGAVEL,
  METADADOS_FORMATOS_ENTREGAVEIS,
  type ArtefatoEntregavelProposto,
  type ArtefatoEntregavelRenderizado,
  type FormatoEntregavel,
} from '../domain/artefatos-entregaveis.ts';
import { criarZip, type EntradaZip } from './zip.ts';

const CONTROLE_PROIBIDO_RE = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const SUBSTITUTO_SOLTO_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function textoSeguro(texto: string): string {
  if (CONTROLE_PROIBIDO_RE.test(texto) || SUBSTITUTO_SOLTO_RE.test(texto)) {
    throw new Error('O conteúdo contém caracteres inválidos ou de controle.');
  }
  return texto.replace(/\r\n?/g, '\n');
}

function escaparXml(valor: string): string {
  return valor.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function semExtensao(nome: string): string {
  const base = nome.trim().split(/[\\/]/).at(-1) ?? '';
  return base.replace(/\.[A-Za-z0-9]{1,10}$/, '');
}

export function nomeArquivoSeguro(nome: string, formato: FormatoEntregavel): string {
  const normalizado = semExtensao(nome)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  const base = normalizado && normalizado !== '..' ? normalizado : 'artefato';
  return `${base}.${METADADOS_FORMATOS_ENTREGAVEIS[formato].extensao}`;
}

function comNovaLinha(texto: string): Buffer {
  const normalizado = textoSeguro(texto);
  return Buffer.from(normalizado.endsWith('\n') ? normalizado : `${normalizado}\n`, 'utf8');
}

function json(texto: string): Buffer {
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    throw new Error('Conteúdo JSON inválido.');
  }
  return Buffer.from(`${JSON.stringify(valor, null, 2)}\n`, 'utf8');
}

const NOME_XML_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ENTIDADE_XML_RE = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

/** Validação deliberadamente sem DTD: aceita apenas XML autocontido e bem-formado. */
function xmlBemFormado(texto: string): boolean {
  const abertos: string[] = [];
  let raizes = 0;
  let i = 0;
  while (i < texto.length) {
    if (texto.startsWith('<!--', i)) {
      const fim = texto.indexOf('-->', i + 4);
      if (fim < 0 || texto.slice(i + 4, fim).includes('--')) return false;
      i = fim + 3;
      continue;
    }
    if (texto.startsWith('<![CDATA[', i)) {
      const fim = texto.indexOf(']]>', i + 9);
      if (fim < 0) return false;
      i = fim + 3;
      continue;
    }
    if (texto.startsWith('<?', i)) {
      const fim = texto.indexOf('?>', i + 2);
      if (fim < 0) return false;
      i = fim + 2;
      continue;
    }
    if (texto[i] !== '<') {
      const fim = texto.indexOf('<', i);
      const conteudo = texto.slice(i, fim < 0 ? texto.length : fim);
      if (ENTIDADE_XML_RE.test(conteudo) || (abertos.length === 0 && conteudo.trim())) return false;
      i = fim < 0 ? texto.length : fim;
      continue;
    }

    let fim = i + 1;
    let aspas: '"' | "'" | null = null;
    for (; fim < texto.length; fim++) {
      const caractere = texto[fim]!;
      if (aspas) {
        if (caractere === aspas) aspas = null;
      } else if (caractere === '"' || caractere === "'") {
        aspas = caractere;
      } else if (caractere === '>') break;
    }
    if (fim >= texto.length || aspas) return false;
    const bruto = texto.slice(i + 1, fim).trim();
    if (!bruto || bruto.startsWith('!')) return false;
    if (bruto.startsWith('/')) {
      const nome = bruto.slice(1).trim();
      if (!NOME_XML_RE.test(nome) || abertos.pop() !== nome) return false;
    } else {
      const fechaSozinho = bruto.endsWith('/');
      const corpo = (fechaSozinho ? bruto.slice(0, -1) : bruto).trim();
      const separador = corpo.search(/\s/);
      const nome = separador < 0 ? corpo : corpo.slice(0, separador);
      const atributos = separador < 0 ? '' : corpo.slice(separador).trim();
      if (!NOME_XML_RE.test(nome)) return false;
      const restante = atributos.replace(/(?:[A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"[^"]*"|'[^']*')\s*/g, '');
      if (restante || ENTIDADE_XML_RE.test(atributos)) return false;
      if (abertos.length === 0) raizes++;
      if (!fechaSozinho) abertos.push(nome);
    }
    i = fim + 1;
  }
  return abertos.length === 0 && raizes === 1;
}

function xml(texto: string): Buffer {
  const seguro = textoSeguro(texto).trim();
  if (!seguro.startsWith('<') || /<!DOCTYPE|<!ENTITY/i.test(seguro) || !xmlBemFormado(seguro)) {
    throw new Error('Conteúdo XML inválido ou inseguro.');
  }
  return Buffer.from(`${seguro}\n`, 'utf8');
}

function html(texto: string): Buffer {
  const seguro = textoSeguro(texto).trim();
  if (/<\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|portal|base|form|input|button|textarea|select|option)\b/i.test(seguro)
    || /\bon[a-z]+\s*=/i.test(seguro)
    || /\b(?:javascript|vbscript)\s*:/i.test(seguro)
    || /\b(?:src|href|action|formaction|poster)\s*=/i.test(seguro)
    || /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(seguro)
    || /(?:@import|url\s*\(|expression\s*\(|-moz-binding\s*:|behavior\s*:)/i.test(seguro)) {
    throw new Error('HTML entregável contém conteúdo ativo ou externo.');
  }
  const documento = /<!doctype\s+html|<html\b/i.test(seguro)
    ? seguro
    : `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Artefato</title></head><body><pre>${escaparXml(seguro)}</pre></body></html>`;
  return Buffer.from(`${documento}\n`, 'utf8');
}

function svg(texto: string): Buffer {
  const seguro = textoSeguro(texto).trim();
  if (!/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(seguro) || !/<\/svg>\s*$/i.test(seguro)) throw new Error('Conteúdo SVG inválido.');
  if (/<(?:script|foreignObject)\b|\bon\w+\s*=|@import\s+(?:url\s*\()?\s*["']?\s*(?:https?:|\/\/)|(?:href|src)\s*=\s*["']?\s*(?:https?:|data:|\/\/)|url\s*\(\s*["']?\s*(?:https?:|data:|\/\/)/i.test(seguro)) {
    throw new Error('SVG entregável contém conteúdo ativo ou externo.');
  }
  return Buffer.from(`${seguro}\n`, 'utf8');
}

function calendario(texto: string): Buffer {
  const linhas = textoSeguro(texto).trim().split('\n');
  const completo = linhas[0]?.toUpperCase() === 'BEGIN:VCALENDAR';
  const saida = completo ? linhas : ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Frota de Agentes//PT-BR', ...linhas, 'END:VCALENDAR'];
  if (saida.at(-1)?.toUpperCase() !== 'END:VCALENDAR') throw new Error('Calendário ICS sem END:VCALENDAR.');
  return Buffer.from(`${saida.join('\r\n')}\r\n`, 'utf8');
}

function vcard(texto: string): Buffer {
  const linhas = textoSeguro(texto).trim().split('\n');
  const completo = linhas[0]?.toUpperCase() === 'BEGIN:VCARD';
  const saida = completo ? linhas : ['BEGIN:VCARD', 'VERSION:4.0', ...linhas, 'END:VCARD'];
  if (saida.at(-1)?.toUpperCase() !== 'END:VCARD') throw new Error('Contato VCF sem END:VCARD.');
  return Buffer.from(`${saida.join('\r\n')}\r\n`, 'utf8');
}

function linhasDelimitadas(texto: string, delimitador: ',' | '\t'): string[][] {
  const seguro = textoSeguro(texto).trim();
  try {
    const valor: unknown = JSON.parse(seguro);
    if (Array.isArray(valor)) {
      if (valor.every((x) => Array.isArray(x))) return valor.map((x) => x.map((v) => String(v ?? '')));
      if (valor.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
        const objetos = valor as Record<string, unknown>[];
        const colunas = [...new Set(objetos.flatMap((x) => Object.keys(x)))];
        return [colunas, ...objetos.map((x) => colunas.map((c) => String(x[c] ?? '')))];
      }
    }
  } catch {
    // Conteúdo delimitado normal; continua abaixo.
  }

  const linhas: string[][] = [[]];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < seguro.length; i++) {
    const c = seguro[i]!;
    if (c === '"') {
      if (aspas && seguro[i + 1] === '"') {
        campo += '"';
        i++;
      } else aspas = !aspas;
    } else if (!aspas && c === delimitador) {
      linhas.at(-1)!.push(campo);
      campo = '';
    } else if (!aspas && c === '\n') {
      linhas.at(-1)!.push(campo);
      linhas.push([]);
      campo = '';
    } else campo += c;
  }
  if (aspas) throw new Error('Conteúdo delimitado tem aspas não fechadas.');
  linhas.at(-1)!.push(campo);
  return linhas;
}

function neutralizarFormula(valor: string): string {
  return /^[=+\-@]/.test(valor.trimStart()) ? `'${valor}` : valor;
}

function delimitado(texto: string, delimitador: ',' | '\t'): Buffer {
  const linhas = linhasDelimitadas(texto, delimitador);
  const escapar = (valor: string): string => {
    const seguro = neutralizarFormula(valor);
    if (delimitador === ',' && /[",\n]/.test(seguro)) return `"${seguro.replaceAll('"', '""')}"`;
    return seguro.replaceAll('\t', ' ').replaceAll('\n', ' ');
  };
  return Buffer.from(`${linhas.map((l) => l.map(escapar).join(delimitador)).join('\r\n')}\r\n`, 'utf8');
}

function linhasDoDocumento(texto: string, largura = 92): string[] {
  const saida: string[] = [];
  for (const paragrafo of textoSeguro(texto).split('\n')) {
    if (!paragrafo) {
      saida.push('');
      continue;
    }
    let restante = paragrafo;
    while (restante.length > largura) {
      let corte = restante.lastIndexOf(' ', largura);
      if (corte < largura / 2) corte = largura;
      saida.push(restante.slice(0, corte));
      restante = restante.slice(corte).trimStart();
    }
    saida.push(restante);
  }
  return saida;
}

function bytesPdf(texto: string): Buffer {
  const paginas = Array.from({ length: Math.max(1, Math.ceil(linhasDoDocumento(texto).length / 50)) }, (_, i) =>
    linhasDoDocumento(texto).slice(i * 50, i * 50 + 50),
  );
  const totalPaginas = paginas.length;
  const idFonte = 3 + totalPaginas * 2;
  const objetos = new Map<number, Buffer>();
  objetos.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
  const idsPaginas = paginas.map((_p, i) => 3 + i * 2);
  objetos.set(2, Buffer.from(`<< /Type /Pages /Kids [${idsPaginas.map((id) => `${id} 0 R`).join(' ')}] /Count ${totalPaginas} >>`, 'ascii'));
  const latin1Hex = (linha: string): string => {
    const simplificada = [...linha].map((c) => (c.codePointAt(0)! <= 255 ? c : '?')).join('');
    return Buffer.from(simplificada, 'latin1').toString('hex').toUpperCase();
  };
  paginas.forEach((linhas, i) => {
    const idPagina = 3 + i * 2;
    const idConteudo = idPagina + 1;
    const comandos = `BT\n/F1 10 Tf\n48 795 Td\n14 TL\n${linhas.map((l) => `<${latin1Hex(l)}> Tj T*`).join('\n')}\nET\n`;
    const fluxo = Buffer.from(comandos, 'ascii');
    objetos.set(idPagina, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${idFonte} 0 R >> >> /Contents ${idConteudo} 0 R >>`, 'ascii'));
    objetos.set(idConteudo, Buffer.concat([Buffer.from(`<< /Length ${fluxo.length} >>\nstream\n`, 'ascii'), fluxo, Buffer.from('endstream', 'ascii')]));
  });
  objetos.set(idFonte, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'ascii'));

  const partes: Buffer[] = [Buffer.from('%PDF-1.4\n%\x80\x81\x82\x83\n', 'latin1')];
  const offsets = [0];
  let tamanho = partes[0]!.length;
  for (let id = 1; id <= idFonte; id++) {
    offsets[id] = tamanho;
    const parte = Buffer.concat([Buffer.from(`${id} 0 obj\n`, 'ascii'), objetos.get(id)!, Buffer.from('\nendobj\n', 'ascii')]);
    partes.push(parte);
    tamanho += parte.length;
  }
  const inicioXref = tamanho;
  const xref = `xref\n0 ${idFonte + 1}\n0000000000 65535 f \n${offsets.slice(1).map((x) => `${String(x).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${idFonte + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  partes.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(partes);
}

const TIPOS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

function docx(texto: string): Buffer {
  const paragrafos = textoSeguro(texto)
    .split('\n')
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${escaparXml(p)}</w:t></w:r></w:p>`)
    .join('');
  return criarZip([
    { nome: '[Content_Types].xml', conteudo: `${TIPOS_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { nome: '_rels/.rels', conteudo: `${TIPOS_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { nome: 'word/document.xml', conteudo: `${TIPOS_XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragrafos}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>` },
  ]);
}

function nomeColuna(indice: number): string {
  let n = indice + 1;
  let r = '';
  while (n > 0) {
    n--;
    r = String.fromCharCode(65 + (n % 26)) + r;
    n = Math.floor(n / 26);
  }
  return r;
}

function xlsx(texto: string): Buffer {
  const linhas = linhasDelimitadas(texto, texto.includes('\t') ? '\t' : ',');
  const rows = linhas
    .map((linha, r) => `<row r="${r + 1}">${linha.map((v, c) => `<c r="${nomeColuna(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escaparXml(neutralizarFormula(v))}</t></is></c>`).join('')}</row>`)
    .join('');
  return criarZip([
    { nome: '[Content_Types].xml', conteudo: `${TIPOS_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { nome: '_rels/.rels', conteudo: `${TIPOS_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { nome: 'xl/workbook.xml', conteudo: `${TIPOS_XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { nome: 'xl/_rels/workbook.xml.rels', conteudo: `${TIPOS_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { nome: 'xl/worksheets/sheet1.xml', conteudo: `${TIPOS_XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` },
  ]);
}

function pptx(texto: string): Buffer {
  const slides = textoSeguro(texto).split(/\n---+\n/).map((bloco, i) => {
    const [primeira = `Slide ${i + 1}`, ...resto] = bloco.split('\n');
    return { titulo: primeira.replace(/^#+\s*/, '') || `Slide ${i + 1}`, corpo: resto.join('\n') };
  });
  const overrides = slides.map((_s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const ids = slides.map((_s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  const rels = slides.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('');
  const entradas: EntradaZip[] = [
    { nome: '[Content_Types].xml', conteudo: `${TIPOS_XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${overrides}</Types>` },
    { nome: '_rels/.rels', conteudo: `${TIPOS_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>` },
    { nome: 'ppt/presentation.xml', conteudo: `${TIPOS_XML}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { nome: 'ppt/_rels/presentation.xml.rels', conteudo: `${TIPOS_XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>` },
  ];
  slides.forEach((slide, i) => entradas.push({
    nome: `ppt/slides/slide${i + 1}.xml`,
    conteudo: `${TIPOS_XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Conteúdo"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="600000" y="500000"/><a:ext cx="11000000" cy="5800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="pt-BR" sz="2800" b="1"/><a:t>${escaparXml(slide.titulo)}</a:t></a:r></a:p><a:p><a:r><a:rPr lang="pt-BR" sz="1800"/><a:t>${escaparXml(slide.corpo)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  }));
  return criarZip(entradas);
}

function zip(texto: string): Buffer {
  let entradas: EntradaZip[] = [];
  try {
    const valor: unknown = JSON.parse(texto);
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      entradas = Object.entries(valor).map(([nome, conteudo]) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(nome) || nome.includes('..') || typeof conteudo !== 'string') {
          throw new Error('ZIP aceita um objeto JSON de nomes simples para conteúdos textuais.');
        }
        return { nome, conteudo: textoSeguro(conteudo) };
      });
    }
  } catch (erro) {
    if (erro instanceof SyntaxError) entradas = [];
    else throw erro;
  }
  return criarZip(entradas.length ? entradas : [{ nome: 'conteudo.txt', conteudo: textoSeguro(texto) }]);
}

function renderizarBytes(formato: FormatoEntregavel, conteudo: string): Buffer {
  switch (formato) {
    case 'pdf': return bytesPdf(conteudo);
    case 'docx': return docx(conteudo);
    case 'xlsx': return xlsx(conteudo);
    case 'pptx': return pptx(conteudo);
    case 'csv': return delimitado(conteudo, ',');
    case 'tsv': return delimitado(conteudo, '\t');
    case 'json': return json(conteudo);
    case 'xml': return xml(conteudo);
    case 'html': return html(conteudo);
    case 'svg': return svg(conteudo);
    case 'ics': return calendario(conteudo);
    case 'vcf': return vcard(conteudo);
    case 'zip': return zip(conteudo);
    case 'yaml':
    case 'sql':
    case 'txt':
    case 'markdown':
      return comNovaLinha(conteudo);
  }
}

export function renderizarArtefatoEntregavel(proposto: ArtefatoEntregavelProposto): ArtefatoEntregavelRenderizado {
  const conteudo = renderizarBytes(proposto.formato, proposto.conteudo);
  if (conteudo.length === 0 || conteudo.length > MAX_BYTES_ARTEFATO_ENTREGAVEL) {
    throw new Error(`Artefato ${proposto.formato} excede o limite de ${MAX_BYTES_ARTEFATO_ENTREGAVEL} bytes.`);
  }
  const metadados = METADADOS_FORMATOS_ENTREGAVEIS[proposto.formato];
  return {
    formato: proposto.formato,
    nomeArquivo: nomeArquivoSeguro(proposto.nomeArquivo, proposto.formato),
    mimeType: metadados.mimeType,
    conteudo,
    bytes: conteudo.length,
    sha256: createHash('sha256').update(conteudo).digest('hex'),
  };
}
