import type pg from 'pg';
import { agenteEstaAutorizado } from '../db/agentes.ts';
import type { Demanda } from '../db/demandas.ts';
import type { EstagioPolitica } from '../db/politicas.ts';
import { PlanoPropostoSchema, registrarPlanoRejeitado, registrarPlanoShadow, validarPlano } from '../db/planos.ts';
import { SETORES } from '../domain/setores.ts';
import type { Llm } from '../llm/llm.ts';
import { log } from '../util/log.ts';
import { AgenteNaoAutorizadoError, codigoDoErro } from './erros.ts';
import { sistemaPlanejamento, usuarioExecucao, type FalaDaConversa } from './prompts.ts';
import type { EmitirEvento } from './processar-demanda.ts';

export const PAPEL_COORDENADOR = SETORES.gestores.papel;
const MAX_TOKENS_PLANEJAMENTO = 2_000;

export interface ContextoPlanejamento {
  pool: pg.Pool;
  llm: Llm;
  modelo: string;
  demanda: Demanda;
  // A mesma conversa (pedido da frota e resposta do solicitante) que a execução legada recebe, carregada uma
  // única vez por processarDemanda. Entra só no prompt, dentro de <demanda>; nunca é gravada aqui.
  conversa: readonly FalaDaConversa[];
  runId: string;
  emitir: EmitirEvento;
  // Avaliação de política (modo shadow) com operacao "planejamento": nunca lança, nunca bloqueia.
  avaliar: (estagio: EstagioPolitica) => Promise<void>;
}

// Fase 3.1, modo "planejar": o coordenador propõe um plano, a validação determinística decide se ele é
// válido e o resultado é gravado em planos_demanda/tarefas como shadow. Nada aqui altera a demanda nem o
// que o fluxo legado faz depois: é fail-open por inteiro. Uma falha (API, orçamento, pausa, catálogo,
// banco) é logada e registrada como planejamento_falhou, e a demanda segue pelo fluxo atual — que, se for
// uma parada sistêmica, vai encontrar a mesma condição e tratá-la do jeito de sempre.
//
// Nenhuma transação fica aberta durante a chamada ao modelo: a gravação do plano é uma transação curta
// depois que a resposta chegou (ver registrarPlanoShadow em src/db/planos.ts).
export async function planejarEmShadow(c: ContextoPlanejamento): Promise<void> {
  try {
    await c.avaliar('pre');
    if (!(await agenteEstaAutorizado(c.pool, PAPEL_COORDENADOR, c.modelo))) throw new AgenteNaoAutorizadoError(PAPEL_COORDENADOR);
    await c.avaliar('during');
    const { valor: proposta } = await c.llm.gerar({
      modelo: c.modelo,
      papel: PAPEL_COORDENADOR,
      sistema: sistemaPlanejamento(),
      usuario: usuarioExecucao(c.demanda, c.conversa),
      schema: PlanoPropostoSchema,
      maxTokens: MAX_TOKENS_PLANEJAMENTO,
      contexto: { runId: c.runId, demandaId: c.demanda.id },
    });

    const validacao = validarPlano(proposta);
    if (validacao.valido) {
      const plano = await registrarPlanoShadow(c.pool, { demandaId: c.demanda.id, runId: c.runId, tarefas: validacao.tarefas });
      await c.emitir('plano_registrado', PAPEL_COORDENADOR, {
        planoId: plano.id,
        versao: plano.versao,
        modo: 'shadow',
        totalTarefas: plano.totalTarefas,
        totalDependencias: plano.totalDependencias,
      });
    } else {
      const plano = await registrarPlanoRejeitado(c.pool, { demandaId: c.demanda.id, runId: c.runId, motivo: validacao.motivo });
      await c.emitir('plano_rejeitado', PAPEL_COORDENADOR, {
        planoId: plano.id,
        versao: plano.versao,
        motivoRejeicao: validacao.motivo,
      });
    }
    await c.avaliar('post');
  } catch (erro) {
    const codigoErro = codigoDoErro(erro);
    log('erro', 'erro_planejamento', { demandaId: c.demanda.id, codigoErro });
    await c.emitir('planejamento_falhou', PAPEL_COORDENADOR, { codigoErro });
  }
}
