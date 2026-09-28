import type pg from 'pg';
import { z } from 'zod';
import { PAPEIS_AGENTE, ESTADOS_AGENTE } from './agentes.ts';
import { montarChaveIdempotencia, registrarEvento } from './eventos.ts';
import { CATEGORIAS, PRIORIDADES } from '../domain/setores.ts';
import { log, mensagemDeErro } from '../util/log.ts';

export const ESTAGIOS_POLITICA = ['pre', 'during', 'post'] as const;
export type EstagioPolitica = (typeof ESTAGIOS_POLITICA)[number];

export const DECISOES_POLITICA = ['allow', 'warn', 'require_approval', 'deny'] as const;
export type DecisaoPolitica = (typeof DECISOES_POLITICA)[number];

// Os únicos dois pontos do fluxo real que chamam um modelo: a execução do trabalho e a auditoria.
export const OPERACOES_AVALIADAS = ['execucao', 'auditoria'] as const;
export type OperacaoAvaliada = (typeof OPERACOES_AVALIADAS)[number];

const ATOR_RE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;
// agente e modelo: identificador curto e controlado, nunca texto livre — mesmo formato aplicado pelo CHECK
// politica_condicao_valida na migration 004.
const IDENTIFICADOR_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

// Estados que o contexto avaliado pode ter: os do catálogo mais "desconhecido", usado quando o agente não
// existe no catálogo. Nunca assumir "ativo" para um agente inexistente — uma regra "estado: ativo" não
// pode casar com ele, e uma regra pode mirar "estado: desconhecido" explicitamente.
export const ESTADO_AGENTE_DESCONHECIDO = 'desconhecido';
export const ESTADOS_CONTEXTO = [...ESTADOS_AGENTE, ESTADO_AGENTE_DESCONHECIDO] as const;
export type EstadoContexto = (typeof ESTADOS_CONTEXTO)[number];

// Allowlist estruturada: só estes sete campos, cada um com um domínio fechado já usado em outro lugar do
// sistema (agentes, demandas) — nunca uma chave nova, nunca um valor de texto livre. Isto é o que torna o
// motor "sem LLM, sem código arbitrário, sem expressões livres": uma condição é só um objeto raso de
// igualdade, nunca uma função nem uma string a ser interpretada. A mesma regra é aplicada no banco pelo
// CHECK politica_condicao_valida (migration 004), então uma condição inválida não entra nem por SQL direto.
const CondicaoSchema = z
  .object({
    agente: z.string().regex(IDENTIFICADOR_RE).optional(),
    papel: z.enum(PAPEIS_AGENTE).optional(),
    categoria: z.enum(CATEGORIAS).optional(),
    estado: z.enum(ESTADOS_CONTEXTO).optional(),
    modelo: z.string().regex(IDENTIFICADOR_RE).optional(),
    operacao: z.enum(OPERACOES_AVALIADAS).optional(),
    prioridade: z.enum(PRIORIDADES).optional(),
  })
  .strict();
export type CondicaoRegra = z.infer<typeof CondicaoSchema>;

// O contexto avaliado tem o mesmo formato da condição, mas com todos os campos preenchidos: é o "estado
// do mundo" no momento da avaliação, nunca texto da demanda (título, descrição, plano do modelo etc.).
const ContextoSchema = z
  .object({
    agente: z.string().regex(IDENTIFICADOR_RE),
    papel: z.enum(PAPEIS_AGENTE),
    categoria: z.enum(CATEGORIAS),
    estado: z.enum(ESTADOS_CONTEXTO),
    modelo: z.string().regex(IDENTIFICADOR_RE),
    operacao: z.enum(OPERACOES_AVALIADAS),
    prioridade: z.enum(PRIORIDADES),
  })
  .strict();
export type ContextoAvaliacao = z.infer<typeof ContextoSchema>;

export interface Politica {
  id: string;
  chave: string;
  nome: string;
  descricao: string;
  estado: 'ativa' | 'inativa';
  versao: number;
  criadoEm: string;
  atualizadoEm: string;
}

export interface RegraPolitica {
  id: string;
  politicaId: string;
  chave: string;
  estagio: EstagioPolitica;
  decisao: DecisaoPolitica;
  condicao: CondicaoRegra;
  versao: number;
  criadoEm: string;
}

export interface AvaliacaoPolitica {
  id: string;
  demandaId: string;
  runId: string | null;
  regraId: string | null;
  politicaId: string | null;
  estagio: EstagioPolitica;
  decisao: DecisaoPolitica;
  contexto: ContextoAvaliacao;
  versaoRegra: number | null;
  ocorridoEm: string;
}

const PoliticaSchema = z.object({
  id: z.uuid(),
  chave: z.string().min(1).max(100),
  nome: z.string().min(1).max(200),
  descricao: z.string().min(1).max(500),
  estado: z.enum(['ativa', 'inativa']),
  versao: z.number().int().positive(),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});

const RegraPoliticaSchema = z.object({
  id: z.uuid(),
  politicaId: z.uuid(),
  chave: z.string().min(1).max(100),
  estagio: z.enum(ESTAGIOS_POLITICA),
  decisao: z.enum(DECISOES_POLITICA),
  condicao: CondicaoSchema,
  versao: z.number().int().positive(),
  criadoEm: z.string(),
});

const AvaliacaoSchema = z.object({
  id: z.string(),
  demandaId: z.uuid(),
  runId: z.uuid().nullable(),
  regraId: z.uuid().nullable(),
  politicaId: z.uuid().nullable(),
  estagio: z.enum(ESTAGIOS_POLITICA),
  decisao: z.enum(DECISOES_POLITICA),
  contexto: ContextoSchema,
  versaoRegra: z.number().int().positive().nullable(),
  ocorridoEm: z.string(),
});

interface LinhaPolitica {
  id: string;
  chave: string;
  nome: string;
  descricao: string;
  estado: string;
  versao: number;
  criado_em: Date;
  atualizado_em: Date;
}
const COLUNAS_POLITICA = 'id, chave, nome, descricao, estado, versao, criado_em, atualizado_em';

function mapearPolitica(l: LinhaPolitica): Politica {
  return PoliticaSchema.parse({
    id: l.id,
    chave: l.chave,
    nome: l.nome,
    descricao: l.descricao,
    estado: l.estado,
    versao: l.versao,
    criadoEm: l.criado_em.toISOString(),
    atualizadoEm: l.atualizado_em.toISOString(),
  }) as Politica;
}

export async function criarPolitica(
  pool: pg.Pool,
  p: { chave: string; nome: string; descricao: string },
): Promise<Politica> {
  const { rows } = await pool.query<LinhaPolitica>(
    `INSERT INTO politicas (chave, nome, descricao) VALUES ($1, $2, $3) RETURNING ${COLUNAS_POLITICA}`,
    [p.chave, p.nome, p.descricao],
  );
  return mapearPolitica(rows[0]!);
}

export async function obterPoliticaPorChave(pool: pg.Pool, chave: string): Promise<Politica | null> {
  const { rows } = await pool.query<LinhaPolitica>(`SELECT ${COLUNAS_POLITICA} FROM politicas WHERE chave = $1`, [chave]);
  return rows[0] ? mapearPolitica(rows[0]) : null;
}

// Único jeito recomendado de mudar o estado de uma política. Assim como atualizarAgente() (src/db/agentes.ts),
// a garantia de trilha em si vem do gatilho politicas_controlar_mudancas (migration 004), não desta
// função — um UPDATE direto de estado também gera a mesma trilha, sempre.
export async function atualizarPolitica(
  pool: pg.Pool,
  chave: string,
  ator: string,
  novoEstado: Politica['estado'],
): Promise<Politica> {
  if (!ATOR_RE.test(ator)) throw new Error(`ator inválido: "${ator}" precisa ser um identificador curto e controlado.`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<LinhaPolitica>(`SELECT ${COLUNAS_POLITICA} FROM politicas WHERE chave = $1 FOR UPDATE`, [
      chave,
    ]);
    if (!rows[0]) throw new Error(`Política "${chave}" não encontrada.`);
    const atual = mapearPolitica(rows[0]);
    if (atual.estado === novoEstado) {
      await client.query('ROLLBACK');
      return atual;
    }
    await client.query("SELECT set_config('frota.ator_da_alteracao', $1, true)", [ator]);
    const atualizado = await client.query<LinhaPolitica>(
      `UPDATE politicas SET estado = $2 WHERE chave = $1 RETURNING ${COLUNAS_POLITICA}`,
      [chave, novoEstado],
    );
    await client.query('COMMIT');
    return mapearPolitica(atualizado.rows[0]!);
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

interface LinhaRegra {
  id: string;
  politica_id: string;
  chave: string;
  estagio: string;
  decisao: string;
  condicao: CondicaoRegra;
  versao: number;
  criado_em: Date;
}

function mapearRegra(l: LinhaRegra): RegraPolitica {
  return RegraPoliticaSchema.parse({
    id: l.id,
    politicaId: l.politica_id,
    chave: l.chave,
    estagio: l.estagio,
    decisao: l.decisao,
    condicao: l.condicao,
    versao: l.versao,
    criadoEm: l.criado_em.toISOString(),
  }) as RegraPolitica;
}

export async function criarRegra(
  pool: pg.Pool,
  r: { politicaId: string; chave: string; estagio: EstagioPolitica; decisao: DecisaoPolitica; condicao: CondicaoRegra },
): Promise<RegraPolitica> {
  const condicaoValidada = CondicaoSchema.parse(r.condicao);
  const { rows } = await pool.query<LinhaRegra>(
    `INSERT INTO regras_politica (politica_id, chave, estagio, decisao, condicao)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, politica_id, chave, estagio, decisao, condicao, versao, criado_em`,
    [r.politicaId, r.chave, r.estagio, r.decisao, JSON.stringify(condicaoValidada)],
  );
  return mapearRegra(rows[0]!);
}

// Só regras de políticas ativas contam para avaliação — desativar a política desativa, de uma vez, todas
// as suas regras, sem precisar tocar em cada uma (que são append-only e não têm estado próprio).
async function listarRegrasAtivasPorEstagio(pool: pg.Pool, estagio: EstagioPolitica): Promise<RegraPolitica[]> {
  const { rows } = await pool.query<LinhaRegra>(
    `SELECT r.id, r.politica_id, r.chave, r.estagio, r.decisao, r.condicao, r.versao, r.criado_em
       FROM regras_politica r
       JOIN politicas p ON p.id = r.politica_id
      WHERE r.estagio = $1 AND p.estado = 'ativa'
      ORDER BY r.chave`,
    [estagio],
  );
  return rows.map(mapearRegra);
}

const SEVERIDADE: Readonly<Record<DecisaoPolitica, number>> = { allow: 0, warn: 1, require_approval: 2, deny: 3 };

function condicaoBate(condicao: CondicaoRegra, contexto: ContextoAvaliacao): boolean {
  return (Object.keys(condicao) as (keyof CondicaoRegra)[]).every((chave) => condicao[chave] === contexto[chave]);
}

// Determinístico, sem LLM: entre as regras cuja condição bate com o contexto, a mais restritiva vence —
// um sinal conservador mesmo em modo shadow, onde nada é de fato bloqueado.
function decidir(regras: readonly RegraPolitica[], contexto: ContextoAvaliacao): RegraPolitica | null {
  const candidatas = regras.filter((r) => condicaoBate(r.condicao, contexto));
  if (!candidatas.length) return null;
  return candidatas.reduce((pior, atual) => (SEVERIDADE[atual.decisao] > SEVERIDADE[pior.decisao] ? atual : pior));
}

// Avalia e registra — nunca lança, nunca bloqueia. Modo shadow: quem chama nunca deve ramificar no
// resultado desta função para alterar o fluxo da demanda; ela só observa e registra. Uma falha ao
// gravar (banco fora do ar etc.) é logada e ignorada, no mesmo espírito fail-open do ledger de eventos
// (ver registrarEvento em src/db/eventos.ts) — a avaliação de política nunca pode atrasar nem impedir o
// processamento real.
export async function avaliarEregistrar(
  pool: pg.Pool,
  params: {
    demandaId: string;
    runId: string | null;
    correlacaoId: string;
    tentativa: number | null;
    estagio: EstagioPolitica;
    contexto: ContextoAvaliacao;
  },
): Promise<DecisaoPolitica> {
  try {
    const contextoValidado = ContextoSchema.parse(params.contexto);
    const regras = await listarRegrasAtivasPorEstagio(pool, params.estagio);
    const regraVencedora = decidir(regras, contextoValidado);
    const decisao = regraVencedora?.decisao ?? 'allow';

    await pool.query(
      `INSERT INTO avaliacoes_politica (demanda_id, run_id, regra_id, politica_id, estagio, decisao, contexto, versao_regra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.demandaId,
        params.runId,
        regraVencedora?.id ?? null,
        regraVencedora?.politicaId ?? null,
        params.estagio,
        decisao,
        JSON.stringify(contextoValidado),
        regraVencedora?.versao ?? null,
      ],
    );

    // Evento seguro no ledger unificado: só decisão, estágio, ids/versionamento e código fechado — nunca
    // a condição da regra nem qualquer texto. Uma chave por estágio: esta avaliação acontece até três
    // vezes por execução (pre/during/post), cada uma com sua própria idempotência.
    try {
      await registrarEvento(pool, {
        demandaId: params.demandaId,
        correlacaoId: params.correlacaoId,
        runId: params.runId,
        tentativa: params.tentativa,
        tipoEvento: 'politica_avaliada',
        ator: contextoValidado.agente,
        chaveIdempotencia: montarChaveIdempotencia(params.correlacaoId, 'politica_avaliada', params.estagio),
        metadata: {
          estagio: params.estagio,
          decisao,
          politicaId: regraVencedora?.politicaId ?? null,
          regraId: regraVencedora?.id ?? null,
          versaoRegra: regraVencedora?.versao ?? null,
        },
      });
    } catch (erro) {
      log('erro', 'erro_evento_ledger', {
        demandaId: params.demandaId,
        tipoEvento: 'politica_avaliada',
        erro: mensagemDeErro(erro),
      });
    }

    return decisao;
  } catch (erro) {
    log('erro', 'erro_avaliacao_politica', { demandaId: params.demandaId, estagio: params.estagio, erro: mensagemDeErro(erro) });
    return 'allow';
  }
}

interface LinhaAvaliacao {
  id: string;
  demanda_id: string;
  run_id: string | null;
  regra_id: string | null;
  politica_id: string | null;
  estagio: string;
  decisao: string;
  contexto: ContextoAvaliacao;
  versao_regra: number | null;
  ocorrido_em: Date;
}

function mapearAvaliacao(l: LinhaAvaliacao): AvaliacaoPolitica {
  return AvaliacaoSchema.parse({
    id: l.id,
    demandaId: l.demanda_id,
    runId: l.run_id,
    regraId: l.regra_id,
    politicaId: l.politica_id,
    estagio: l.estagio,
    decisao: l.decisao,
    contexto: l.contexto,
    versaoRegra: l.versao_regra,
    ocorridoEm: l.ocorrido_em.toISOString(),
  }) as AvaliacaoPolitica;
}

export async function listarAvaliacoesDaDemanda(pool: pg.Pool, demandaId: string): Promise<AvaliacaoPolitica[]> {
  const { rows } = await pool.query<LinhaAvaliacao>(
    `SELECT id, demanda_id, run_id, regra_id, politica_id, estagio, decisao, contexto, versao_regra, ocorrido_em
       FROM avaliacoes_politica WHERE demanda_id = $1 ORDER BY id ASC`,
    [demandaId],
  );
  return rows.map(mapearAvaliacao);
}

export interface PoliticaHistorico {
  id: string;
  politicaId: string;
  ator: string;
  camposAlterados: Record<string, { de: unknown; para: unknown }>;
  versaoAnterior: number;
  versaoNova: number;
  ocorridoEm: string;
}

export async function listarHistoricoDaPolitica(pool: pg.Pool, politicaId: string): Promise<PoliticaHistorico[]> {
  const { rows } = await pool.query<{
    id: string;
    politica_id: string;
    ator: string;
    campos_alterados: Record<string, { de: unknown; para: unknown }>;
    versao_anterior: number;
    versao_nova: number;
    ocorrido_em: Date;
  }>(
    `SELECT id, politica_id, ator, campos_alterados, versao_anterior, versao_nova, ocorrido_em
       FROM politicas_historico WHERE politica_id = $1 ORDER BY id ASC`,
    [politicaId],
  );
  return rows.map((l) => ({
    id: l.id,
    politicaId: l.politica_id,
    ator: l.ator,
    camposAlterados: l.campos_alterados,
    versaoAnterior: l.versao_anterior,
    versaoNova: l.versao_nova,
    ocorridoEm: l.ocorrido_em.toISOString(),
  }));
}
