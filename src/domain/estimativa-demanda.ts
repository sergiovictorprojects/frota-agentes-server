import { custoUsd } from '../llm/models.ts';
import type { ResultadoEsperado } from './resultado-esperado.ts';
import type { Categoria } from './setores.ts';

export const COMPLEXIDADES_DEMANDA = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ComplexidadeDemanda = (typeof COMPLEXIDADES_DEMANDA)[number];

export const ROTULOS_COMPLEXIDADE_DEMANDA: Readonly<Record<ComplexidadeDemanda, string>> = {
  LOW: 'Baixa',
  MEDIUM: 'Média',
  HIGH: 'Alta',
};

export type ModoExecucaoEstimado = 'simples' | 'controlado' | 'completo';

export interface EstimativaUsoDemanda {
  complexidade: ComplexidadeDemanda;
  modoExecucao: ModoExecucaoEstimado;
  chamadasLlmMin: number;
  chamadasLlmMax: number;
  tokensEntradaEstimados: number;
  tokensSaidaEstimados: number;
  tokensTotaisEstimados: number;
  custoEstimadoUsd: string;
  orcamentoSugeridoUsd: string;
  modeloReferencia: string;
}

interface EntradaEstimativa {
  complexidade: ComplexidadeDemanda;
  resultadoEsperado: ResultadoEsperado;
  categoria: Categoria;
  descricao?: string;
  criteriosAceite?: string;
  referencias?: string | null;
}

interface PerfilComplexidade {
  modoExecucao: ModoExecucaoEstimado;
  chamadasMin: number;
  chamadasMax: number;
  entradaBase: number;
  saidaBase: number;
  orcamentoBaseUsd: number;
}

const MODELO_REFERENCIA = 'claude-sonnet-5';

const PERFIS: Readonly<Record<ComplexidadeDemanda, PerfilComplexidade>> = {
  LOW: {
    modoExecucao: 'simples',
    chamadasMin: 1,
    chamadasMax: 2,
    entradaBase: 8_000,
    saidaBase: 3_000,
    orcamentoBaseUsd: 1,
  },
  MEDIUM: {
    modoExecucao: 'controlado',
    chamadasMin: 3,
    chamadasMax: 5,
    entradaBase: 30_000,
    saidaBase: 12_000,
    orcamentoBaseUsd: 3,
  },
  HIGH: {
    modoExecucao: 'completo',
    chamadasMin: 6,
    chamadasMax: 9,
    entradaBase: 90_000,
    saidaBase: 32_000,
    orcamentoBaseUsd: 8,
  },
};

const AJUSTES_RESULTADO: Readonly<Record<ResultadoEsperado, { chamadas: number; entrada: number; saida: number; orcamentoUsd: number }>> = {
  outro: { chamadas: 0, entrada: 1, saida: 1, orcamentoUsd: 0 },
  analise: { chamadas: 0, entrada: 1, saida: 1, orcamentoUsd: 0 },
  documento: { chamadas: 0, entrada: 1.1, saida: 1.2, orcamentoUsd: 0.5 },
  interface: { chamadas: 1, entrada: 1.2, saida: 1.6, orcamentoUsd: 1 },
  automacao: { chamadas: 1, entrada: 1.25, saida: 1.35, orcamentoUsd: 1 },
  codigo: { chamadas: 1, entrada: 1.25, saida: 1.35, orcamentoUsd: 1 },
};

function tokensDeTexto(...partes: Array<string | null | undefined>): number {
  const caracteres = partes.filter(Boolean).join('\n').length;
  return Math.ceil(caracteres / 4);
}

function arredondarToken(valor: number): number {
  return Math.max(0, Math.ceil(valor / 100) * 100);
}

function usd2(valor: number): string {
  return Math.min(20, Math.max(1, valor)).toFixed(2);
}

function usd6(valor: number): string {
  return valor.toFixed(6);
}

export function estimarUsoDemanda(p: EntradaEstimativa): EstimativaUsoDemanda {
  const perfil = PERFIS[p.complexidade];
  const ajuste = AJUSTES_RESULTADO[p.resultadoEsperado];
  const tokensContexto = tokensDeTexto(p.descricao, p.criteriosAceite, p.referencias);
  const extraGestao = p.categoria === 'gestores' && p.resultadoEsperado !== 'outro' ? 1 : 0;
  const chamadasLlmMax = perfil.chamadasMax + ajuste.chamadas + extraGestao;
  const chamadasLlmMin = Math.min(chamadasLlmMax, perfil.chamadasMin + Math.floor((ajuste.chamadas + extraGestao) / 2));
  const tokensEntradaEstimados = arredondarToken((perfil.entradaBase + tokensContexto * Math.max(1, chamadasLlmMax * 0.7)) * ajuste.entrada);
  const tokensSaidaEstimados = arredondarToken(perfil.saidaBase * ajuste.saida);
  const custoEstimado = custoUsd(MODELO_REFERENCIA, {
    inputTokens: tokensEntradaEstimados,
    outputTokens: tokensSaidaEstimados,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const incrementoContextoUsd = Math.min(3, tokensContexto / 50_000);

  return {
    complexidade: p.complexidade,
    modoExecucao: perfil.modoExecucao,
    chamadasLlmMin,
    chamadasLlmMax,
    tokensEntradaEstimados,
    tokensSaidaEstimados,
    tokensTotaisEstimados: tokensEntradaEstimados + tokensSaidaEstimados,
    custoEstimadoUsd: usd6(custoEstimado),
    orcamentoSugeridoUsd: usd2(perfil.orcamentoBaseUsd + ajuste.orcamentoUsd + incrementoContextoUsd),
    modeloReferencia: MODELO_REFERENCIA,
  };
}

export function estimativaUsoValida(valor: unknown): valor is EstimativaUsoDemanda {
  if (typeof valor !== 'object' || valor === null) return false;
  const v = valor as Record<string, unknown>;
  return (
    typeof v.complexidade === 'string' &&
    (COMPLEXIDADES_DEMANDA as readonly string[]).includes(v.complexidade) &&
    typeof v.modoExecucao === 'string' &&
    ['simples', 'controlado', 'completo'].includes(v.modoExecucao) &&
    Number.isSafeInteger(v.chamadasLlmMin) &&
    Number.isSafeInteger(v.chamadasLlmMax) &&
    Number.isSafeInteger(v.tokensEntradaEstimados) &&
    Number.isSafeInteger(v.tokensSaidaEstimados) &&
    Number.isSafeInteger(v.tokensTotaisEstimados) &&
    typeof v.custoEstimadoUsd === 'string' &&
    typeof v.orcamentoSugeridoUsd === 'string' &&
    typeof v.modeloReferencia === 'string'
  );
}

export function normalizarEstimativaUso(valor: unknown, base: EntradaEstimativa): EstimativaUsoDemanda {
  return estimativaUsoValida(valor) ? valor : estimarUsoDemanda(base);
}

export function estimativasBasePorComplexidade(): EstimativaUsoDemanda[] {
  return COMPLEXIDADES_DEMANDA.map((complexidade) =>
    estimarUsoDemanda({ complexidade, resultadoEsperado: 'outro', categoria: 'd1' }),
  );
}
