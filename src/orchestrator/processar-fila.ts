import {
  atualizarDemanda,
  devolverParaFila,
  existeDemandaNova,
  liberarDemandasAbandonadas,
  MAX_TENTATIVAS,
  obterDemanda,
  reivindicarDemandas,
  type Demanda,
} from '../db/demandas.ts';
import { adicionarMensagem } from '../db/mensagens.ts';
import { finalizarRun, iniciarRun, obterFlags, type StatusRun } from '../db/operacao.ts';
import { LlmError } from '../llm/llm.ts';
import type { Notificador } from '../notify/notificador.ts';
import { log, mensagemDeErro } from '../util/log.ts';
import { ehParadaSistemica, statusDaInterrupcao } from './erros.ts';
import { processarDemanda, type DependenciasDemanda, type ResultadoDemanda } from './processar-demanda.ts';

export interface DependenciasFila extends DependenciasDemanda {
  notificador: Notificador;
  maxDemandasPorRun: number;
  minutosAbandono: number;
}

export interface FalhaDemanda {
  titulo: string;
  motivo: string;
  statusFinal: 'Nova' | 'Falhou';
}

export interface ResumoRun {
  runId: string;
  status: Exclude<StatusRun, 'rodando'>;
  processadas: ResultadoDemanda[];
  falhas: FalhaDemanda[];
  interrompidaPor: string | null;
}

async function registrarFalha(d: DependenciasFila, demanda: Demanda, erro: unknown): Promise<FalhaDemanda> {
  log('erro', 'erro_demanda', { demandaId: demanda.id, erro: mensagemDeErro(erro) });
  // Mensagens de LlmError são controladas por nós; qualquer outro erro pode carregar detalhes internos.
  const motivo = erro instanceof LlmError ? erro.message : 'Falha inesperada no processamento.';
  const atual = await obterDemanda(d.pool, demanda.id);
  const tentativas = atual?.tentativas ?? demanda.tentativas;
  const statusFinal = tentativas >= MAX_TENTATIVAS ? 'Falhou' : 'Nova';

  await adicionarMensagem(d.pool, {
    demandaId: demanda.id,
    autor: 'agente',
    setor: demanda.categoria === 'gestores' ? null : demanda.categoria,
    texto: `Falha ao processar (tentativa ${tentativas} de ${MAX_TENTATIVAS}): ${motivo}${
      statusFinal === 'Falhou' ? ' Limite de tentativas atingido.' : ' A demanda volta para a fila.'
    }`,
  });
  await atualizarDemanda(d.pool, demanda.id, { status: statusFinal });
  return { titulo: demanda.titulo, motivo, statusFinal };
}

async function processarLote(d: DependenciasFila, runId: string, demandas: Demanda[]): Promise<ResumoRun> {
  const resumo: ResumoRun = { runId, status: 'ok', processadas: [], falhas: [], interrompidaPor: null };

  for (const demanda of demandas) {
    if (resumo.interrompidaPor) {
      // Nunca começou: devolve sem mexer nas tentativas.
      await devolverParaFila(d.pool, demanda.id);
      continue;
    }
    try {
      const resultado = await processarDemanda(d, demanda, runId);
      resumo.processadas.push(resultado);
      if (resultado.interrompidaPor) {
        resumo.interrompidaPor = resultado.interrompidaPor.motivo;
        resumo.status = resultado.interrompidaPor.status;
      }
    } catch (erro) {
      if (ehParadaSistemica(erro)) {
        resumo.interrompidaPor = mensagemDeErro(erro);
        resumo.status = statusDaInterrupcao(erro);
        // Já tinha começado: essa tentativa não conta contra a demanda.
        await devolverParaFila(d.pool, demanda.id, true);
      } else {
        resumo.falhas.push(await registrarFalha(d, demanda, erro));
      }
    }
  }
  return resumo;
}

// Uma run que morreu no meio deixa demandas presas; ao recuperá-las, a linha do tempo explica o que houve.
async function recuperarAbandonadas(d: DependenciasFila): Promise<void> {
  const abandonadas = await liberarDemandasAbandonadas(d.pool, d.minutosAbandono);
  if (abandonadas.length > 0) log('aviso', 'demandas_abandonadas', { total: abandonadas.length });
  for (const a of abandonadas) {
    const texto =
      a.status === 'Falhou'
        ? 'A execução anterior foi interrompida e o limite de tentativas foi atingido: a demanda foi marcada como Falhou.'
        : 'A execução anterior foi interrompida antes de terminar: a demanda voltou para a fila.';
    await adicionarMensagem(d.pool, { demandaId: a.id, autor: 'agente', texto });
  }
}

function montarNotificacao(resumo: ResumoRun): { titulo: string; corpo: string } {
  const linhas = [
    ...resumo.processadas.map((r) => {
      const partes = [`• ${r.titulo} — ${r.statusFinal}`];
      if (r.antipadroes !== null) partes.push(`(violações auditadas: ${r.antipadroes})`);
      if (r.entregaUrl) partes.push(`\n  ${r.entregaUrl}`);
      return partes.join(' ');
    }),
    ...resumo.falhas.map((f) => `• ${f.titulo} — falhou: ${f.motivo}${f.statusFinal === 'Falhou' ? ' (sem novas tentativas)' : ''}`),
  ];
  if (resumo.interrompidaPor) linhas.push(`Execução interrompida: ${resumo.interrompidaPor}`);

  const total = resumo.processadas.length;
  const titulo = `Frota: ${total} demanda(s) processada(s)${resumo.interrompidaPor ? ' — execução interrompida' : ''}`;
  return { titulo, corpo: linhas.join('\n') };
}

async function avisarResumo(d: DependenciasFila, resumo: ResumoRun): Promise<void> {
  if (resumo.processadas.length === 0 && resumo.falhas.length === 0 && !resumo.interrompidaPor) return;
  try {
    const { titulo, corpo } = montarNotificacao(resumo);
    await d.notificador.notificar({ nivel: resumo.interrompidaPor || resumo.falhas.length ? 'aviso' : 'info', titulo, corpo });
  } catch (erro) {
    log('erro', 'erro_notificacao', { erro: mensagemDeErro(erro) });
  }
}

function resumoVazio(runId: string, status: 'ok' | 'pausada'): ResumoRun {
  return { runId, status, processadas: [], falhas: [], interrompidaPor: null };
}

// Fila vazia e frota pausada terminam sem nenhuma chamada ao modelo: custo zero.
export async function processarFila(d: DependenciasFila, gatilho: 'cron' | 'manual' = 'cron'): Promise<ResumoRun> {
  const runId = await iniciarRun(d.pool, gatilho);
  try {
    await recuperarAbandonadas(d);

    if ((await obterFlags(d.pool)).pausado) {
      await finalizarRun(d.pool, runId, { status: 'pausada', demandasProcessadas: 0 });
      return resumoVazio(runId, 'pausada');
    }
    if (!(await existeDemandaNova(d.pool))) {
      await finalizarRun(d.pool, runId, { status: 'ok', demandasProcessadas: 0 });
      return resumoVazio(runId, 'ok');
    }

    const demandas = await reivindicarDemandas(d.pool, runId, d.maxDemandasPorRun);
    const resumo = await processarLote(d, runId, demandas);
    await finalizarRun(d.pool, runId, {
      status: resumo.status,
      demandasProcessadas: resumo.processadas.length,
      erro: resumo.interrompidaPor,
    });
    await avisarResumo(d, resumo);
    return resumo;
  } catch (erro) {
    await finalizarRun(d.pool, runId, { status: 'erro', demandasProcessadas: 0, erro: mensagemDeErro(erro) }).catch(
      () => undefined,
    );
    throw erro;
  }
}
