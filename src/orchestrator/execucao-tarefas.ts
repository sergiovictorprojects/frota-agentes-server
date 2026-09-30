import type pg from 'pg';
import { z } from 'zod';
import { prepararArtefatosEntregaveis } from '../artifacts/servico.ts';
import { obterAgentePorChave } from '../db/agentes.ts';
import { agentePodeGerarArtefatoIntermediario } from '../domain/capacidades-agentes.ts';
import { SETORES } from '../domain/setores.ts';
import type { Demanda } from '../db/demandas.ts';
import { atualizarDemanda } from '../db/demandas.ts';
import { listarArtefatosDasDependencias, validarArtefato, ArtefatoPropostoSchema, type ArtefatoValidado } from '../db/artefatos.ts';
import { avaliarEregistrar } from '../db/politicas.ts';
import { criarEnvelope, bloquearPorCusto, fixarRotaLegado, reservarCusto } from '../db/orquestracao.ts';
import {
  registrarEAtivarPlanoExecucao,
  registrarPlanoRejeitado,
  validarPlanoExecucao,
  PlanoExecucaoPropostoSchema,
  type PlanoGravado,
} from '../db/planos.ts';
import {
  abandonarPlano,
  concluirIntegracao,
  concluirPlano,
  concluirTarefaEspecialista,
  falharPorContextoExcedido,
  falharTarefaDefinitivamente,
  obterProximaTarefaPronta,
  reivindicarTarefa,
  reservarERegistrarEnvio,
  type TarefaReivindicada,
} from '../db/tarefas.ts';
import type { Db } from '../db/tx.ts';
import { LlmError, type Llm, type PedidoLlm, type RespostaLlm } from '../llm/llm.ts';
import { reservaUsd } from '../llm/reserva.ts';
import { dadosDoModelo } from '../llm/models.ts';
import {
  sistemaEspecialista,
  sistemaIntegracao,
  sistemaPlanejamentoExecucao,
  usuarioEspecialistaTarefa,
  usuarioIntegracaoTarefas,
  usuarioPlanejamentoExecucao,
  type FalaDaConversa,
} from './prompts.ts';
import { medirEntrada, reduzirParaCaber } from './serializacao.ts';
import { ResultadoExecucaoSchema, type ResultadoExecucao } from './schemas.ts';
import { PrazoRunExcedidoError, criarRelogioRun } from './prazo-run.ts';
import { comTransacao } from '../db/tx.ts';
import type { EmitirEvento } from './processar-demanda.ts';
import { inferirEntregaEsperada, instrucaoEntregaEsperada, mensagemEntregaInvalida, validarResultadoExecucao } from './validacao-entrega.ts';

// A interface fica separada de Llm para tornar explícito que o motor nunca pode usar o caminho legado de
// LlmComOrcamento: uma chamada com envelope precisa liquidar a reserva, não gravar um segundo agent_step.
export interface LlmComEnvelope extends Llm {
  gerarComReserva<T>(pedido: PedidoLlm<T>, p: { reservaId: string; runId: string | null; timeoutMs: number }): Promise<RespostaLlm<T>>;
  verificarPodeIniciar?(): Promise<void>;
}

export interface DependenciasExecucaoTarefas {
  pool: pg.Pool;
  llm: LlmComEnvelope;
  modeloTrabalho: string;
  demanda: Demanda;
  conversa: readonly FalaDaConversa[];
  runId: string;
  emitir: EmitirEvento;
  tetoBaseUsd?: string;
  agoraMonotono?: () => number;
}

export interface ResultadoExecucaoTarefas {
  planoId: string;
  plano: PlanoGravado;
  execucao: ResultadoExecucao;
  entregaId: string;
  duracaoMs: number;
}

export class RotaLegadoFixadaError extends Error {
  readonly motivoLegado: 'plano_rejeitado' | 'planejamento_falhou' | 'tarefa_falhou' | 'agente_indisponivel';

  constructor(motivoLegado: RotaLegadoFixadaError['motivoLegado'], mensagem: string) {
    super(mensagem);
    this.name = 'RotaLegadoFixadaError';
    this.motivoLegado = motivoLegado;
  }
}

const MAX_TOKENS_PLANEJAMENTO = 2_000;
const MAX_TOKENS_TAREFA = 32_000;
const TETO_BASE_PADRAO = '2.00';

function dadosSchemaParaReserva(schema: object): string {
  return JSON.stringify(schema);
}

function construirArtefatos(
  demanda: Demanda,
  conversa: readonly FalaDaConversa[],
  tarefa: { chave: string; objetivo: string },
  tarefasDoPlano: readonly { chave: string; objetivo: string }[],
  dependencias: readonly Awaited<ReturnType<typeof listarArtefatosDasDependencias>>[number][],
  modelo: string,
  sistema: string,
  schema: object,
  integracao = false,
  instrucaoEntrega?: string | null,
): { usuario: string; medida: ReturnType<typeof medirEntrada>; artefatosIntegrais: number; artefatosSoResumo: number; conversaOmitida: number } | null {
  const resultado = reduzirParaCaber({
    modelo,
    maxTokens: integracao ? MAX_TOKENS_TAREFA : MAX_TOKENS_TAREFA,
    sistema,
    schema: dadosSchemaParaReserva(schema),
    artefatos: dependencias.map((a) => ({
      chave: a.chave,
      formato: a.formato,
      resumo: a.resumo,
      conteudo: a.conteudo,
      referencias: a.referencias,
    })),
    conversa,
    montarUsuario: ({ artefatos: reduzidos, conversa: conversacao, conversaOmitida }) =>
      integracao
        ? usuarioIntegracaoTarefas({
            demanda,
            conversa: conversacao,
            conversaOmitida,
            tarefas: tarefasDoPlano,
            artefatos: reduzidos,
            instrucaoEntrega,
          })
        : usuarioEspecialistaTarefa({
            demanda,
            conversa: conversacao,
            conversaOmitida,
            tarefa,
            artefatos: reduzidos,
          }),
  });
  if (!resultado.cabe) return null;
  return resultado;
}

function tipoErroTarefa(erro: unknown): 'llm_recusa' | 'llm_truncado' | 'llm_invalido' | 'llm_api' | 'llm_timeout' | 'falha_inesperada' {
  if (erro instanceof LlmError) {
    if (erro.tipo === 'recusa') return 'llm_recusa';
    if (erro.tipo === 'truncado') return 'llm_truncado';
    if (erro.tipo === 'invalido') return 'llm_invalido';
    if (erro.tipo === 'timeout') return 'llm_timeout';
    return 'llm_api';
  }
  return 'falha_inesperada';
}

async function avaliarTarefa(d: DependenciasExecucaoTarefas, tarefa: TarefaReivindicada, estagio: 'pre' | 'during' | 'post'): Promise<void> {
  await avaliarEregistrar(d.pool, {
    demandaId: d.demanda.id,
    runId: d.runId,
    correlacaoId: d.runId,
    tentativa: d.demanda.tentativas + 1,
    estagio,
    contexto: {
      agente: tarefa.agente.chave,
      papel: tarefa.agente.papel,
      categoria: d.demanda.categoria,
      estado: 'ativo',
      modelo: tarefa.agente.modelo,
      operacao: tarefa.tipo === 'integracao' ? 'integracao' : 'execucao',
      prioridade: d.demanda.prioridade,
    },
    tarefa: { id: tarefa.id, claimId: tarefa.claimId },
  });
}

async function desistirDoClaim(d: DependenciasExecucaoTarefas, tarefa: TarefaReivindicada): Promise<void> {
  await d.pool.query(
    `UPDATE tarefas SET estado = 'pronta'
      WHERE id = $1 AND lease_token = $2 AND estado = 'em_execucao' AND enviada_em IS NULL`,
    [tarefa.id, tarefa.leaseToken],
  );
}

async function falharEAbandonar(
  d: DependenciasExecucaoTarefas,
  tarefa: TarefaReivindicada,
  codigo: Parameters<typeof falharTarefaDefinitivamente>[1]['codigoErro'],
): Promise<void> {
  const falha = await falharTarefaDefinitivamente(d.pool, { tarefaId: tarefa.id, leaseToken: tarefa.leaseToken, codigoErro: codigo });
  if (!falha.registrada || !falha.abandono) return;
  await d.emitir('tarefa_falhou', tarefa.agente.chave, {
    claimId: falha.claimId,
    tipo: tarefa.tipo,
    tentativa: falha.tentativa,
    codigoErro: codigo,
    definitiva: true,
  }, tarefa.id);
  await d.emitir('plano_abandonado', 'sistema', {
    planoId: tarefa.planoId,
    versao: falha.abandono.versao,
    motivoAbandono: 'tarefa_falhou',
    tarefasCanceladas: falha.abandono.tarefasCanceladas,
  });
}

async function abandonarParaLegadoPorTarefa(
  d: DependenciasExecucaoTarefas,
  tarefa: TarefaReivindicada,
  codigo: Parameters<typeof falharTarefaDefinitivamente>[1]['codigoErro'],
): Promise<never> {
  await falharEAbandonar(d, tarefa, codigo);
  await fixarRotaLegado(d.pool, { demandaId: d.demanda.id, motivo: 'tarefa_falhou' });
  throw new RotaLegadoFixadaError('tarefa_falhou', `Tarefa falhou: ${codigo}`);
}

async function bloquearDemandaPorCusto(d: DependenciasExecucaoTarefas, tarefa: TarefaReivindicada): Promise<void> {
  await comTransacao(d.pool, async (cliente) => {
    await desistirDoClaimComDb(cliente, tarefa);
    await bloquearPorCusto(cliente, d.demanda.id);
    await atualizarDemanda(cliente, d.demanda.id, { status: 'Aguardando humano' });
  });
}

async function desistirDoClaimComDb(db: Db, tarefa: TarefaReivindicada): Promise<void> {
  await db.query(
    `UPDATE tarefas SET estado = 'pronta'
      WHERE id = $1 AND lease_token = $2 AND estado = 'em_execucao' AND enviada_em IS NULL`,
    [tarefa.id, tarefa.leaseToken],
  );
}

async function registrarPlano(d: DependenciasExecucaoTarefas): Promise<PlanoGravado> {
  const sistema = sistemaPlanejamentoExecucao();
  const usuario = usuarioPlanejamentoExecucao(d.demanda, d.conversa);
  const medida = medirEntrada({ sistema, usuario, schema: dadosSchemaParaReserva(PlanoExecucaoPropostoSchema) });
  const reserva = await reservarCusto(d.pool, {
    demandaId: d.demanda.id,
    planoId: null,
    operacao: 'planejamento',
    modelo: d.modeloTrabalho,
    valorReservadoUsd: reservaUsd(d.modeloTrabalho, { bytesEntrada: medida.bytesEntrada, maxTokens: MAX_TOKENS_PLANEJAMENTO }),
    validadeSegundos: 120 + 180,
    agenteChave: 'frota:gestores',
  });
  if (!reserva.reservada) throw new Error(`Planejamento não reservado: ${reserva.motivo}`);
  const resposta = await d.llm.gerarComReserva(
    { modelo: d.modeloTrabalho, papel: 'frota:gestores', sistema, usuario, schema: PlanoExecucaoPropostoSchema, maxTokens: MAX_TOKENS_PLANEJAMENTO, contexto: { runId: d.runId, demandaId: d.demanda.id } },
    { reservaId: reserva.reservaId, runId: d.runId, timeoutMs: 120_000 },
  );
  const validacao = validarPlanoExecucao(resposta.valor);
  if (!validacao.valido) {
    const rejeitado = await registrarPlanoRejeitado(d.pool, { demandaId: d.demanda.id, runId: d.runId, motivo: validacao.motivo, modo: 'execucao' });
    await d.emitir('plano_rejeitado', 'frota:gestores', { planoId: rejeitado.id, versao: rejeitado.versao, motivoRejeicao: validacao.motivo });
    await fixarRotaLegado(d.pool, { demandaId: d.demanda.id, motivo: 'plano_rejeitado' });
    throw new RotaLegadoFixadaError('plano_rejeitado', `Plano rejeitado: ${validacao.motivo}`);
  }
  const plano = await registrarEAtivarPlanoExecucao(d.pool, { demandaId: d.demanda.id, runId: d.runId, tarefas: validacao.tarefas });
  await d.emitir('plano_registrado', 'frota:gestores', { planoId: plano.id, versao: plano.versao, modo: 'execucao', totalTarefas: plano.totalTarefas, totalDependencias: plano.totalDependencias });
  await d.emitir('plano_ativado', 'frota:gestores', { planoId: plano.id, versao: plano.versao, totalTarefas: plano.totalTarefas });
  return plano;
}

export async function processarExecucaoSequencial(d: DependenciasExecucaoTarefas): Promise<ResultadoExecucaoTarefas> {
  const relogio = criarRelogioRun(d.agoraMonotono);
  const entregaEsperada = inferirEntregaEsperada(d.demanda, SETORES[d.demanda.categoria]);
  const instrucaoEntrega = instrucaoEntregaEsperada(entregaEsperada);
  await criarEnvelope(d.pool, { demandaId: d.demanda.id, tetoBaseUsd: d.tetoBaseUsd ?? TETO_BASE_PADRAO });
  await d.emitir('rota_definida', 'sistema', { rota: 'tarefas', motivoRota: 'categoria_ligada' });
  let plano: PlanoGravado;
  try {
    plano = await registrarPlano(d);
  } catch (erro) {
    // A PR 3.2b-1 não altera o fluxo legado; o chamador decide se deixa a demanda em legado. O plano já
    // rejeitado permanece auditável, e não há tentativa de executar tarefa sem plano ativo.
    throw erro;
  }

  let resultadoIntegracao: ResultadoExecucao | null = null;
  let entregaId: string | null = null;
  for (;;) {
    const pronta = await obterProximaTarefaPronta(d.pool, plano.id);
    if (!pronta) break;
    if (!relogio.podeIniciar(pronta.tipo === 'integracao' ? 720 : 480)) throw new PrazoRunExcedidoError();

    const linhas = await d.pool.query<{ chave: string; tipo: 'especialista' | 'integracao'; objetivo: string | null }>(
      `SELECT chave, tipo, objetivo FROM tarefas WHERE id = $1`,
      [pronta.id],
    );
    const linha = linhas.rows[0]!;
    const dependencias = await listarArtefatosDasDependencias(d.pool, pronta.id);
    const tarefasDoPlano = await d.pool.query<{ chave: string; objetivo: string | null }>(
      `SELECT chave, objetivo FROM tarefas WHERE plano_id = $1 ORDER BY tipo = 'integracao', chave COLLATE "C"`,
      [plano.id],
    );
    const objetivosDoPlano = tarefasDoPlano.rows.map((x) => ({ chave: x.chave, objetivo: x.objetivo ?? 'Integrar o resultado das tarefas concluídas.' }));
    const tarefaPrompt = { chave: linha.chave, objetivo: linha.objetivo ?? 'Integrar o resultado das tarefas concluídas.' };
    const sistema = linha.tipo === 'integracao' ? sistemaIntegracao() : sistemaEspecialista(SETORES[pronta.capacidade as keyof typeof SETORES]);
    const schema = (linha.tipo === 'integracao' ? ResultadoExecucaoSchema : ArtefatoPropostoSchema) as z.ZodType<unknown>;
    const prompt = construirArtefatos(
      d.demanda,
      d.conversa,
      tarefaPrompt,
      objetivosDoPlano,
      dependencias,
      d.modeloTrabalho,
      sistema,
      schema,
      linha.tipo === 'integracao',
      linha.tipo === 'integracao' ? instrucaoEntrega : null,
    );
    if (!prompt) {
      const falha = await falharPorContextoExcedido(d.pool, pronta.id);
      if (falha.registrada) {
        await d.emitir('tarefa_falhou', 'sistema', { claimId: null, tipo: pronta.tipo, tentativa: 0, codigoErro: 'contexto_excedido', definitiva: true }, pronta.id);
        await d.emitir('plano_abandonado', 'sistema', { planoId: falha.planoId, versao: falha.versao, motivoAbandono: 'tarefa_falhou', tarefasCanceladas: falha.tarefasCanceladas });
      }
      throw new Error('contexto_excedido');
    }

    const claim = await reivindicarTarefa(d.pool, pronta.id);
    if (!claim.reivindicada) {
      if (claim.motivo === 'agente_indisponivel') {
        const abandono = await comTransacao(d.pool, (cliente) => abandonarPlano(cliente, { planoId: plano.id, motivo: 'agente_indisponivel' }));
        if (abandono.abandonado) {
          await d.emitir('plano_abandonado', 'sistema', { planoId: plano.id, versao: abandono.versao, motivoAbandono: 'agente_indisponivel', tarefasCanceladas: abandono.tarefasCanceladas });
        }
        await fixarRotaLegado(d.pool, { demandaId: d.demanda.id, motivo: 'agente_indisponivel' });
        throw new RotaLegadoFixadaError('agente_indisponivel', 'Agente indisponível para a tarefa.');
      }
      continue;
    }
    const tarefa = claim.tarefa;
    await d.emitir('agente_selecionado', tarefa.agente.chave, { claimId: tarefa.claimId, agente: tarefa.agente.chave, versaoAgente: tarefa.agente.versao, capacidade: tarefa.capacidade }, tarefa.id);
    await avaliarTarefa(d, tarefa, 'pre');
    await avaliarTarefa(d, tarefa, 'during');
    try {
      await d.llm.verificarPodeIniciar?.();
    } catch (erro) {
      await desistirDoClaim(d, tarefa);
      const codigo = erro instanceof Error && erro.message.startsWith('Frota pausada') ? 'frota_pausada' : 'orcamento_excedido';
      await d.emitir('tarefa_devolvida', 'sistema', { claimId: tarefa.claimId, codigoErro: codigo }, tarefa.id);
      throw erro;
    }
    const valorReserva = reservaUsd(tarefa.agente.modelo, { bytesEntrada: prompt.medida.bytesEntrada, maxTokens: MAX_TOKENS_TAREFA });
    const envio = await reservarERegistrarEnvio(d.pool, { tarefaId: tarefa.id, leaseToken: tarefa.leaseToken, valorReservadoUsd: valorReserva });
    if (!envio.registrado) {
      if (envio.motivo === 'custo_demanda_excedido') {
        await bloquearDemandaPorCusto(d, tarefa);
        await d.emitir('custo_demanda_excedido', 'sistema', { comprometidoUsd: envio.comprometidoUsd, reservaUsd: envio.reservaUsd, limiteUsd: envio.limiteUsd, operacao: tarefa.tipo === 'integracao' ? 'integracao' : 'execucao' }, tarefa.id);
        throw new Error('custo_demanda_excedido');
      }
      await desistirDoClaim(d, tarefa);
      continue;
    }
    await d.emitir('tarefa_iniciada', tarefa.agente.chave, { claimId: tarefa.claimId, tipo: tarefa.tipo, tentativa: envio.tentativa, maxTentativas: tarefa.maxTentativas, artefatosIntegrais: prompt.artefatosIntegrais, artefatosSoResumo: prompt.artefatosSoResumo, conversaOmitida: prompt.conversaOmitida }, tarefa.id);

    try {
      const resposta = await d.llm.gerarComReserva(
        {
          modelo: tarefa.agente.modelo,
          papel: tarefa.agente.chave,
          sistema,
          usuario: prompt.usuario,
          schema,
          maxTokens: MAX_TOKENS_TAREFA,
          contexto: { runId: d.runId, demandaId: d.demanda.id },
        },
        { reservaId: envio.reservaId, runId: d.runId, timeoutMs: tarefa.timeoutSegundos * 1000 },
      );
      if (linha.tipo === 'especialista') {
        const validacao = validarArtefato(ArtefatoPropostoSchema.parse(resposta.valor), 'especialista', new Set(dependencias.map((x) => x.tarefaId)));
        if (!validacao.valido) {
          await abandonarParaLegadoPorTarefa(d, tarefa, 'artefato_invalido');
          throw new Error('artefato_invalido');
        }
        if (!agentePodeGerarArtefatoIntermediario({ papel: tarefa.agente.papel, estado: 'ativo' }, validacao.artefato.formato)) {
          await abandonarParaLegadoPorTarefa(d, tarefa, 'artefato_invalido');
          throw new Error('artefato_invalido');
        }
        const concluida = await concluirTarefaEspecialista(d.pool, { tarefaId: tarefa.id, leaseToken: tarefa.leaseToken, artefato: validacao.artefato });
        if (!concluida.persistido) {
          await d.emitir('tarefa_resultado_descartado', tarefa.agente.chave, { claimId: tarefa.claimId, tentativa: envio.tentativa, motivoDescarte: concluida.motivoDescarte }, tarefa.id);
          continue;
        }
        await d.emitir('tarefa_concluida', tarefa.agente.chave, { claimId: tarefa.claimId, tipo: tarefa.tipo, tentativa: envio.tentativa, artefatoId: concluida.artefatoId, bytes: concluida.bytes, totalReferencias: concluida.totalReferencias, referenciasDescartadas: 0, duracaoMs: resposta.duracaoMs }, tarefa.id);
      } else {
        const exec = ResultadoExecucaoSchema.parse(resposta.valor);
        const validacaoEntrega = validarResultadoExecucao(exec, entregaEsperada);
        if (!validacaoEntrega.valida) {
          throw new LlmError('invalido', mensagemEntregaInvalida(validacaoEntrega));
        }
        const coordenador = await obterAgentePorChave(d.pool, tarefa.agente.chave);
        if (!coordenador) throw new Error('coordenador não encontrado no catálogo');
        const entregaveis = prepararArtefatosEntregaveis(exec.artefatos, coordenador, coordenador);
        // O artefato intermediário da integração guarda somente a projeção estrutural: bytes finais já foram
        // renderizados pelo servidor e seus conteúdos não são duplicados dentro de artefatos_tarefa.
        const projecao = {
          ...exec,
          entrega: exec.entrega ? { tipo: exec.entrega.tipo, titulo: exec.entrega.titulo } : null,
          artefatos: exec.artefatos.map((a) => ({ nomeArquivo: a.nomeArquivo, formato: a.formato })),
        };
        const artefato: ArtefatoValidado = { formato: 'json', resumo: 'Projeção estruturada da integração.', conteudo: JSON.stringify(projecao), referencias: [] };
        const concluida = await concluirIntegracao(d.pool, {
          tarefaId: tarefa.id,
          leaseToken: tarefa.leaseToken,
          artefato,
          entrega: { titulo: exec.entrega?.titulo ?? 'Resumo da execução', conteudo: exec.entrega?.conteudo ?? exec.resumo },
          entregaveis,
          publicadoPor: coordenador.chave,
        });
        if (!concluida.persistido) {
          await d.emitir('tarefa_resultado_descartado', tarefa.agente.chave, { claimId: tarefa.claimId, tentativa: envio.tentativa, motivoDescarte: concluida.motivoDescarte }, tarefa.id);
          continue;
        }
        resultadoIntegracao = exec;
        entregaId = concluida.entregaId;
        await concluirPlano(d.pool, plano.id);
        await d.emitir('tarefa_concluida', tarefa.agente.chave, { claimId: tarefa.claimId, tipo: tarefa.tipo, tentativa: envio.tentativa, artefatoId: concluida.artefatoId, bytes: concluida.bytes, totalReferencias: concluida.totalReferencias, referenciasDescartadas: 0, duracaoMs: resposta.duracaoMs }, tarefa.id);
        await d.emitir('plano_concluido', tarefa.agente.chave, { planoId: plano.id, versao: plano.versao, entregaId: entregaId! });
      }
      await avaliarTarefa(d, tarefa, 'post');
    } catch (erro) {
      if (erro instanceof RotaLegadoFixadaError) throw erro;
      if (erro instanceof Error && erro.message === 'contexto_excedido') throw erro;
      // Falhas de infraestrutura, timeout e prazo não fixam a rota nesta execução: a reserva permanece
      // retida quando necessário e o watchdog/uma retomada futura decide o próximo passo. Só falhas de
      // conteúdo classificáveis (recusa, truncamento, schema inválido ou status HTTP determinístico)
      // podem abandonar o plano e cair no legado.
      if (
        !(erro instanceof LlmError) ||
        erro.tipo === 'timeout' ||
        (erro.tipo === 'api' && (erro.status === null || erro.status >= 408 && erro.status !== 422))
      ) {
        throw erro;
      }
      const codigo = tipoErroTarefa(erro);
      await abandonarParaLegadoPorTarefa(d, tarefa, codigo);
    }
  }
  if (!resultadoIntegracao || !entregaId) throw new Error('Plano terminou sem tarefa de integração concluída.');
  return { planoId: plano.id, plano, execucao: resultadoIntegracao, entregaId, duracaoMs: relogio.agora() - relogio.iniciouEm };
}
