import { SETORES, type Categoria } from '../domain/setores.ts';
import type { ResultadoAuditoriaBruto } from './schemas.ts';

export type Gravidade = ResultadoAuditoriaBruto['violacoes'][number]['gravidade'];

export interface ViolacaoAuditada {
  regra: string;
  evidencia: string;
  gravidade: Gravidade;
}

export interface MetricasAuditoria {
  antipadroesCount: number;
  regrasCumpridasPercent: number;
  violacoes: ViolacaoAuditada[];
  // Citações do auditor sem regra reconhecida ou sem evidência concreta. Não entram na contagem, mas
  // ficam registradas: descartar em silêncio faria o relatório mostrar conformidade que ninguém conferiu.
  violacoesDescartadas: number;
  observacoes: string;
}

const EVIDENCIA_MINIMA = 10;
const REGRA_MINIMA = 15;
const PESO_AUTOAVALIACAO = 0.5;

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[\s.;:,!?"'“”‘’()…]+/g, ' ')
    .trim();
}

// O auditor copia a regra "literalmente", mas pequenas variações de caixa e pontuação não devem
// fazer uma violação real sumir da contagem.
export function casarRegra(reportada: string, regras: readonly string[]): string | null {
  const r = normalizar(reportada);
  if (r.length < REGRA_MINIMA) return null;
  for (const regra of regras) {
    const n = normalizar(regra);
    if (n === r || n.includes(r) || r.includes(n)) return regra;
  }
  return null;
}

export function regrasDosSetores(categorias: readonly Categoria[]): string[] {
  return [...new Set(categorias.flatMap((c) => SETORES[c].regras))];
}

// Só contam violações que citam uma regra realmente em vigor e trazem evidência concreta:
// o número vem da lista verificada, nunca de um valor que o modelo escolheu.
export function calcularAuditoria(regras: readonly string[], bruto: ResultadoAuditoriaBruto): MetricasAuditoria {
  const vistas = new Set<string>();
  const violacoes: ViolacaoAuditada[] = [];
  let descartadas = 0;
  for (const v of bruto.violacoes) {
    const regra = casarRegra(v.regra, regras);
    const evidencia = v.evidencia.trim();
    if (!regra || evidencia.length < EVIDENCIA_MINIMA) {
      descartadas++;
      continue;
    }
    const chave = `${regra}|${normalizar(evidencia)}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    violacoes.push({ regra, evidencia, gravidade: v.gravidade });
  }

  const regrasViolada = new Set(violacoes.map((v) => v.regra));
  const cumpridas = regras.length === 0 ? 100 : Math.round((100 * (regras.length - regrasViolada.size)) / regras.length);
  return {
    antipadroesCount: violacoes.length,
    regrasCumpridasPercent: cumpridas,
    violacoes,
    violacoesDescartadas: descartadas,
    observacoes: bruto.observacoes,
  };
}

export function indiceGeral(autoavaliacao: number, regrasCumpridasPercent: number): number {
  return Math.round(PESO_AUTOAVALIACAO * autoavaliacao + (1 - PESO_AUTOAVALIACAO) * regrasCumpridasPercent);
}
