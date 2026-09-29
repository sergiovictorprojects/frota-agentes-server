import type pg from 'pg';
import { z } from 'zod';
import { custoRealUsd, decimalParaInteiro, microParaUsd, usdParaMicro } from '../llm/reserva.ts';
import type { Uso } from '../llm/models.ts';
import { comTransacao, type Db } from './tx.ts';

// Fase 3.2a: envelope da demanda, teto de custo, reservas e autorizações (seções 3.1 e 6 do plano e ADR 0007).
// Nada aqui é chamado pelo fluxo real nesta entrega: a PR 3.2b liga. O banco repete cada regra (migration 006),
// então nem um SQL direto passa do limite, destrava sem autorização ou apaga histórico.
//
// Ordem de locks, a mesma em todas as funções que travam mais de uma linha: tarefa, agente e envelope. Quem
// devolve uma tarefa e bloqueia a demanda na mesma transação (PR 3.2b) devolve a tarefa antes de bloquear.
//
// Dinheiro é sempre texto decimal (numeric no banco, bigint em src/llm/reserva.ts); nunca ponto flutuante.

export const MOTIVOS_LEGADO = ['plano_rejeitado', 'planejamento_falhou', 'tarefa_falhou', 'agente_indisponivel'] as const;
export type MotivoLegado = (typeof MOTIVOS_LEGADO)[number];

export const OPERACOES_CUSTO = ['planejamento', 'execucao', 'integracao', 'auditoria'] as const;
export type OperacaoCusto = (typeof OPERACOES_CUSTO)[number];

export const ESTADOS_RESERVA = ['aberta', 'liquidada', 'cancelada', 'retida', 'reconhecida'] as const;
export type EstadoReserva = (typeof ESTADOS_RESERVA)[number];

// Mesmos intervalos do banco (orquestracao_demandas e autorizacoes_custo), em centavos.
const TETO_BASE_MIN_CENTAVOS = 100n;
const TETO_BASE_MAX_CENTAVOS = 2000n;
const AUTORIZACAO_MIN_CENTAVOS = 50n;
const AUTORIZACAO_MAX_CENTAVOS = 500n;

// Login da requisição autenticada: identificador curto e controlado, o mesmo formato do banco.
const LOGIN_RE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;
const MODELO_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

function centavos(texto: string): bigint | null {
  try {
    return decimalParaInteiro(texto, 2);
  } catch {
    return null;
  }
}

function entre(min: bigint, max: bigint) {
  return (texto: string): boolean => {
    const c = centavos(texto);
    return c !== null && c >= min && c <= max;
  };
}

// Dinheiro com até 2 casas, como texto: "2", "2.5" ou "2.50".
const TetoBaseSchema = z.string().refine(entre(TETO_BASE_MIN_CENTAVOS, TETO_BASE_MAX_CENTAVOS), {
  message: 'O teto base vai de US$ 1,00 a 20,00, com até 2 casas.',
});

export const AutorizacaoCustoSchema = z.strictObject({
  demandaId: z.uuid(),
  valorUsd: z.string().refine(entre(AUTORIZACAO_MIN_CENTAVOS, AUTORIZACAO_MAX_CENTAVOS), {
    message: 'A autorização vai de US$ 0,50 a 5,00, com até 2 casas.',
  }),
  // O limite que o administrador viu na tela: conferido sob lock, para duas autorizações não passarem juntas.
  limiteEsperadoUsd: z.string().refine((t) => centavos(t) !== null, { message: 'Limite em dólar com até 2 casas.' }),
  autorizadoPor: z.string().regex(LOGIN_RE),
});
export type AutorizacaoCusto = z.infer<typeof AutorizacaoCustoSchema>;

export interface Envelope {
  demandaId: string;
  tetoBaseUsd: string;
  rota: 'tarefas' | 'legado_fixo';
  motivoLegado: MotivoLegado | null;
  legadoFixadoEm: string | null;
  bloqueadaPorCusto: boolean;
  bloqueioCustoEm: string | null;
  criadoEm: string;
}

interface LinhaEnvelope {
  demanda_id: string;
  teto_base_usd: string;
  rota: Envelope['rota'];
  motivo_legado: MotivoLegado | null;
  legado_fixado_em: Date | null;
  bloqueada_por_custo: boolean;
  bloqueio_custo_em: Date | null;
  criado_em: Date;
}

const COLUNAS_ENVELOPE =
  'demanda_id, teto_base_usd::text AS teto_base_usd, rota, motivo_legado, legado_fixado_em, bloqueada_por_custo, bloqueio_custo_em, criado_em';

function mapearEnvelope(l: LinhaEnvelope): Envelope {
  return {
    demandaId: l.demanda_id,
    tetoBaseUsd: l.teto_base_usd,
    rota: l.rota,
    motivoLegado: l.motivo_legado,
    legadoFixadoEm: l.legado_fixado_em ? l.legado_fixado_em.toISOString() : null,
    bloqueadaPorCusto: l.bloqueada_por_custo,
    bloqueioCustoEm: l.bloqueio_custo_em ? l.bloqueio_custo_em.toISOString() : null,
    criadoEm: l.criado_em.toISOString(),
  };
}

// Cria o envelope na primeira vez que a demanda entra na orquestração por tarefas. Idempotente: se já existir,
// devolve o existente, com o teto base de quando foi criado (o teto nunca muda).
export async function criarEnvelope(
  db: Db,
  p: { demandaId: string; tetoBaseUsd: string },
): Promise<{ envelope: Envelope; criado: boolean }> {
  const teto = TetoBaseSchema.parse(p.tetoBaseUsd);
  const { rowCount } = await db.query(
    'INSERT INTO orquestracao_demandas (demanda_id, teto_base_usd) VALUES ($1, $2) ON CONFLICT (demanda_id) DO NOTHING',
    [p.demandaId, teto],
  );
  const envelope = await obterEnvelope(db, p.demandaId);
  return { envelope: envelope!, criado: rowCount === 1 };
}

export async function obterEnvelope(db: Db, demandaId: string): Promise<Envelope | null> {
  const { rows } = await db.query<LinhaEnvelope>(`SELECT ${COLUNAS_ENVELOPE} FROM orquestracao_demandas WHERE demanda_id = $1`, [
    demandaId,
  ]);
  return rows[0] ? mapearEnvelope(rows[0]) : null;
}

// Fixa a rota legado_fixo, uma única vez (o banco recusa voltar). Com plano ativo, precisa estar na mesma
// transação que o abandona: o gatilho adiado recusa o COMMIT se sobrar plano ativo (abandonarPlano, em
// src/db/tarefas.ts, faz as duas coisas). Devolve false se a rota já estava fixada.
export async function fixarRotaLegado(db: Db, p: { demandaId: string; motivo: MotivoLegado }): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE orquestracao_demandas SET rota = 'legado_fixo', motivo_legado = $2 WHERE demanda_id = $1 AND rota = 'tarefas'",
    [p.demandaId, p.motivo],
  );
  return rowCount === 1;
}

export interface SituacaoCusto {
  // Teto base mais as autorizações.
  limiteUsd: string;
  // Gasto realizado (agent_steps, histórico inteiro) mais as reservas aberta, retida e reconhecida.
  comprometidoUsd: string;
  disponivelUsd: string;
}

// Leitura para a pré-checagem (seção 5.2, passo 2) e para a tela. Sem lock: a decisão que vale é a da reserva.
export async function situacaoDeCusto(db: Db, demandaId: string): Promise<SituacaoCusto | null> {
  const { rows } = await db.query<{ limite: string; comprometido: string }>(
    `SELECT orquestracao_limite_usd($1)::numeric(10,2)::text AS limite,
            orquestracao_comprometido_usd($1)::numeric(14,6)::text AS comprometido
       FROM orquestracao_demandas WHERE demanda_id = $1`,
    [demandaId],
  );
  const l = rows[0];
  if (!l) return null;
  const disponivel = usdParaMicro(normalizar(l.limite)) - usdParaMicro(l.comprometido);
  return {
    limiteUsd: l.limite,
    comprometidoUsd: l.comprometido,
    disponivelUsd: microParaUsd(disponivel > 0n ? disponivel : 0n),
  };
}

// "2.50" → "2.500000", para somar e comparar na mesma escala.
function normalizar(usd: string): string {
  return microParaUsd(usdParaMicro(usd));
}

export interface NovaReserva {
  demandaId: string;
  planoId?: string | null;
  tarefaId?: string | null;
  claimId?: string | null;
  operacao: OperacaoCusto;
  modelo: string;
  // Texto decimal com até 6 casas, maior que zero (reservaUsd em src/llm/reserva.ts).
  valorReservadoUsd: string;
  // Timeout da chamada mais a margem: depois disso, uma reserva ainda aberta vira retida (reterReservasVencidas).
  validadeSegundos: number;
}

export type ResultadoReserva =
  | { reservada: true; reservaId: string; valorReservadoUsd: string; expiraEm: string }
  | { reservada: false; motivo: 'demanda_bloqueada' | 'agente_nao_autorizado' }
  | { reservada: false; motivo: 'custo_demanda_excedido'; comprometidoUsd: string; limiteUsd: string; reservaUsd: string };

function validarNovaReserva(r: NovaReserva): string {
  const micro = usdParaMicro(r.valorReservadoUsd);
  if (micro <= 0n) throw new Error('A reserva precisa ser maior que zero.');
  if (!MODELO_RE.test(r.modelo)) throw new Error('Modelo fora do formato fechado.');
  if (!Number.isSafeInteger(r.validadeSegundos) || r.validadeSegundos <= 0) {
    throw new Error('A validade da reserva precisa ser um inteiro positivo de segundos.');
  }
  return microParaUsd(micro);
}

// Bloco de construção: roda na transação de quem chama (reservarCusto abaixo, ou reservarERegistrarEnvio em
// src/db/tarefas.ts). Trava o envelope, recalcula o comprometido em numeric e só grava se couber no limite. O
// gatilho de reservas_custo repete a conta sob o mesmo lock. Nada é gravado quando a reserva é recusada.
export async function reservarCustoNaTransacao(cliente: pg.PoolClient, r: NovaReserva): Promise<ResultadoReserva> {
  const valor = validarNovaReserva(r);
  const { rows: envelope } = await cliente.query<{ bloqueada_por_custo: boolean }>(
    'SELECT bloqueada_por_custo FROM orquestracao_demandas WHERE demanda_id = $1 FOR UPDATE',
    [r.demandaId],
  );
  if (!envelope[0]) throw new Error('Demanda sem envelope de orquestração.');
  if (envelope[0].bloqueada_por_custo) return { reservada: false, motivo: 'demanda_bloqueada' };

  const { rows: conta } = await cliente.query<{ comprometido: string; limite: string; cabe: boolean }>(
    `SELECT orquestracao_comprometido_usd($1)::numeric(14,6)::text AS comprometido,
            orquestracao_limite_usd($1)::numeric(10,2)::text AS limite,
            orquestracao_comprometido_usd($1) + $2::numeric <= orquestracao_limite_usd($1) AS cabe`,
    [r.demandaId, valor],
  );
  const c = conta[0]!;
  if (!c.cabe) {
    return { reservada: false, motivo: 'custo_demanda_excedido', comprometidoUsd: c.comprometido, limiteUsd: c.limite, reservaUsd: valor };
  }

  const { rows } = await cliente.query<{ id: string; expira_em: Date }>(
    `INSERT INTO reservas_custo (demanda_id, plano_id, tarefa_id, claim_id, operacao, modelo, valor_reservado_usd, expira_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
     RETURNING id, expira_em`,
    [r.demandaId, r.planoId ?? null, r.tarefaId ?? null, r.claimId ?? null, r.operacao, r.modelo, valor, r.validadeSegundos],
  );
  return { reservada: true, reservaId: rows[0]!.id, valorReservadoUsd: valor, expiraEm: rows[0]!.expira_em.toISOString() };
}

// Reserva de uma chamada sem tarefa (planejamento, fallback, legado_fixo e auditoria de uma demanda com
// envelope), numa transação curta: autorização final do agente (FOR SHARE: ativo e com o modelo da chamada) e
// depois a reserva. A de uma tarefa é reservarERegistrarEnvio, em src/db/tarefas.ts.
export async function reservarCusto(
  pool: pg.Pool,
  r: Omit<NovaReserva, 'tarefaId' | 'claimId'> & { agenteChave: string },
): Promise<ResultadoReserva> {
  if (r.operacao === 'integracao') throw new Error('A reserva da integração é da tarefa: use reservarERegistrarEnvio.');
  // Parâmetro fora do formato é erro de quem chama: falha antes de qualquer lock, nunca vira um motivo de recusa.
  validarNovaReserva(r);
  return comTransacao(pool, async (cliente) => {
    const { rows } = await cliente.query<{ estado: string; modelo_permitido: string }>(
      'SELECT estado, modelo_permitido FROM agentes WHERE chave = $1 FOR SHARE',
      [r.agenteChave],
    );
    const agente = rows[0];
    if (!agente || agente.estado !== 'ativo' || agente.modelo_permitido !== r.modelo) {
      return { reservada: false, motivo: 'agente_nao_autorizado' };
    }
    return reservarCustoNaTransacao(cliente, r);
  });
}

export interface PassoDaChamada {
  runId: string | null;
  // Chave do agente que fez a chamada, como em agent_steps.papel.
  papel: string;
  uso: Uso;
  duracaoMs: number | null;
}

export type ResultadoLiquidacao = {
  agentStepId: string;
  custoRealUsd: string;
  reservaUsd: string;
  // Custo real maior que o reservado: vira o evento custo_acima_da_reserva (PR 3.2b).
  acimaDaReserva: boolean;
} & ({ liquidada: true } | { liquidada: false; estadoReserva: Exclude<EstadoReserva, 'aberta'> });

// Contabiliza uma resposta com uso: grava o agent_steps com o custo real (decimal, da tabela fechada) e
// liquida a reserva, na mesma transação. O passo herda demanda, plano, tarefa, operação e modelo da própria
// reserva, então sempre casa com ela. Se a reserva já não estava aberta (a varredura a reteve depois de uma
// parada longa), o custo real é gravado assim mesmo, porque o gasto aconteceu, e a reserva fica como está: a
// demanda passa a contar os dois, o lado seguro. Idempotente para a reserva já liquidada: uma reserva cobre
// exatamente um envio, então liquidar de novo (a resposta do COMMIT se perdeu e quem chama repetiu) devolve o
// passo já gravado, em vez de contar o mesmo gasto duas vezes.
export async function liquidarReserva(
  pool: pg.Pool,
  p: { reservaId: string; passo: PassoDaChamada },
): Promise<ResultadoLiquidacao> {
  return comTransacao(pool, async (cliente) => {
    const { rows } = await cliente.query<{
      demanda_id: string;
      plano_id: string | null;
      tarefa_id: string | null;
      operacao: OperacaoCusto;
      modelo: string;
      estado: EstadoReserva;
      valor: string;
      custo_real: string | null;
      agent_step_id: string | null;
    }>(
      `SELECT demanda_id, plano_id, tarefa_id, operacao, modelo, estado, valor_reservado_usd::text AS valor,
              custo_real_usd::text AS custo_real, agent_step_id
         FROM reservas_custo WHERE id = $1 FOR UPDATE`,
      [p.reservaId],
    );
    const r = rows[0];
    if (!r) throw new Error('Reserva inexistente.');
    if (r.estado === 'liquidada') {
      const custo = r.custo_real!;
      return {
        agentStepId: r.agent_step_id!,
        custoRealUsd: custo,
        reservaUsd: r.valor,
        acimaDaReserva: usdParaMicro(custo) > usdParaMicro(r.valor),
        liquidada: true,
      };
    }
    const custoReal = custoRealUsd(r.modelo, p.passo.uso);
    const { rows: passo } = await cliente.query<{ id: string }>(
      `INSERT INTO agent_steps (run_id, demanda_id, papel, modelo, tokens_in, tokens_out, cache_read, cache_write, custo_usd,
         duracao_ms, plano_id, tarefa_id, operacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        p.passo.runId,
        r.demanda_id,
        p.passo.papel,
        r.modelo,
        p.passo.uso.inputTokens,
        p.passo.uso.outputTokens,
        p.passo.uso.cacheReadTokens,
        p.passo.uso.cacheWriteTokens,
        custoReal,
        p.passo.duracaoMs,
        r.plano_id,
        r.tarefa_id,
        r.operacao,
      ],
    );
    const agentStepId = passo[0]!.id;
    const base = {
      agentStepId,
      custoRealUsd: custoReal,
      reservaUsd: r.valor,
      acimaDaReserva: usdParaMicro(custoReal) > usdParaMicro(r.valor),
    };
    if (r.estado !== 'aberta') return { ...base, liquidada: false, estadoReserva: r.estado };
    await cliente.query("UPDATE reservas_custo SET estado = 'liquidada', custo_real_usd = $2, agent_step_id = $3 WHERE id = $1", [
      p.reservaId,
      custoReal,
      agentStepId,
    ]);
    return { ...base, liquidada: true };
  });
}

// Recusa antes do processamento (lista fechada da seção 6.3, aplicada pela PR 3.2b): nada conta. Nunca cria
// agent_steps. Devolve false se a reserva já não estava aberta.
export async function cancelarReserva(db: Db, reservaId: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE reservas_custo SET estado = 'cancelada' WHERE id = $1 AND estado = 'aberta'", [reservaId]);
  return rowCount === 1;
}

// Resultado desconhecido (timeout, rede, 5xx, stream interrompido...): o valor reservado continua contando.
// Nunca cria agent_steps.
export async function reterReserva(db: Db, reservaId: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE reservas_custo SET estado = 'retida' WHERE id = $1 AND estado = 'aberta'", [reservaId]);
  return rowCount === 1;
}

export interface ReservaEncerrada {
  reservaId: string;
  demandaId: string;
  tarefaId: string | null;
  operacao: OperacaoCusto;
  valorUsd: string;
}

// Varredura do watchdog: reserva aberta depois de expira_em (o processo caiu entre reservar e liquidar) vira
// retida e continua contando.
export async function reterReservasVencidas(db: Db): Promise<ReservaEncerrada[]> {
  const { rows } = await db.query<{ id: string; demanda_id: string; tarefa_id: string | null; operacao: OperacaoCusto; valor: string }>(
    `UPDATE reservas_custo SET estado = 'retida'
      WHERE estado = 'aberta' AND expira_em < now()
      RETURNING id, demanda_id, tarefa_id, operacao, valor_reservado_usd::text AS valor`,
  );
  return rows.map((l) => ({ reservaId: l.id, demandaId: l.demanda_id, tarefaId: l.tarefa_id, operacao: l.operacao, valorUsd: l.valor }));
}

// Ação administrativa (PR 3.2b): o gasto retido passa a reconhecido, com o login de quem reconheceu. O valor
// continua contando no teto. Devolve null se a reserva não estava retida.
export async function reconhecerReserva(
  db: Db,
  p: { reservaId: string; reconhecidaPor: string },
): Promise<ReservaEncerrada | null> {
  if (!LOGIN_RE.test(p.reconhecidaPor)) throw new Error('Login fora do formato fechado.');
  const { rows } = await db.query<{ id: string; demanda_id: string; tarefa_id: string | null; operacao: OperacaoCusto; valor: string }>(
    `UPDATE reservas_custo SET estado = 'reconhecida', reconhecida_por = $2
      WHERE id = $1 AND estado = 'retida'
      RETURNING id, demanda_id, tarefa_id, operacao, valor_reservado_usd::text AS valor`,
    [p.reservaId, p.reconhecidaPor],
  );
  const l = rows[0];
  return l ? { reservaId: l.id, demandaId: l.demanda_id, tarefaId: l.tarefa_id, operacao: l.operacao, valorUsd: l.valor } : null;
}

// Bloco de construção (seção 6.5): roda na transação de quem chama, que também devolve a tarefa para pronta
// (antes, pela ordem de locks) e leva a demanda para "Aguardando humano". Devolve false se já estava bloqueada.
export async function bloquearPorCusto(db: Db, demandaId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE orquestracao_demandas SET bloqueada_por_custo = true WHERE demanda_id = $1 AND NOT bloqueada_por_custo',
    [demandaId],
  );
  return rowCount === 1;
}

export type ResultadoAutorizacao =
  | { autorizada: true; autorizacaoId: string; valorUsd: string; limiteAnteriorUsd: string; limiteNovoUsd: string }
  | { autorizada: false; motivo: 'sem_envelope' | 'nao_bloqueada' }
  | { autorizada: false; motivo: 'limite_divergente'; limiteAtualUsd: string };

// Bloco de construção (seção 6.6): roda na transação de quem chama, que também devolve a demanda para "Nova"
// (PR 3.2b). Trava o envelope, confere o bloqueio e o limite que o administrador viu, grava a autorização e
// limpa o bloqueio. Duas autorizações concorrentes nunca passam juntas: a segunda espera o lock e encontra a
// demanda já destravada ou o limite já mudado.
export async function autorizarCustoAdicional(cliente: pg.PoolClient, a: AutorizacaoCusto): Promise<ResultadoAutorizacao> {
  const p = AutorizacaoCustoSchema.parse(a);
  const { rows: envelope } = await cliente.query<{ bloqueada_por_custo: boolean }>(
    'SELECT bloqueada_por_custo FROM orquestracao_demandas WHERE demanda_id = $1 FOR UPDATE',
    [p.demandaId],
  );
  if (!envelope[0]) return { autorizada: false, motivo: 'sem_envelope' };
  if (!envelope[0].bloqueada_por_custo) return { autorizada: false, motivo: 'nao_bloqueada' };

  const { rows: limite } = await cliente.query<{ atual: string; igual: boolean }>(
    'SELECT orquestracao_limite_usd($1)::numeric(10,2)::text AS atual, orquestracao_limite_usd($1) = $2::numeric AS igual',
    [p.demandaId, p.limiteEsperadoUsd],
  );
  if (!limite[0]!.igual) return { autorizada: false, motivo: 'limite_divergente', limiteAtualUsd: limite[0]!.atual };

  const { rows } = await cliente.query<{ id: string; valor: string; anterior: string; novo: string }>(
    `INSERT INTO autorizacoes_custo (demanda_id, valor_usd, limite_anterior_usd, limite_novo_usd, autorizado_por)
     VALUES ($1, $2::numeric, $3::numeric, $3::numeric + $2::numeric, $4)
     RETURNING id, valor_usd::text AS valor, limite_anterior_usd::text AS anterior, limite_novo_usd::text AS novo`,
    [p.demandaId, p.valorUsd, limite[0]!.atual, p.autorizadoPor],
  );
  await cliente.query('UPDATE orquestracao_demandas SET bloqueada_por_custo = false WHERE demanda_id = $1', [p.demandaId]);
  const l = rows[0]!;
  return { autorizada: true, autorizacaoId: l.id, valorUsd: l.valor, limiteAnteriorUsd: l.anterior, limiteNovoUsd: l.novo };
}
