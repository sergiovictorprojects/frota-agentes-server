import type pg from 'pg';
import type { ArtefatoValidado } from '../../src/db/artefatos.ts';
import { criarDemanda } from '../../src/db/demandas.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import { criarEnvelope } from '../../src/db/orquestracao.ts';
import { registrarPlanoExecucao, validarPlanoExecucao, type PlanoExecucaoProposto } from '../../src/db/planos.ts';
import {
  ativarPlano,
  concluirTarefaEspecialista,
  reivindicarProximaTarefa,
  reservarERegistrarEnvio,
  type TarefaReivindicada,
} from '../../src/db/tarefas.ts';
import { comTransacao } from '../../src/db/tx.ts';

// Fixtures da Fase 3.2a: demanda com envelope, plano em execução registrado ou ativo, claim e envio. Tudo pelo
// código de produção, para os testes passarem pelos mesmos caminhos que a PR 3.2b vai usar. SQL direto fica nos
// próprios testes, só onde o ponto é provar o que o banco recusa.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DemandaDeTeste {
  demandaId: string;
  runId: string;
}

export interface EspecialistaDeTeste {
  chave: string;
  capacidade: PlanoExecucaoProposto['tarefas'][number]['capacidade'];
  dependeDe?: string[];
  objetivo?: string;
}

export interface PlanoDeTeste extends DemandaDeTeste {
  planoId: string;
  versao: number;
  // Id de cada tarefa pela chave (a integração é "integracao").
  ids: Record<string, string>;
}

export async function novaDemanda(pool: pg.Pool): Promise<DemandaDeTeste> {
  const demanda = await criarDemanda(pool, { titulo: 'Demanda de execucao por tarefas', categoria: 'd1' });
  return { demandaId: demanda.id, runId: await iniciarRun(pool) };
}

export async function demandaComEnvelope(pool: pg.Pool, tetoBaseUsd = '2.00'): Promise<DemandaDeTeste> {
  const d = await novaDemanda(pool);
  await criarEnvelope(pool, { demandaId: d.demandaId, tetoBaseUsd });
  return d;
}

export async function registrarPlanoDeTeste(
  pool: pg.Pool,
  d: DemandaDeTeste,
  especialistas: EspecialistaDeTeste[] = [{ chave: 'analise', capacidade: 'd1' }],
): Promise<PlanoDeTeste> {
  const validacao = validarPlanoExecucao({
    tarefas: especialistas.map((e) => ({
      chave: e.chave,
      capacidade: e.capacidade,
      objetivo: e.objetivo ?? `Objetivo da tarefa ${e.chave}`,
      dependeDe: e.dependeDe ?? [],
    })),
  });
  if (!validacao.valido) throw new Error(`plano de teste invalido: ${validacao.motivo}`);
  const plano = await registrarPlanoExecucao(pool, { demandaId: d.demandaId, runId: d.runId, tarefas: validacao.tarefas });
  const { rows } = await pool.query<{ id: string; chave: string }>('SELECT id, chave FROM tarefas WHERE plano_id = $1', [plano.id]);
  return { demandaId: d.demandaId, runId: d.runId, planoId: plano.id, versao: plano.versao, ids: Object.fromEntries(rows.map((l) => [l.chave, l.id])) };
}

// Demanda nova, envelope, plano registrado e ativado.
export async function planoAtivoDeTeste(
  pool: pg.Pool,
  especialistas?: EspecialistaDeTeste[],
  opcoes: { tetoBaseUsd?: string } = {},
): Promise<PlanoDeTeste> {
  const d = await demandaComEnvelope(pool, opcoes.tetoBaseUsd);
  const plano = await registrarPlanoDeTeste(pool, d, especialistas);
  const ativacao = await ativarPlano(pool, plano.planoId);
  if (!ativacao.ativado) throw new Error('plano de teste nao ativou');
  return plano;
}

export async function reivindicar(pool: pg.Pool, planoId: string): Promise<TarefaReivindicada> {
  const r = await reivindicarProximaTarefa(pool, planoId);
  if (!r.reivindicada) throw new Error(`claim de teste falhou: ${r.motivo}`);
  return r.tarefa;
}

export async function enviar(
  pool: pg.Pool,
  tarefa: TarefaReivindicada,
  opcoes: { valorReservadoUsd?: string } = {},
): Promise<{ reservaId: string; tentativa: number }> {
  const envio = await reservarERegistrarEnvio(pool, {
    tarefaId: tarefa.id,
    leaseToken: tarefa.leaseToken,
    valorReservadoUsd: opcoes.valorReservadoUsd ?? '0.050000',
  });
  if (!envio.registrado) throw new Error(`envio de teste falhou: ${envio.motivo}`);
  return { reservaId: envio.reservaId, tentativa: envio.tentativa };
}

// Simula a passagem do tempo: o lease da tarefa e a reserva aberta do claim, se houver, vencem agora. O banco não
// aceita lease curto (de 120 a 900 segundos além do timeout), então só dá para vencer um lease sem esperar
// desligando os gatilhos nesta transação (session_replication_role, que exige o superusuário dos testes). Os
// CHECK continuam valendo. Uso exclusivo dos testes; nada no código de produção faz isso.
export async function vencerLease(pool: pg.Pool, tarefaId: string): Promise<void> {
  await comTransacao(pool, async (c) => {
    await c.query('SET LOCAL session_replication_role = replica');
    const { rowCount } = await c.query(
      "UPDATE tarefas SET lease_expira_em = now() - interval '1 second' WHERE id = $1 AND estado = 'em_execucao'",
      [tarefaId],
    );
    if (rowCount !== 1) throw new Error('vencerLease: a tarefa não está em execução');
    await c.query(
      `UPDATE reservas_custo r SET expira_em = r.criada_em + interval '1 microsecond'
         FROM tarefas t
        WHERE t.id = $1 AND r.tarefa_id = t.id AND r.claim_id = t.claim_id AND r.estado = 'aberta'`,
      [tarefaId],
    );
  });
}

export async function reivindicarEEnviar(
  pool: pg.Pool,
  planoId: string,
  opcoes: { valorReservadoUsd?: string } = {},
): Promise<{ tarefa: TarefaReivindicada; reservaId: string }> {
  const tarefa = await reivindicar(pool, planoId);
  const { reservaId } = await enviar(pool, tarefa, opcoes);
  return { tarefa, reservaId };
}

export function artefatoDeTeste(
  conteudo = 'Resultado da tarefa.',
  referencias: ArtefatoValidado['referencias'] = [],
  formato: ArtefatoValidado['formato'] = 'texto',
): ArtefatoValidado {
  return { formato, resumo: 'Resumo do resultado.', conteudo, referencias };
}

// Conclui as especialistas na ordem do claim e devolve a integração reivindicada e com o envio registrado.
export async function levarAteIntegracao(pool: pg.Pool, planoId: string): Promise<TarefaReivindicada> {
  for (;;) {
    const { tarefa } = await reivindicarEEnviar(pool, planoId);
    if (tarefa.tipo === 'integracao') return tarefa;
    const r = await concluirTarefaEspecialista(pool, { tarefaId: tarefa.id, leaseToken: tarefa.leaseToken, artefato: artefatoDeTeste() });
    if (!r.persistido) throw new Error(`conclusao de teste descartada: ${r.motivoDescarte}`);
  }
}

export async function linhaDaTarefa(pool: pg.Pool, tarefaId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query('SELECT * FROM tarefas WHERE id = $1', [tarefaId]);
  if (!rows[0]) throw new Error('tarefa inexistente');
  return rows[0] as Record<string, unknown>;
}

export async function contarPassos(pool: pg.Pool, demandaId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM agent_steps WHERE demanda_id = $1', [demandaId]);
  return rows[0]!.n;
}

export const esperar = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
