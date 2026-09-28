import type pg from 'pg';
import { atualizarDemanda, registrarTentativa, type Demanda } from '../db/demandas.ts';
import { montarChaveIdempotencia, registrarEvento, type TipoEvento } from '../db/eventos.ts';
import { adicionarMensagem, listarMensagens } from '../db/mensagens.ts';
import { criarEntrega, registrarAprendizado, salvarRelatorio, type Metricas } from '../db/relatorios.ts';
import { comTransacao } from '../db/tx.ts';
import { CATEGORIAS, SETORES, type Categoria, type StatusDemanda } from '../domain/setores.ts';
import { LlmError, type Llm } from '../llm/llm.ts';
import { paginaDeTexto } from '../util/html.ts';
import { log, mensagemDeErro } from '../util/log.ts';
import { calcularAuditoria, indiceGeral, regrasDosSetores, type MetricasAuditoria } from './auditoria.ts';
import { codigoDoErro, ehParadaSistemica, statusDaInterrupcao, type Interrupcao } from './erros.ts';
import {
  sistemaAuditoria,
  sistemaExecucao,
  usuarioAuditoria,
  usuarioExecucao,
  type FalaDaConversa,
} from './prompts.ts';
import { AuditoriaSchema, ResultadoExecucaoSchema, type ResultadoExecucao } from './schemas.ts';

const MAX_TOKENS_EXECUCAO = 32_000;
const MAX_TOKENS_AUDITORIA = 4_000;
const TENTATIVAS_AUDITORIA = 2;
const PAPEL_AUDITOR = SETORES.d17.papel;
const PREFIXOS_DE_PEDIDO = ['Ação humana necessária', 'Insumo necessário'];

export interface DependenciasDemanda {
  pool: pg.Pool;
  llm: Llm;
  modeloTrabalho: string;
  modeloAuditoria: string;
  urlBase: string;
  agora?: () => Date;
}

export interface ResultadoDemanda {
  demandaId: string;
  titulo: string;
  statusFinal: StatusDemanda;
  entregaUrl: string | null;
  resumo: string;
  antipadroes: number | null;
  // Falha de sistema ocorrida depois da execução paga (ex.: orçamento esgotado na auditoria): o trabalho
  // foi registrado, mas a run precisa parar.
  interrompidaPor: Interrupcao | null;
}

type Checkpoint = (texto: string, agente: string | null) => Promise<void>;

// Emite um evento do ledger sem nunca quebrar o processamento: uma falha aqui (violação de FK, metadata
// fora do schema do tipo, banco fora do ar) é logada e ignorada, igual ao notificador. O ledger é
// observacional e degradável nesta entrega — dual-write fail-open, nunca fonte de verdade transacional.
// Uma falha na escrita do evento nunca pode impedir nem atrasar o resultado real da demanda.
//
// Sem parâmetro de resumo: registrarEvento sempre usa o texto fixo do tipo (RESUMOS_POR_TIPO em
// src/db/eventos.ts), nunca texto vindo da demanda, do modelo ou de um erro. metadata é validada pelo
// schema exato do tipo — só aceita ids, enums, contagens, flags, setor, status e códigos classificados.
export type EmitirEvento = (tipo: TipoEvento, ator: string, metadata?: Record<string, unknown>) => Promise<void>;

export interface OpcoesEmissor {
  // Identidade imutável desta execução: o run_id quando existe uma run, ou um UUID gerado uma única vez
  // no início de uma ação de interface (ver rotas.ts). Nunca reaproveitado entre execuções diferentes.
  correlacaoId: string;
  runId: string | null;
  // null quando o evento não prova que o processamento chegou a começar (ver criarEmissor em
  // processar-fila.ts para os casos "nunca iniciada" e "reivindicada").
  tentativa: number | null;
}

export function criarEmissor(pool: pg.Pool, demandaId: string, opcoes: OpcoesEmissor): EmitirEvento {
  const { correlacaoId, runId, tentativa } = opcoes;
  return async (tipoEvento, ator, metadata) => {
    // Cada tipo de evento acontece no máximo uma vez por (demanda, correlacaoId) — os pontos de emissão
    // são ramos mutuamente exclusivos do fluxo — então o próprio tipo já basta como discriminador.
    const chaveIdempotencia = montarChaveIdempotencia(correlacaoId, tipoEvento);
    try {
      await registrarEvento(pool, { demandaId, correlacaoId, runId, tentativa, tipoEvento, ator, chaveIdempotencia, metadata });
    } catch (erro) {
      log('erro', 'erro_evento_ledger', { demandaId, tipoEvento, erro: mensagemDeErro(erro) });
    }
  };
}

interface EntregaHospedada {
  url: string;
  id: string;
  titulo: string;
  tipo: 'html' | 'texto';
  texto: string;
  convertidaParaTexto: boolean;
  semEntregaSeparada: boolean;
}

interface Auditoria {
  resultado: MetricasAuditoria | null;
  chamadas: number;
  interrupcao: Interrupcao | null;
}

function criarCheckpoint(pool: pg.Pool, demanda: Demanda): Checkpoint {
  const setor = demanda.categoria === 'gestores' ? null : demanda.categoria;
  return async (texto, agente) => {
    await adicionarMensagem(pool, { demandaId: demanda.id, autor: 'agente', setor, agente, texto });
  };
}

function formatarDuracao(ms: number): string {
  const segundos = Math.max(0, Math.round(ms / 1000));
  if (segundos < 60) return `${segundos}s`;
  return `${Math.floor(segundos / 60)}m ${String(segundos % 60).padStart(2, '0')}s`;
}

// O pedido que a frota fez e a resposta do solicitante: sem a pergunta, um "aprovado" não quer dizer nada.
async function conversaDaDemanda(pool: pg.Pool, demandaId: string): Promise<FalaDaConversa[]> {
  const mensagens = await listarMensagens(pool, demandaId);
  return mensagens.flatMap((m): FalaDaConversa[] => {
    if (m.autor === 'solicitante') return [{ autor: 'solicitante', texto: m.texto }];
    return PREFIXOS_DE_PEDIDO.some((p) => m.texto.startsWith(p)) ? [{ autor: 'frota', texto: m.texto }] : [];
  });
}

// Pedidos que dependem de pessoa, ou sem um insumo essencial (alternativa B), não geram entrega:
// o estado fica visível na fila em vez de fingir que o trabalho foi feito.
async function tratarPendencia(
  d: DependenciasDemanda,
  demanda: Demanda,
  exec: ResultadoExecucao,
  checkpoint: Checkpoint,
  emitir: EmitirEvento,
): Promise<ResultadoDemanda | null> {
  const papel = SETORES[demanda.categoria].papel;
  const base = {
    demandaId: demanda.id,
    titulo: demanda.titulo,
    entregaUrl: null,
    resumo: exec.resumo,
    antipadroes: null,
    interrompidaPor: null,
  };

  if (exec.acaoHumana) {
    // O checkpoint (mensagens, já existente antes desta entrega) pode carregar o motivo em texto livre —
    // isso está fora do escopo do ledger. O ledger (agent_events) nunca recebe esse texto: só a contagem.
    const acoes = exec.acaoHumana.acoesNecessarias.length ? ` — Ações: ${exec.acaoHumana.acoesNecessarias.join('; ')}` : '';
    await checkpoint(`Ação humana necessária: ${exec.acaoHumana.motivo}${acoes}`, papel);
    await atualizarDemanda(d.pool, demanda.id, { status: 'Aguardando humano', bloqueioHumano: exec.acaoHumana });
    await emitir('pendencia_humana_registrada', papel, { totalAcoes: exec.acaoHumana.acoesNecessarias.length });
    return { ...base, statusFinal: 'Aguardando humano' };
  }
  if (exec.insumoCritico?.alternativa === 'B') {
    await checkpoint(`Insumo necessário (alternativa B): ${exec.insumoCritico.descricao}`, papel);
    await atualizarDemanda(d.pool, demanda.id, { status: 'Aguardando insumo', alternativaInsumo: 'B' });
    await emitir('pendencia_insumo_registrada', papel, { alternativa: 'B' });
    return { ...base, statusFinal: 'Aguardando insumo' };
  }
  return null;
}

// Se o modelo não separou uma entrega, o resumo vira a entrega: toda demanda concluída tem algo para abrir.
async function hospedarEntrega(
  d: DependenciasDemanda,
  demanda: Demanda,
  exec: ResultadoExecucao,
  checkpoint: Checkpoint,
  emitir: EmitirEvento,
): Promise<EntregaHospedada> {
  const setor = SETORES[demanda.categoria];
  const entrega = exec.entrega ?? { tipo: 'texto' as const, titulo: 'Resumo da execução', conteudo: exec.resumo };
  const publicaHtml = entrega.tipo === 'html' && setor.podeEntregarHtml;
  const conteudo = publicaHtml ? entrega.conteudo : paginaDeTexto(entrega.titulo, entrega.conteudo);

  const criada = await criarEntrega(d.pool, { demandaId: demanda.id, titulo: entrega.titulo, conteudo });
  const url = `${d.urlBase}/entregas/${criada.id}`;
  // A URL nunca vai para o ledger — só o entregaId, que já basta para localizar a entrega numa consulta.
  await checkpoint(`Entrega hospedada: ${url}`, setor.papel);
  await emitir('entrega_criada', setor.papel, { entregaId: criada.id, tipo: entrega.tipo, publicadaComoHtml: publicaHtml });
  return {
    url,
    id: criada.id,
    titulo: entrega.titulo,
    tipo: entrega.tipo,
    texto: entrega.conteudo,
    convertidaParaTexto: entrega.tipo === 'html' && !setor.podeEntregarHtml,
    semEntregaSeparada: exec.entrega === null,
  };
}

// Auditoria por chamada separada e sem o contexto da execução. Se falhar duas vezes, as métricas ficam
// nulas: um buraco honesto vale mais que um número inventado. Falha de sistema (orçamento, pausa, API fora
// do ar) não descarta a execução já paga: a auditoria fica registrada como interrompida e a run para.
async function auditar(
  d: DependenciasDemanda,
  demanda: Demanda,
  exec: ResultadoExecucao,
  entrega: EntregaHospedada,
  checkpoint: Checkpoint,
  emitir: EmitirEvento,
  contexto: { runId: string; demandaId: string },
): Promise<Auditoria> {
  const regras = regrasDosSetores([demanda.categoria, ...exec.setoresEnvolvidos]);
  await checkpoint('Auditando a entrega contra as regras dos setores envolvidos.', PAPEL_AUDITOR);

  let chamadas = 0;
  let ultimoErro: unknown = null;
  for (let tentativa = 1; tentativa <= TENTATIVAS_AUDITORIA; tentativa++) {
    chamadas++;
    try {
      const { valor } = await d.llm.gerar({
        modelo: d.modeloAuditoria,
        papel: PAPEL_AUDITOR,
        sistema: sistemaAuditoria(),
        usuario: usuarioAuditoria({
          regras,
          resumo: exec.resumo,
          entrega: { tipo: entrega.tipo, titulo: entrega.titulo, conteudo: entrega.texto },
        }),
        schema: AuditoriaSchema,
        maxTokens: MAX_TOKENS_AUDITORIA,
        contexto,
      });
      const resultado = calcularAuditoria(regras, valor);
      await emitir('auditoria_concluida', PAPEL_AUDITOR, {
        antipadroesCount: resultado.antipadroesCount,
        regrasCumpridasPercent: resultado.regrasCumpridasPercent,
      });
      return { resultado, chamadas, interrupcao: null };
    } catch (erro) {
      if (ehParadaSistemica(erro)) {
        const interrupcao = { motivo: mensagemDeErro(erro), status: statusDaInterrupcao(erro) };
        await checkpoint(`Auditoria interrompida: ${interrupcao.motivo}`, PAPEL_AUDITOR);
        await emitir('auditoria_interrompida', PAPEL_AUDITOR, { codigoErro: codigoDoErro(erro) });
        return { resultado: null, chamadas, interrupcao };
      }
      if (!(erro instanceof LlmError)) throw erro;
      ultimoErro = erro;
      await checkpoint(`Auditoria falhou (${erro.tipo}), tentativa ${tentativa} de ${TENTATIVAS_AUDITORIA}.`, PAPEL_AUDITOR);
    }
  }
  // Esgotou as tentativas sem parada sistêmica: não é motivo para interromper a run (a demanda ainda
  // conclui, com métricas nulas), mas é uma falha real e precisa ficar no ledger — nunca com a mensagem
  // bruta do erro, só o código classificado.
  await emitir('auditoria_interrompida', PAPEL_AUDITOR, { codigoErro: codigoDoErro(ultimoErro) });
  return { resultado: null, chamadas, interrupcao: null };
}

function setoresDoRelatorio(categoria: Categoria, exec: ResultadoExecucao): Categoria[] {
  const envolvidos = new Set<string>(exec.setoresEnvolvidos);
  if (categoria !== 'gestores') envolvidos.add(categoria);
  return CATEGORIAS.filter((c) => envolvidos.has(c));
}

function textoDePerdas(exec: ResultadoExecucao, entrega: EntregaHospedada, auditoria: Auditoria): string {
  const partes = [exec.perdas.trim()];
  if (entrega.convertidaParaTexto) partes.push('A entrega foi hospedada como texto: o setor não pode publicar páginas HTML.');
  if (entrega.semEntregaSeparada) partes.push('O modelo não produziu uma entrega separada: o resumo foi hospedado como entrega.');
  if (auditoria.interrupcao) {
    partes.push(`A auditoria foi interrompida (${auditoria.interrupcao.motivo}): as métricas de conformidade não foram calculadas.`);
  } else if (!auditoria.resultado) {
    partes.push('A auditoria automática falhou: as métricas de conformidade não foram calculadas.');
  }
  const r = auditoria.resultado;
  if (r && r.violacoesDescartadas > 0) {
    partes.push(
      `O auditor citou ${r.violacoesDescartadas} violação(ões) sem regra reconhecida ou sem evidência concreta; elas não entraram na contagem.`,
    );
  }
  for (const v of r?.violacoes ?? []) partes.push(`Violação (${v.gravidade}) de "${v.regra}": ${v.evidencia}`);
  return partes.filter(Boolean).join('\n');
}

function montarMetricas(exec: ResultadoExecucao, auditoria: Auditoria, duracaoMs: number): Metricas {
  const auditada = auditoria.resultado;
  return {
    acoesRealizadas: `${1 + auditoria.chamadas} chamada(s) ao modelo. ${exec.resumo}`,
    tempoTotal: formatarDuracao(duracaoMs),
    indiceGeral: auditada ? indiceGeral(exec.autoavaliacao, auditada.regrasCumpridasPercent) : null,
    antipadroesCount: auditada ? auditada.antipadroesCount : null,
    regrasCumpridasPercent: auditada ? auditada.regrasCumpridasPercent : null,
    ...(auditada ? {} : { auditoriaFalhou: true }),
  };
}

async function registrarResultado(
  d: DependenciasDemanda,
  demanda: Demanda,
  exec: ResultadoExecucao,
  entrega: EntregaHospedada,
  auditoria: Auditoria,
  duracaoMs: number,
  emitir: EmitirEvento,
): Promise<StatusDemanda> {
  const setor = SETORES[demanda.categoria];
  const alternativa = exec.insumoCritico?.alternativa === 'B' ? null : (exec.insumoCritico?.alternativa ?? null);
  const provisorio = alternativa === 'A';
  const statusFinal: StatusDemanda = provisorio ? 'Aguardando insumo' : 'Concluída';
  const metricas = montarMetricas(exec, auditoria, duracaoMs);

  await comTransacao(d.pool, async (cliente) => {
    await salvarRelatorio(cliente, {
      demandaId: demanda.id,
      demandaTitulo: demanda.titulo,
      gerente: `${setor.papel} → ${PAPEL_AUDITOR} (agentes autônomos do servidor)`,
      nivelComplexidade: exec.nivelComplexidade,
      setoresEnvolvidos: setoresDoRelatorio(demanda.categoria, exec),
      fontesUtilizadas: exec.fontesUtilizadas || null,
      metricas,
      ganhos: exec.ganhos,
      perdas: textoDePerdas(exec, entrega, auditoria),
      aprendizado: exec.aprendizado,
      ponderacoes: exec.ponderacoes,
      entregaUrl: entrega.url,
    });
    if (!provisorio) {
      await registrarAprendizado(cliente, {
        demanda: demanda.titulo,
        nivel: exec.nivelComplexidade,
        aprendizado: exec.aprendizado,
        indice: metricas.indiceGeral,
      });
    }
    await atualizarDemanda(cliente, demanda.id, { status: statusFinal, entregaUrl: entrega.url, alternativaInsumo: alternativa });
  });

  // A escrita do relatório acima e o evento abaixo são transações separadas de propósito: o ledger é
  // observacional e degradável nesta entrega, nunca fonte de verdade transacional, e não pode impedir
  // nem atrasar o resultado real sendo salvo. Ver o comentário de registrarEvento em src/db/eventos.ts.
  if (provisorio) {
    await emitir('pendencia_insumo_registrada', setor.papel, { alternativa: 'A' });
  } else {
    await emitir('demanda_concluida', setor.papel, {
      indiceGeral: metricas.indiceGeral,
      antipadroesCount: metricas.antipadroesCount,
    });
  }
  return statusFinal;
}

// Erros de API, de orçamento e de pausa na execução sobem para quem chamou: eles não são culpa da demanda.
export async function processarDemanda(d: DependenciasDemanda, demanda: Demanda, runId: string): Promise<ResultadoDemanda> {
  const setor = SETORES[demanda.categoria];
  const relogio = (): number => (d.agora?.() ?? new Date()).getTime();
  const inicio = relogio();
  const checkpoint = criarCheckpoint(d.pool, demanda);
  const contexto = { runId, demandaId: demanda.id };

  // A tentativa conta aqui, quando o trabalho de fato começa, e não quando o lote é reivindicado.
  // demanda.tentativas ainda reflete o valor de antes deste incremento: some 1 para correlacionar os
  // eventos desta execução com a tentativa que está começando agora.
  await registrarTentativa(d.pool, demanda.id);
  const tentativaAtual = demanda.tentativas + 1;
  // correlacaoId = runId: dentro do orquestrador sempre existe uma run, e ela já é a identidade
  // imutável certa para esta execução (uma run nunca é reaproveitada entre execuções diferentes).
  // tentativa não é mais null a partir daqui: registrarTentativa já rodou, então o trabalho começou de fato.
  const emitir = criarEmissor(d.pool, demanda.id, { correlacaoId: runId, runId, tentativa: tentativaAtual });

  await checkpoint('Iniciando análise da demanda.', null);
  await emitir('processamento_iniciado', setor.papel);
  await checkpoint(`Executando o trabalho com ${setor.papel} (${d.modeloTrabalho}).`, setor.papel);

  let exec: ResultadoExecucao;
  try {
    ({ valor: exec } = await d.llm.gerar({
      modelo: d.modeloTrabalho,
      papel: setor.papel,
      sistema: sistemaExecucao(setor),
      usuario: usuarioExecucao(demanda, await conversaDaDemanda(d.pool, demanda.id)),
      schema: ResultadoExecucaoSchema,
      maxTokens: MAX_TOKENS_EXECUCAO,
      contexto,
    }));
  } catch (erro) {
    // Registra o evento e repassa o erro sem alterar em nada o tratamento que processar-fila.ts já faz.
    await emitir('chamada_trabalho_falhou', setor.papel, { codigoErro: codigoDoErro(erro) });
    throw erro;
  }
  await emitir('chamada_trabalho_concluida', setor.papel, {
    nivelComplexidade: exec.nivelComplexidade,
    setoresEnvolvidos: exec.setoresEnvolvidos,
  });
  await checkpoint(`Plano: ${exec.plano}`, setor.papel);

  const pendencia = await tratarPendencia(d, demanda, exec, checkpoint, emitir);
  if (pendencia) return pendencia;

  const entrega = await hospedarEntrega(d, demanda, exec, checkpoint, emitir);
  const auditoria = await auditar(d, demanda, exec, entrega, checkpoint, emitir, contexto);
  await checkpoint('Finalizando e registrando relatório.', null);
  const statusFinal = await registrarResultado(d, demanda, exec, entrega, auditoria, relogio() - inicio, emitir);
  await checkpoint(`Relatório registrado. Status: ${statusFinal}.`, null);

  return {
    demandaId: demanda.id,
    titulo: demanda.titulo,
    statusFinal,
    entregaUrl: entrega.url,
    resumo: exec.resumo,
    antipadroes: auditoria.resultado?.antipadroesCount ?? null,
    interrompidaPor: auditoria.interrupcao,
  };
}
