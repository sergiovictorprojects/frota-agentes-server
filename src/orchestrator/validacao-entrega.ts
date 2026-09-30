import type { Demanda } from '../db/demandas.ts';
import type { Setor } from '../domain/setores.ts';
import type { ResultadoExecucao } from './schemas.ts';

export type TipoEntregaEsperada = 'livre' | 'html_interativo';

export interface EntregaEsperada {
  tipo: TipoEntregaEsperada;
  motivo: string | null;
}

export type ValidacaoEntrega = { valida: true } | { valida: false; motivo: string; instrucaoCorrecao: string };

const TERMOS_INTERATIVOS = [
  /\bdashboard(s)?\b/,
  /\binterface(s)?\b/,
  /\btela(s)?\b/,
  /\bapp(s)?\b/,
  /\baplicativo(s)?\b/,
  /\baplicac(?:a|o|ao|oes|ões)\b/,
  /\bplataforma(s)?\b/,
  /\bsistema (web|interativo|com tela|com dashboard)\b/,
  /\bportal(is)?\b/,
  /\bsite(s)?\b/,
  /\blanding page(s)?\b/,
  /\bfront[- ]?end\b/,
  /\bprototipo(s)?\b/,
  /\bprotótipo(s)?\b/,
  /\btela interativa\b/,
  /\bvisualizac(?:a|o|ao|oes|ões)\b/,
];

const TERMOS_DOCUMENTAIS = [
  /\bbriefing(s)?\b/,
  /\bdocumento(s)?\b/,
  /\brelatorio(s)?\b/,
  /\brelatório(s)?\b/,
  /\banalise(s)?\b/,
  /\banálise(s)?\b/,
  /\bpesquisa(s)?\b/,
  /\bespecificac(?:a|o|ao|oes|ões)\b/,
];

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function textoDaDemanda(demanda: Demanda): string {
  return normalizar([demanda.titulo, demanda.descricao, demanda.referencias ?? ''].join('\n'));
}

export function inferirEntregaEsperada(demanda: Demanda, setor: Setor): EntregaEsperada {
  if (!setor.podeEntregarHtml) return { tipo: 'livre', motivo: null };
  const texto = textoDaDemanda(demanda);
  const temTermoInterativo = TERMOS_INTERATIVOS.some((termo) => termo.test(texto));
  if (!temTermoInterativo) return { tipo: 'livre', motivo: null };

  const pareceSomenteDocumento = TERMOS_DOCUMENTAIS.some((termo) => termo.test(texto)) && !/\b(interativ|clicavel|clicavel|dashboard|tela|interface|front[- ]?end|app|aplicativo)\b/.test(texto);
  if (pareceSomenteDocumento) return { tipo: 'livre', motivo: null };

  return {
    tipo: 'html_interativo',
    motivo: 'a demanda pede uma interface, dashboard, app, plataforma ou tela interativa',
  };
}

export function instrucaoEntregaEsperada(entrega: EntregaEsperada): string | null {
  if (entrega.tipo !== 'html_interativo') return null;
  return `Entrega esperada: produza uma tela/dashboard interativo como entrega principal. Use entrega.tipo = "html" e entrega.conteudo como um documento HTML completo e autocontido, com <!doctype html>, <html>, CSS em <style>, JavaScript em <script> e controles ou visualizações interativas. Não conclua com briefing, documento textual ou apenas explicação do que deveria ser construído.`;
}

export function validarResultadoExecucao(exec: ResultadoExecucao, entrega: EntregaEsperada): ValidacaoEntrega {
  if (entrega.tipo !== 'html_interativo') return { valida: true };
  if (exec.acaoHumana || exec.insumoCritico?.alternativa === 'B') return { valida: true };
  if (!exec.entrega) return invalida('não trouxe uma entrega principal');
  if (exec.entrega.tipo !== 'html') return invalida('a entrega veio como texto, não como HTML');

  const conteudo = exec.entrega.conteudo;
  const minusculo = conteudo.toLowerCase();
  if (!/(<!doctype html>|<html[\s>])/i.test(conteudo)) return invalida('o conteúdo não é um documento HTML completo');
  if (!/<style[\s>]/i.test(conteudo) && !/\sstyle=/i.test(conteudo)) return invalida('não há CSS embutido para compor a interface');
  if (!/<script[\s>]/i.test(conteudo)) return invalida('não há JavaScript embutido para comportamento interativo');
  if (!/(<button[\s>]|<input[\s>]|<select[\s>]|<textarea[\s>]|<canvas[\s>]|<svg[\s>]|onclick=|addEventListener\s*\()/i.test(conteudo)) {
    return invalida('não há controles ou visualizações interativas observáveis');
  }
  if (/(briefing|documento|relatorio|relatório|este documento apresenta|a seguir apresento)/i.test(minusculo) && conteudo.length < 1500) {
    return invalida('a entrega parece ser um briefing textual curto em vez de uma tela utilizável');
  }
  return { valida: true };
}

export function mensagemEntregaInvalida(validacao: Exclude<ValidacaoEntrega, { valida: true }>): string {
  return `Entrega inválida para demanda interativa: ${validacao.motivo}.`;
}

function invalida(motivo: string): ValidacaoEntrega {
  return {
    valida: false,
    motivo,
    instrucaoCorrecao: `Correção obrigatória da entrega: a demanda exige uma tela/dashboard interativo. A resposta anterior foi recusada porque ${motivo}. Nesta tentativa, entregue entrega.tipo = "html" com um documento HTML completo e autocontido, CSS em <style>, JavaScript em <script> e controles ou visualizações interativas. Não entregue briefing, documento textual ou apenas explicação; construa a tela final como HTML.`,
  };
}
