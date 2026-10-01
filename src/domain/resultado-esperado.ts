import type { Categoria, Setor } from './setores.ts';

export const RESULTADOS_ESPERADOS = ['outro', 'interface', 'documento', 'analise', 'automacao', 'codigo'] as const;
export type ResultadoEsperado = (typeof RESULTADOS_ESPERADOS)[number];

export const ROTULOS_RESULTADO_ESPERADO: Readonly<Record<ResultadoEsperado, string>> = {
  outro: 'Outro / livre',
  interface: 'Interface, dashboard ou tela interativa',
  documento: 'Documento ou relatório',
  analise: 'Análise textual',
  automacao: 'Automação',
  codigo: 'Código',
};

export interface RegraRoteamento {
  decisao: 'permitir' | 'aguardar_humano';
  motivo: 'compativel' | 'categoria_incompativel' | 'criterios_ausentes';
  categoriaSugerida: Categoria | null;
}

export function categoriaSugeridaPara(resultado: ResultadoEsperado): Categoria | null {
  if (resultado === 'interface') return 'd11';
  if (resultado === 'documento' || resultado === 'analise') return 'd8';
  if (resultado === 'automacao') return 'd14';
  if (resultado === 'codigo') return 'd1';
  return null;
}

export function validarRoteamentoDemanda(p: {
  resultadoEsperado: ResultadoEsperado;
  criteriosAceite: string;
  categoria: Categoria;
  setor: Setor;
}): RegraRoteamento {
  if (p.resultadoEsperado === 'outro') return { decisao: 'permitir', motivo: 'compativel', categoriaSugerida: null };

  const categoriaSugerida = categoriaSugeridaPara(p.resultadoEsperado);
  const criterios = p.criteriosAceite.trim();
  if (!criterios) return { decisao: 'aguardar_humano', motivo: 'criterios_ausentes', categoriaSugerida };

  if (p.resultadoEsperado === 'interface' && !p.setor.podeEntregarHtml) {
    return { decisao: 'aguardar_humano', motivo: 'categoria_incompativel', categoriaSugerida };
  }

  return { decisao: 'permitir', motivo: 'compativel', categoriaSugerida };
}