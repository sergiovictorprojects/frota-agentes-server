import type pg from 'pg';
import { z } from 'zod';
import { CARACTERE_DE_CONTROLE_RE, comprimento, textoArmazenavel } from './artefatos.ts';
import { comTransacao, type Db } from './tx.ts';

// Fase 3 — Entrega 3.1 (modo "planejar"). O coordenador propõe um plano; a validação aqui é
// determinística (sem modelo) e o plano é só gravado, nunca executado. Ver
// docs/adr/0006-orquestracao-por-tarefas.md.
//
// Fase 3.2a: o plano em execução (modo "execucao"), com objetivo por especialista e a máquina de estados da
// migration 006. Nada aqui liga a execução: a PR 3.2b é quem cria planos em execução. Ver
// docs/adr/0007-execucao-sequencial-e-teto-de-custo.md.

// Vocabulário que o modelo pode devolver: as 18 especialidades do domínio (Categoria sem "gestores").
const CAPACIDADES_DOMINIO = [
  'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
  'd10', 'd11', 'd12', 'd13', 'd14', 'd15', 'd16', 'd17', 'd18',
] as const;

// O que pode executar uma tarefa. d17 fica de fora: é o auditor (frota:agent-evaluator), registrado no
// catálogo com papel "auditor", e nunca é especialista executor. Um plano que o use é rejeitado com motivo
// próprio (em vez de falhar no schema), para a recusa ficar auditável. Mesma lista do CHECK de
// tarefas.capacidade na migration 005.
export const CAPACIDADES_ESPECIALISTA = [
  'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
  'd10', 'd11', 'd12', 'd13', 'd14', 'd15', 'd16', 'd18',
] as const;
export type CapacidadeEspecialista = (typeof CAPACIDADES_ESPECIALISTA)[number];
const ESPECIALISTAS = new Set<string>(CAPACIDADES_ESPECIALISTA);

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
        capacidade: z.enum(CAPACIDADES_DOMINIO),
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
  'capacidade_nao_executora',
  'dependencia_inexistente',
  'autodependencia',
  'ciclo',
  // Fase 3.2: só no plano em execução, quando um objetivo sai do formato fechado.
  'objetivo_invalido',
] as const;
export type MotivoRejeicao = (typeof MOTIVOS_REJEICAO)[number];

// Vocabulários da migration 006 (mesmos CHECK do banco).
export const MODOS_PLANO = ['shadow', 'execucao'] as const;
export type ModoPlano = (typeof MODOS_PLANO)[number];
export const ESTADOS_PLANO = ['registrado', 'rejeitado', 'ativo', 'concluido', 'abandonado'] as const;
export type EstadoPlano = (typeof ESTADOS_PLANO)[number];
export const MOTIVOS_ABANDONO = [
  'tarefa_falhou',
  'agente_indisponivel',
  'pendencia_humana',
  'orquestracao_desligada',
  'demanda_encerrada',
] as const;
export type MotivoAbandono = (typeof MOTIVOS_ABANDONO)[number];
export const ESTADOS_TAREFA = ['pendente', 'pronta', 'em_execucao', 'concluida', 'falhou', 'cancelada'] as const;
export type EstadoTarefa = (typeof ESTADOS_TAREFA)[number];

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
    if (!ESPECIALISTAS.has(t.capacidade)) return { valido: false, motivo: 'capacidade_nao_executora' };
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
    capacidade: t.capacidade as CapacidadeEspecialista,
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

// Fase 3.2 (decisão 1B): cada especialista de um plano em execução traz um objetivo curto. É texto do modelo:
// imutável, vai para o prompt só pela serialização canônica e nunca aparece em eventos, dossiê, logs ou
// interface. O banco repete a regra (tarefas_objetivo_check), exceto a de não ser só espaço, que é só daqui.
export const LIMITE_OBJETIVO = 300;
const SINAL_DE_TAG_RE = /[<>]/;

export function objetivoValido(objetivo: string): boolean {
  const n = comprimento(objetivo);
  return (
    n >= 1 &&
    n <= LIMITE_OBJETIVO &&
    objetivo.trim().length > 0 &&
    textoArmazenavel(objetivo) &&
    !CARACTERE_DE_CONTROLE_RE.test(objetivo) &&
    !SINAL_DE_TAG_RE.test(objetivo)
  );
}

// O mesmo formato de PlanoPropostoSchema, mais o objetivo de cada especialista. O objetivo é folgado de
// propósito: quem recusa é validarPlanoExecucao, com o motivo objetivo_invalido gravado.
export const PlanoExecucaoPropostoSchema = z.object({
  tarefas: z
    .array(
      z.object({
        chave: z.string().regex(CHAVE_TAREFA_RE),
        capacidade: z.enum(CAPACIDADES_DOMINIO),
        objetivo: z.string(),
        dependeDe: z.array(z.string().regex(CHAVE_TAREFA_RE)).max(20),
      }),
    )
    .max(20),
});
export type PlanoExecucaoProposto = z.infer<typeof PlanoExecucaoPropostoSchema>;

export interface TarefaPlanejadaExecucao extends TarefaPlanejada {
  // Nulo só na integração.
  objetivo: string | null;
}

export type ValidacaoPlanoExecucao =
  | { valido: true; tarefas: TarefaPlanejadaExecucao[] }
  | { valido: false; motivo: MotivoRejeicao };

// Mesmas regras de validarPlano, na mesma ordem, e depois os objetivos. Determinística.
export function validarPlanoExecucao(proposta: PlanoExecucaoProposto): ValidacaoPlanoExecucao {
  const estrutura = validarPlano({
    tarefas: proposta.tarefas.map((t) => ({ chave: t.chave, capacidade: t.capacidade, dependeDe: t.dependeDe })),
  });
  if (!estrutura.valido) return estrutura;
  if (proposta.tarefas.some((t) => !objetivoValido(t.objetivo))) return { valido: false, motivo: 'objetivo_invalido' };
  const objetivos = new Map(proposta.tarefas.map((t) => [t.chave, t.objetivo]));
  return {
    valido: true,
    tarefas: estrutura.tarefas.map((t) => ({ ...t, objetivo: t.tipo === 'especialista' ? objetivos.get(t.chave)! : null })),
  };
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
  return comTransacao(pool, (cliente) =>
    gravarPlano(cliente, { ...p, modo: 'shadow', tarefas: p.tarefas.map((t) => ({ ...t, objetivo: null })) }),
  );
}

// Fase 3.2: grava um plano válido em modo execução, registrado e ainda não ativo, com os objetivos. O banco
// exige o envelope da demanda na rota tarefas (gatilho planos_demanda_controla); quem ativa é ativarPlano, em
// src/db/tarefas.ts.
export async function registrarPlanoExecucao(
  pool: pg.Pool,
  p: { demandaId: string; runId: string | null; tarefas: readonly TarefaPlanejadaExecucao[] },
): Promise<PlanoGravado> {
  return comTransacao(pool, (cliente) => gravarPlano(cliente, { ...p, modo: 'execucao' }));
}

async function gravarPlano(
  cliente: pg.PoolClient,
  p: { demandaId: string; runId: string | null; modo: ModoPlano; tarefas: readonly TarefaPlanejadaExecucao[] },
): Promise<PlanoGravado> {
  const versao = await proximaVersao(cliente, p.demandaId);
  const { rows: planoRows } = await cliente.query<{ id: string }>(
    `INSERT INTO planos_demanda (demanda_id, versao, criado_pela_run_id, modo, estado)
     VALUES ($1, $2, $3, $4, 'registrado') RETURNING id`,
    [p.demandaId, versao, p.runId, p.modo],
  );
  const planoId = planoRows[0]!.id;
  const ids = new Map<string, string>();
  for (const t of p.tarefas) {
    const { rows } = await cliente.query<{ id: string }>(
      'INSERT INTO tarefas (plano_id, chave, tipo, capacidade, objetivo) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [planoId, t.chave, t.tipo, t.capacidade, t.objetivo],
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
}

// Grava a recusa (sem tarefas), com o motivo em código fechado: a proposta inválida fica auditável. O modo
// padrão é shadow (Fase 3.1); a recusa de um plano em execução exige o envelope, como o plano registrado.
export async function registrarPlanoRejeitado(
  pool: pg.Pool,
  p: { demandaId: string; runId: string | null; motivo: MotivoRejeicao; modo?: ModoPlano },
): Promise<{ id: string; versao: number }> {
  return comTransacao(pool, async (cliente) => {
    const versao = await proximaVersao(cliente, p.demandaId);
    const { rows } = await cliente.query<{ id: string }>(
      `INSERT INTO planos_demanda (demanda_id, versao, criado_pela_run_id, modo, estado, motivo_rejeicao)
       VALUES ($1, $2, $3, $4, 'rejeitado', $5) RETURNING id`,
      [p.demandaId, versao, p.runId, p.modo ?? 'shadow', p.motivo],
    );
    return { id: rows[0]!.id, versao };
  });
}

export interface PlanoAtivo {
  id: string;
  demandaId: string;
  versao: number;
  criadoPelaRunId: string | null;
  ativadoEm: string;
}

// O plano ativo da demanda, se houver (no máximo um: índice planos_demanda_um_ativo_idx).
export async function obterPlanoAtivo(db: Db, demandaId: string): Promise<PlanoAtivo | null> {
  const { rows } = await db.query<{
    id: string;
    demanda_id: string;
    versao: number;
    criado_pela_run_id: string | null;
    ativado_em: Date;
  }>(
    `SELECT id, demanda_id, versao, criado_pela_run_id, ativado_em
       FROM planos_demanda WHERE demanda_id = $1 AND estado = 'ativo'`,
    [demandaId],
  );
  const l = rows[0];
  return l
    ? { id: l.id, demandaId: l.demanda_id, versao: l.versao, criadoPelaRunId: l.criado_pela_run_id, ativadoEm: l.ativado_em.toISOString() }
    : null;
}

// Leitura para auditoria e testes. Nunca devolve o objetivo das tarefas (texto do modelo).
export interface PlanoResumo {
  id: string;
  demandaId: string;
  versao: number;
  criadoPelaRunId: string | null;
  modo: ModoPlano;
  estado: EstadoPlano;
  motivoRejeicao: MotivoRejeicao | null;
  motivoAbandono: MotivoAbandono | null;
  tarefas: { chave: string; tipo: TarefaPlanejada['tipo']; capacidade: string; estado: EstadoTarefa; dependeDe: string[] }[];
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
    motivo_abandono: MotivoAbandono | null;
  }>(
    `SELECT id, demanda_id, versao, criado_pela_run_id, modo, estado, motivo_rejeicao, motivo_abandono
       FROM planos_demanda WHERE demanda_id = $1 ORDER BY versao`,
    [demandaId],
  );
  const { rows: tarefas } = await pool.query<{
    plano_id: string;
    chave: string;
    tipo: TarefaPlanejada['tipo'];
    capacidade: string;
    estado: EstadoTarefa;
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
    motivoAbandono: p.motivo_abandono,
    tarefas: tarefas
      .filter((t) => t.plano_id === p.id)
      .map((t) => ({ chave: t.chave, tipo: t.tipo, capacidade: t.capacidade, estado: t.estado, dependeDe: t.depende_de })),
  }));
}
