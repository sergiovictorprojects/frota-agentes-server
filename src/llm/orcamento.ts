import type pg from 'pg';
import { gastoDoMes, mesDe, obterFlags, pausarFrota, registrarAlerta, registrarPasso } from '../db/operacao.ts';
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
