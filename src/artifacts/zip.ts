// ZIP mínimo, determinístico e sem compressão. É suficiente para os pacotes Open XML e para o formato ZIP
// final sem adicionar uma biblioteca binária ao servidor. Data fixa evita que o mesmo conteúdo ganhe hashes
// diferentes em execuções distintas.

export interface EntradaZip {
  nome: string;
  conteudo: Buffer | string;
}
const CRC32_TABELA = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(conteudo: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of conteudo) crc = CRC32_TABELA[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function cabecalhoLocal(nome: Buffer, conteudo: Buffer, crc: number): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(0x0800, 6);
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(0x0021, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(conteudo.length, 18);
  b.writeUInt32LE(conteudo.length, 22);
  b.writeUInt16LE(nome.length, 26);
  b.writeUInt16LE(0, 28);
  return b;
}

function cabecalhoCentral(nome: Buffer, conteudo: Buffer, crc: number, deslocamento: number): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(0, 12);
  b.writeUInt16LE(0x0021, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(conteudo.length, 20);
  b.writeUInt32LE(conteudo.length, 24);
  b.writeUInt16LE(nome.length, 28);
  b.writeUInt16LE(0, 30);
  b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE(0, 38);
  b.writeUInt32LE(deslocamento, 42);
  return b;
}

export function criarZip(entradas: readonly EntradaZip[]): Buffer {
  if (entradas.length === 0 || entradas.length > 100) throw new Error('ZIP precisa ter de 1 a 100 entradas.');
  const nomes = new Set<string>();
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;

  for (const entrada of entradas) {
    if (!entrada.nome || entrada.nome.startsWith('/') || entrada.nome.includes('\\') || entrada.nome.split('/').includes('..')) {
      throw new Error(`Nome inseguro no ZIP: ${entrada.nome}`);
    }
    if (nomes.has(entrada.nome)) throw new Error(`Nome duplicado no ZIP: ${entrada.nome}`);
    nomes.add(entrada.nome);
    const nome = Buffer.from(entrada.nome, 'utf8');
    const conteudo = typeof entrada.conteudo === 'string' ? Buffer.from(entrada.conteudo, 'utf8') : entrada.conteudo;
    const crc = crc32(conteudo);
    const local = Buffer.concat([cabecalhoLocal(nome, conteudo, crc), nome, conteudo]);
    locais.push(local);
    centrais.push(Buffer.concat([cabecalhoCentral(nome, conteudo, crc, deslocamento), nome]));
    deslocamento += local.length;
  }

  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  fim.writeUInt16LE(0, 20);
  return Buffer.concat([...locais, diretorio, fim]);
}
