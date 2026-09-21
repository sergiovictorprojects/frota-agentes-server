import { escaparHtml } from '../../util/html.ts';

// Marca um trecho que já é HTML seguro. Tudo o que entra num template `html` sem esta marca é escapado.
export class Bruto {
  readonly valor: string;

  constructor(valor: string) {
    this.valor = valor;
  }
}

export function bruto(valor: string): Bruto {
  return new Bruto(valor);
}

function renderizar(valor: unknown): string {
  if (valor instanceof Bruto) return valor.valor;
  if (Array.isArray(valor)) return valor.map(renderizar).join('');
  if (valor === null || valor === undefined || valor === false) return '';
  return escaparHtml(String(valor));
}

// Template com escape automático: esquecer de escapar deixa de ser possível.
export function html(partes: TemplateStringsArray, ...valores: unknown[]): Bruto {
  let saida = partes[0] ?? '';
  for (let i = 0; i < valores.length; i++) saida += renderizar(valores[i]) + (partes[i + 1] ?? '');
  return new Bruto(saida);
}
