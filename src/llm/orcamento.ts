import type pg from 'pg';
import { gastoDoMes, mesDe, obterFlags, pausarFrota, registrarAlerta, registrarPasso } from '../db/operacao.ts';
import { cancelarReserva, liquidarReserva, reterReserva } from '../db/orquestracao.ts';
import type { Notificador, NivelNotificacao } from '../notify/notificador.ts';
import { LlmError, type Llm, type PedidoLlm, type RespostaLlm } from './llm.ts';
import { custoUsd, modeloConhecido, ModeloDesconhecidoError, type Uso } from './models.ts';

export class FrotaPausadaError extends Error {
  readonly motivo: string;

  constructor(motivo: string) {
    super(`Frota pausada: ${motivo}`);
    this.name = 'FrotaPausadaError';
    this.motivo = motivo;
  }
}

export class OrcamentoExcedidoError extends Error {
  constructor(gasto: number, orcamento: number) {
    super(`Orçamento mensal esgotado: US$ ${gasto.toFixed(2)} de US$ ${orcamento.toFixed(2)}.`);
    this.name = 'OrcamentoExcedidoError';
  }
}

const LIMIARES_PERCENTUAIS = [50, 80, 100] as const;

interface Dependencias {
  llm: Llm;
  pool: pg.Pool;
  orcamentoMensalUsd: number;
  notificador: Notificador;
  agora?: () => Date;
}

// Guarda de gasto: toda chamada ao modelo passa por aqui. Ao atingir 100% do orçamento
// a frota é pausada (kill-switch) e só volta quando alguém a retomar de propósito.
export class LlmComOrcamento implements Llm {
  private readonly d: Dependencias;

  constructor(d: Dependencias) {
    this.d = d;
  }

  // Pré-checagem usada antes do registro de envio de uma tarefa. Assim uma frota pausada ou um orçamento
  // mensal já esgotado não cria tentativa/reserva de tarefa que nunca será enviada.
  async verificarPodeIniciar(): Promise<void> {
    const agora = this.d.agora?.() ?? new Date();
    const flags = await obterFlags(this.d.pool);
    if (flags.pausado) throw new FrotaPausadaError(flags.pausadoMotivo ?? 'sem motivo informado');
    const gasto = await gastoDoMes(this.d.pool, agora);
    if (gasto >= this.d.orcamentoMensalUsd) {
      await this.bloquearPorOrcamento(agora, gasto);
      throw new OrcamentoExcedidoError(gasto, this.d.orcamentoMensalUsd);
    }
  }

  async gerar<T>(pedido: PedidoLlm<T>): Promise<RespostaLlm<T>> {
    if (!modeloConhecido(pedido.modelo)) throw new ModeloDesconhecidoError(pedido.modelo);
    const agora = this.d.agora?.() ?? new Date();

    const flags = await obterFlags(this.d.pool);
    if (flags.pausado) throw new FrotaPausadaError(flags.pausadoMotivo ?? 'sem motivo informado');

    const gasto = await gastoDoMes(this.d.pool, agora);
    if (gasto >= this.d.orcamentoMensalUsd) {
      await this.bloquearPorOrcamento(agora, gasto);
      throw new OrcamentoExcedidoError(gasto, this.d.orcamentoMensalUsd);
    }

    let resposta: RespostaLlm<T>;
    try {
      resposta = await this.d.llm.gerar(pedido);
    } catch (erro) {
      if (erro instanceof LlmError && erro.uso) await this.contabilizar(pedido, erro.uso, null, agora);
      throw erro;
    }
    await this.contabilizar(pedido, resposta.uso, resposta.duracaoMs, agora);
    return resposta;
  }

  // Caminho das demandas com envelope. O custo é liquidado exatamente uma vez pela reserva criada antes do
  // envio; o caminho legado acima continua gravando diretamente em agent_steps. Em caso de timeout, a chamada
  // externa não é abortada pelo contrato atual do Llm: a reserva é retida agora e a continuação tardia liquida
  // o uso quando a API finalmente responder, sem poder persistir artefato com o lease vencido.
  async gerarComReserva<T>(
    pedido: PedidoLlm<T>,
    p: { reservaId: string; runId: string | null; timeoutMs: number },
  ): Promise<RespostaLlm<T>> {
    if (!modeloConhecido(pedido.modelo)) throw new ModeloDesconhecidoError(pedido.modelo);
    const agora = this.d.agora?.() ?? new Date();
    const flags = await obterFlags(this.d.pool);
    if (flags.pausado) {
      await cancelarReserva(this.d.pool, p.reservaId);
      throw new FrotaPausadaError(flags.pausadoMotivo ?? 'sem motivo informado');
    }
    const gasto = await gastoDoMes(this.d.pool, agora);
    if (gasto >= this.d.orcamentoMensalUsd) {
      await cancelarReserva(this.d.pool, p.reservaId);
      await this.bloquearPorOrcamento(agora, gasto);
      throw new OrcamentoExcedidoError(gasto, this.d.orcamentoMensalUsd);
    }

    // Normaliza também uma implementação que lance antes de devolver a Promise: a reserva precisa seguir
    // o mesmo caminho de liquidação/retenção em qualquer falha do adaptador.
    const chamada = Promise.resolve().then(() => this.d.llm.gerar(pedido));
    const liquidarComUso = async (resposta: RespostaLlm<T>): Promise<RespostaLlm<T>> => {
      await liquidarReserva(this.d.pool, {
        reservaId: p.reservaId,
        passo: { runId: p.runId, papel: pedido.papel, uso: resposta.uso, duracaoMs: resposta.duracaoMs },
      });
      await this.avaliarLimiares(agora, await gastoDoMes(this.d.pool, agora));
      return resposta;
    };
    const registrarErroComUso = async (erro: unknown): Promise<never> => {
      if (erro instanceof LlmError && erro.uso) {
        await liquidarReserva(this.d.pool, {
          reservaId: p.reservaId,
          passo: { runId: p.runId, papel: pedido.papel, uso: erro.uso, duracaoMs: null },
        });
        await this.avaliarLimiares(agora, await gastoDoMes(this.d.pool, agora));
      } else if (erro instanceof LlmError && erro.status !== null && [400, 401, 403, 404, 413, 429].includes(erro.status)) {
        await cancelarReserva(this.d.pool, p.reservaId);
      } else {
        await reterReserva(this.d.pool, p.reservaId);
      }
      throw erro;
    };

    const contabilizada = chamada.then(liquidarComUso, registrarErroComUso);
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      temporizador = setTimeout(() => reject(new LlmError('timeout', 'A chamada excedeu o timeout da tarefa.')), p.timeoutMs);
    });
    try {
      return await Promise.race([contabilizada, timeout]);
    } catch (erro) {
      if (erro instanceof LlmError && erro.tipo === 'timeout') {
        await reterReserva(this.d.pool, p.reservaId);
      }
      throw erro;
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  private async contabilizar<T>(pedido: PedidoLlm<T>, uso: Uso, duracaoMs: number | null, agora: Date): Promise<void> {
    await registrarPasso(this.d.pool, {
      runId: pedido.contexto?.runId ?? null,
      demandaId: pedido.contexto?.demandaId ?? null,
      papel: pedido.papel,
      modelo: pedido.modelo,
      tokensIn: uso.inputTokens,
      tokensOut: uso.outputTokens,
      cacheRead: uso.cacheReadTokens,
      cacheWrite: uso.cacheWriteTokens,
      custoUsd: custoUsd(pedido.modelo, uso),
      duracaoMs,
    });
    await this.avaliarLimiares(agora, await gastoDoMes(this.d.pool, agora));
  }

  // A chave inclui o teto: se o orçamento mudar no mesmo mês, os avisos do novo teto voltam a valer.
  private chaveDeAlerta(agora: Date): string {
    return `${mesDe(agora)}@${this.d.orcamentoMensalUsd.toFixed(2)}`;
  }

  private async avaliarLimiares(agora: Date, gasto: number): Promise<void> {
    const orcamento = this.d.orcamentoMensalUsd;
    for (const limiar of LIMIARES_PERCENTUAIS) {
      if (gasto < (orcamento * limiar) / 100) continue;
      // O kill-switch nunca depende da deduplicação do aviso.
      if (limiar === 100) await this.pausarPorOrcamento();
      if (!(await registrarAlerta(this.d.pool, this.chaveDeAlerta(agora), limiar))) continue;

      if (limiar === 100) {
        await this.avisar('critico', 'Frota pausada: orçamento mensal atingido', this.resumoGasto(gasto));
      } else {
        await this.avisar('aviso', `Orçamento mensal em ${limiar}%`, this.resumoGasto(gasto));
      }
    }
  }

  private async pausarPorOrcamento(): Promise<void> {
    await pausarFrota(this.d.pool, `Orçamento mensal de US$ ${this.d.orcamentoMensalUsd.toFixed(2)} atingido`);
  }

  private async bloquearPorOrcamento(agora: Date, gasto: number): Promise<void> {
    await this.pausarPorOrcamento();
    if (await registrarAlerta(this.d.pool, this.chaveDeAlerta(agora), 100)) {
      await this.avisar('critico', 'Frota pausada: orçamento mensal atingido', this.resumoGasto(gasto));
    }
  }

  private resumoGasto(gasto: number): string {
    return `Gasto do mês: US$ ${gasto.toFixed(2)} de US$ ${this.d.orcamentoMensalUsd.toFixed(2)}.`;
  }

  // Falha ao notificar nunca pode derrubar o trabalho nem esconder o estouro de orçamento.
  private async avisar(nivel: NivelNotificacao, titulo: string, corpo: string): Promise<void> {
    try {
      await this.d.notificador.notificar({ nivel, titulo, corpo });
    } catch (erro) {
      console.error(
        JSON.stringify({ tipo: 'erro_notificacao', erro: erro instanceof Error ? erro.message : String(erro) }),
      );
    }
  }
}
