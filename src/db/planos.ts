import type pg from 'pg';
import { z } from 'zod';
import { comTransacao } from './tx.ts';

// Fase 3 — Entrega 3.1 (modo "planejar"). O coordenador propõe um plano; a validação aqui é
// determinística (sem modelo) e o plano é só gravado, nunca executado. Ver
// docs/adr/0006-orquestracao-por-tarefas.md.

export const CAPACIDADES_ESPECIALISTA = [
  'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
  'd10', 'd11', 'd12', 'd13', 'd14', 'd15', 'd16', 'd17', 'd18',
] as const;
export type CapacidadeEspecialista = (typeof CAPACIDADES_ESPECIALISTA)[number];

// Limite conservador da fase: até 3 tarefas especialistas, mais a integração que o sistema acrescenta.
export const MAX_TAREFAS_ESPECIALISTAS = 3;
// Reservada para a tarefa de integração, que o próprio sistema cria (nunca o modelo).
export const CHAVE_INTEGRACAO = 'integracao';

const CHAVE_TAREFA_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// O que o modelo pode devolver: só chaves curtas, capacidades de domínio fechado e dependências. Nenhum
// campo de texto livre — nada do que o modelo "pensou" chega ao banco. Os limites do array são folgados de
// propósito (a API não os aplica): quem recusa um plano grande demais é validarPlano, com motivo gravado.
export const PlanoPropostoSchema = z.object({
  tarefas: z
    .array(
      z.object({
        chave: z.string().regex(CHAVE_TAREFA_RE),
        capacidade: z.enum(CAPACIDADES_ESPECIALISTA),
        dependeDe: z.array(z.string().regex(CHAVE_TAREFA_RE)).max(20),
      }),
    )
    .max(20),
});
export type PlanoProposto = z.infer<typeof PlanoPropostoSchema>;

export const MOTIVOS_REJEICAO = [
  'sem_tarefas',
  'limite_tarefas',
  'chave_duplicada',
  'chave_reservada',
  'dependencia_inexistente',
  'autodependencia',
  'ciclo',
] as const;
export type MotivoRejeicao = (typeof MOTIVOS_REJEICAO)[number];

export interface TarefaPlanejada {
  chave: string;
  tipo: 'especialista' | 'integracao';
  capacidade: CapacidadeEspecialista | 'gestores';
  dependeDe: string[];
}

export type ValidacaoPlano = { valido: true; tarefas: TarefaPlanejada[] } | { valido: false; motivo: MotivoRejeicao };

// Determinística: mesma proposta, mesmo resultado. Um plano válido ganha a tarefa de integração, que
// depende de todas as especialistas.
export function validarPlano(proposta: PlanoProposto): ValidacaoPlano {
  const tarefas = proposta.tarefas;
  if (tarefas.length === 0) return { valido: false, motivo: 'sem_tarefas' };
  if (tarefas.length > MAX_TAREFAS_ESPECIALISTAS) return { valido: false, motivo: 'limite_tarefas' };

  const chaves = new Set<string>();
  for (const t of tarefas) {
    if (t.chave === CHAVE_INTEGRACAO) return { valido: false, motivo: 'chave_reservada' };
    if (chaves.has(t.chave)) return { valido: false, motivo: 'chave_duplicada' };
    chaves.add(t.chave);
  }
  for (const t of tarefas) {
    if (t.dependeDe.includes(t.chave)) return { valido: false, motivo: 'autodependencia' };
    if (t.dependeDe.some((dep) => !chaves.has(dep))) return { valido: false, motivo: 'dependencia_inexistente' };
  }
  if (temCiclo(tarefas)) return { valido: false, motivo: 'ciclo' };

  const especialistas: TarefaPlanejada[] = tarefas.map((t) => ({
    chave: t.chave,
    tipo: 'especialista',
    capacidade: t.capacidade,
    dependeDe: [...new Set(t.dependeDe)],
  }));
  const integracao: TarefaPlanejada = {
    chave: CHAVE_INTEGRACAO,
    tipo: 'integracao',
    capacidade: 'gestores',
    dependeDe: especialistas.map((t) => t.chave),
  };
  return { valido: true, tarefas: [...especialistas, integracao] };
}

// Busca em profundidade com três cores: encontrar um nó "em visita" de novo é um ciclo.
function temCiclo(tarefas: PlanoProposto['tarefas']): boolean {
  const deps = new Map(tarefas.map((t) => [t.chave, t.dependeDe]));
  const estado = new Map<string, 'visitando' | 'feito'>();
  const visitar = (chave: string): boolean => {
    const atual = estado.get(chave);
    if (atual === 'visitando') return true;
    if (atual === 'feito') return false;
    estado.set(chave, 'visitando');
    const achou = (deps.get(chave) ?? []).some(visitar);
    estado.set(chave, 'feito');
    return achou;
  };
  return tarefas.some((t) => visitar(t.chave));
}

export interface PlanoGravado {
  id: string;
  versao: number;
  totalTarefas: number;
  totalDependencias: number;
}

// Próxima versão do plano da demanda. Trava a linha da demanda (mesmo mecanismo do ledger) só para
// serializar o cálculo; o UNIQUE (demanda_id, versao) é a garantia final.
async function proximaVersao(cliente: pg.PoolClient, demandaId: string): Promise<number> {
  await cliente.query('SELECT id FROM demandas WHERE id = $1 FOR UPDATE', [demandaId]);
  const { rows } = await cliente.query<{ prox: number }>(
    'SELECT COALESCE(MAX(versao), 0) + 1 AS prox FROM planos_demanda WHERE demanda_id = $1',
    [demandaId],
  );
  return rows[0]!.prox;
}

// Grava um plano válido em modo shadow (registrado, nunca executado), com as tarefas pendentes e as
// dependências, numa única transação curta. Nenhuma chamada a modelo acontece aqui dentro.
export async function registrarPlanoShadow(
  pool: pg.Pool,
  p: { demandaId: string; runId: string | null; tarefas: readonly TarefaPlanejada[] },
): Promise<PlanoGravado> {
  return comTransacao(pool, async (cliente) => {
    const versao = await proximaVersao(cliente, p.demandaId);
    const { rows: planoRows } = await cliente.query<{ id: string }>(
      `INSERT INTO planos_demanda (demanda_id, versao, criado_pela_run_id, modo, estado)
       VALUES ($1, $2, $3, 'shadow', 'registrado') RETURNING id`,
      [p.demandaId, versao, p.runId],
    );
    const planoId = planoRows[0]!.id;
    const ids = new Map<string, string>();
    for (const t of p.tarefas) {
      const { rows } = await cliente.query<{ id: string }>(
        'INSERT INTO tarefas (plano_id, chave, tipo, capacidade) VALUES ($1, $2, $3, $4) RETURNING id',
        [planoId, t.chave, t.tipo, t.capacidade],
      );
      ids.set(t.chave, rows[0]!.id);
    }
    let totalDependencias = 0;
    for (const t of p.tarefas) {
      for (const dep of t.dependeDe) {
        await cliente.query('INSERT INTO tarefas_dependencias (tarefa_id, depende_de_id) VALUES ($1, $2)', [
          ids.get(t.chave),
          ids.get(dep),
        ]);
        totalDependencias++;
      }
    }
    return { id: planoId, versao, totalTarefas: p.tarefas.length, totalDependencias };
  });
}

// Grava a recusa (sem tarefas), com o motivo em código fechado: a proposta inválida fica auditável.
export async function registrarPlanoRejeitado(
  pool: pg.Pool,
  p: { demandaId: string; runId: string | null; motivo: MotivoRejeicao },
): Promise<{ id: string; versao: number }> {
  return comTransacao(pool, async (cliente) => {
    const versao = await proximaVersao(cliente, p.demandaId);
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO planos_demanda (demanda_id, versao, criado_pela_run_id, modo, estado, motivo_rejeicao)
       VALUES ($1, $2, $3, 'shadow', 'rejeitado', $4) RETURNING id`,
      [p.demandaId, versao, p.runId, p.motivo],
    );
    return { id: rows[0]!.id, versao };
  });
}

export interface PlanoResumo {
  id: string;
  demandaId: string;
  versao: number;
  criadoPelaRunId: string | null;
  modo: 'shadow' | 'execucao';
  estado: 'registrado' | 'ativo' | 'concluido' | 'abandonado' | 'rejeitado';
  motivoRejeicao: MotivoRejeicao | null;
  tarefas: { chave: string; tipo: TarefaPlanejada['tipo']; capacidade: string; estado: string; dependeDe: string[] }[];
}

export async function listarPlanosDaDemanda(pool: pg.Pool, demandaId: string): Promise<PlanoResumo[]> {
  const { rows: planos } = await pool.query<{
    id: string;
    demanda_id: string;
    versao: number;
    criado_pela_run_id: string | null;
    modo: PlanoResumo['modo'];
    estado: PlanoResumo['estado'];
    motivo_rejeicao: MotivoRejeicao | null;
  }>(
    `SELECT id, demanda_id, versao, criado_pela_run_id, modo, estado, motivo_rejeicao
       FROM planos_demanda WHERE demanda_id = $1 ORDER BY versao`,
    [demandaId],
  );
  const { rows: tarefas } = await pool.query<{
    plano_id: string;
    chave: string;
    tipo: TarefaPlanejada['tipo'];
    capacidade: string;
    estado: string;
    depende_de: string[];
  }>(
    `SELECT t.plano_id, t.chave, t.tipo, t.capacidade, t.estado,
            COALESCE(array_agg(d.chave ORDER BY d.chave) FILTER (WHERE d.chave IS NOT NULL), '{}') AS depende_de
       FROM tarefas t
       JOIN planos_demanda p ON p.id = t.plano_id
       LEFT JOIN tarefas_dependencias td ON td.tarefa_id = t.id
       LEFT JOIN tarefas d ON d.id = td.depende_de_id
      WHERE p.demanda_id = $1
      GROUP BY t.id
      -- Todas as tarefas de um plano nascem na mesma transação (mesmo now()): a integração vem por último
      -- e as especialistas em ordem de chave, para a leitura ser estável.
      ORDER BY t.tipo = 'integracao', t.criado_em, t.chave`,
    [demandaId],
  );
  return planos.map((p) => ({
    id: p.id,
    demandaId: p.demanda_id,
    versao: p.versao,
    criadoPelaRunId: p.criado_pela_run_id,
    modo: p.modo,
    estado: p.estado,
    motivoRejeicao: p.motivo_rejeicao,
    tarefas: tarefas
      .filter((t) => t.plano_id === p.id)
      .map((t) => ({ chave: t.chave, tipo: t.tipo, capacidade: t.capacidade, estado: t.estado, dependeDe: t.depende_de })),
  }));
}
