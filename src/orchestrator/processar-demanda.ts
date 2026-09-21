import type pg from 'pg';
import { atualizarDemanda, registrarTentativa, type Demanda } from '../db/demandas.ts';
import { adicionarMensagem, listarMensagens } from '../db/mensagens.ts';
import { criarEntrega, registrarAprendizado, salvarRelatorio, type Metricas } from '../db/relatorios.ts';
import { comTransacao } from '../db/tx.ts';
import { CATEGORIAS, SETORES, type Categoria, type StatusDemanda } from '../domain/setores.ts';
import { LlmError, type Llm } from '../llm/llm.ts';
import { paginaDeTexto } from '../util/html.ts';
import { mensagemDeErro } from '../util/log.ts';
import { calcularAuditoria, indiceGeral, regrasDosSetores, type MetricasAuditoria } from './auditoria.ts';
import { ehParadaSistemica, statusDaInterrupcao, type Interrupcao } from './erros.ts';
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

interface EntregaHospedada {
  url: string;
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
    const acoes = exec.acaoHumana.acoesNecessarias.length ? ` — Ações: ${exec.acaoHumana.acoesNecessarias.join('; ')}` : '';
    await checkpoint(`Ação humana necessária: ${exec.acaoHumana.motivo}${acoes}`, papel);
    await atualizarDemanda(d.pool, demanda.id, { status: 'Aguardando humano', bloqueioHumano: exec.acaoHumana });
    return { ...base, statusFinal: 'Aguardando humano' };
  }
  if (exec.insumoCritico?.alternativa === 'B') {
    await checkpoint(`Insumo necessário (alternativa B): ${exec.insumoCritico.descricao}`, papel);
    await atualizarDemanda(d.pool, demanda.id, { status: 'Aguardando insumo', alternativaInsumo: 'B' });
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
): Promise<EntregaHospedada> {
  const setor = SETORES[demanda.categoria];
  const entrega = exec.entrega ?? { tipo: 'texto' as const, titulo: 'Resumo da execução', conteudo: exec.resumo };
  const publicaHtml = entrega.tipo === 'html' && setor.podeEntregarHtml;
  const conteudo = publicaHtml ? entrega.conteudo : paginaDeTexto(entrega.titulo, entrega.conteudo);

  const criada = await criarEntrega(d.pool, { demandaId: demanda.id, titulo: entrega.titulo, conteudo });
  const url = `${d.urlBase}/entregas/${criada.id}`;
  await checkpoint(`Entrega hospedada: ${url}`, setor.papel);
  return {
    url,
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
  contexto: { runId: string; demandaId: string },
): Promise<Auditoria> {
  const regras = regrasDosSetores([demanda.categoria, ...exec.setoresEnvolvidos]);
  await checkpoint('Auditando a entrega contra as regras dos setores envolvidos.', PAPEL_AUDITOR);

  let chamadas = 0;
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
      return { resultado: calcularAuditoria(regras, valor), chamadas, interrupcao: null };
    } catch (erro) {
      if (ehParadaSistemica(erro)) {
        const interrupcao = { motivo: mensagemDeErro(erro), status: statusDaInterrupcao(erro) };
        await checkpoint(`Auditoria interrompida: ${interrupcao.motivo}`, PAPEL_AUDITOR);
        return { resultado: null, chamadas, interrupcao };
      }
      if (!(erro instanceof LlmError)) throw erro;
      await checkpoint(`Auditoria falhou (${erro.tipo}), tentativa ${tentativa} de ${TENTATIVAS_AUDITORIA}.`, PAPEL_AUDITOR);
    }
  }
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
  await registrarTentativa(d.pool, demanda.id);
  await checkpoint('Iniciando análise da demanda.', null);
  await checkpoint(`Executando o trabalho com ${setor.papel} (${d.modeloTrabalho}).`, setor.papel);
  const { valor: exec } = await d.llm.gerar({
    modelo: d.modeloTrabalho,
    papel: setor.papel,
    sistema: sistemaExecucao(setor),
    usuario: usuarioExecucao(demanda, await conversaDaDemanda(d.pool, demanda.id)),
    schema: ResultadoExecucaoSchema,
    maxTokens: MAX_TOKENS_EXECUCAO,
    contexto,
  });
  await checkpoint(`Plano: ${exec.plano}`, setor.papel);

  const pendencia = await tratarPendencia(d, demanda, exec, checkpoint);
  if (pendencia) return pendencia;

  const entrega = await hospedarEntrega(d, demanda, exec, checkpoint);
  const auditoria = await auditar(d, demanda, exec, entrega, checkpoint, contexto);
  await checkpoint('Finalizando e registrando relatório.', null);
  const statusFinal = await registrarResultado(d, demanda, exec, entrega, auditoria, relogio() - inicio);
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
