import type pg from 'pg';
import { z } from 'zod';
import { CATEGORIAS, PRIORIDADES } from '../domain/setores.ts';

// Nomes em português, para bater com o resto do schema (demandas, mensagens, relatorios...).
// Cobre exatamente os pontos de transição listados na Entrega 1 — não é um catálogo aberto.
export const TIPOS_EVENTO = [
  'demanda_criada',
  'demanda_reivindicada',
  'processamento_iniciado',
  'chamada_trabalho_concluida',
  'chamada_trabalho_falhou',
  'pendencia_humana_registrada',
  'pendencia_insumo_registrada',
  'entrega_criada',
  'auditoria_concluida',
  'auditoria_interrompida',
  'demanda_concluida',
  'demanda_reaberta',
  'demanda_devolvida_para_fila',
  'demanda_falhou',
  'politica_avaliada',
  'plano_registrado',
  'plano_rejeitado',
  'planejamento_falhou',
] as const;
const TIPOS_EVENTO_VALIDOS = new Set<string>(TIPOS_EVENTO);
export type TipoEvento = (typeof TIPOS_EVENTO)[number];

// Erros nunca entram no ledger como texto (mensagemDeErro pode conter detalhe interno, e uma LlmError
// pode ecoar fragmento da resposta do modelo). Toda falha vira um destes códigos fechados.
export const CODIGOS_ERRO = [
  'llm_recusa',
  'llm_truncado',
  'llm_invalido',
  'llm_api',
  'orcamento_excedido',
  'frota_pausada',
  'claim_expirado',
  'agente_nao_autorizado',
  'falha_inesperada',
] as const;
export type CodigoErro = (typeof CODIGOS_ERRO)[number];

const SCHEMA_VERSAO_ATUAL = 1;

// Resumo é sempre um destes textos fixos — nunca título da demanda, plano do modelo, motivo de
// pendência, URL de entrega ou mensagem de erro. O "o quê" fica no tipo_evento e no resumo fixo; o
// "detalhe classificado" fica em metadata, sob o schema do tipo (ver METADATA_SCHEMAS).
const RESUMOS_POR_TIPO: Readonly<Record<TipoEvento, string>> = {
  demanda_criada: 'Demanda criada.',
  demanda_reivindicada: 'Demanda reivindicada por uma run.',
  processamento_iniciado: 'Processamento iniciado.',
  chamada_trabalho_concluida: 'Chamada de trabalho concluída.',
  chamada_trabalho_falhou: 'Chamada de trabalho falhou.',
  pendencia_humana_registrada: 'Pendência registrada: ação humana necessária.',
  pendencia_insumo_registrada: 'Pendência registrada: insumo necessário.',
  entrega_criada: 'Entrega criada.',
  auditoria_concluida: 'Auditoria concluída.',
  auditoria_interrompida: 'Auditoria interrompida.',
  demanda_concluida: 'Demanda concluída.',
  demanda_reaberta: 'Demanda reaberta.',
  demanda_devolvida_para_fila: 'Demanda devolvida para a fila.',
  demanda_falhou: 'Limite de tentativas atingido.',
  politica_avaliada: 'Política avaliada (modo shadow — não bloqueia).',
  plano_registrado: 'Plano de tarefas registrado (modo planejar — não executa).',
  plano_rejeitado: 'Plano de tarefas rejeitado pela validação.',
  planejamento_falhou: 'Planejamento de tarefas falhou; a demanda segue pelo fluxo atual.',
};

const categoria = z.enum(CATEGORIAS);
const prioridade = z.enum(PRIORIDADES);
const codigoErro = z.enum(CODIGOS_ERRO);
const uuid = z.uuid();
const contagem = z.number().int().nonnegative();
const percentual = z.number().int().min(0).max(100);
const tentativaPlanejada = z.number().int().positive();

// Um schema Zod .strict() por tipo_evento: só os campos exatos passam, com o tipo exato — nunca texto
// livre. Isto substitui uma lista de nomes proibidos (denylist): uma denylist nunca pegaria "motivo" ou
// "descricao" carregando texto do modelo, porque esses nomes não são intrinsecamente perigosos — só o
// valor livre é. Uma allowlist por tipo torna o texto livre impossível de entrar, não apenas os nomes
// óbvios (prompt, chain_of_thought, api_key...).
const METADATA_SCHEMAS: Readonly<Record<TipoEvento, z.ZodType>> = {
  demanda_criada: z.strictObject({ categoria, prioridade }),
  demanda_reivindicada: z.strictObject({ tentativaPlanejada }),
  processamento_iniciado: z.strictObject({}),
  chamada_trabalho_concluida: z.strictObject({
    nivelComplexidade: z.number().int().min(1).max(4),
    setoresEnvolvidos: z.array(categoria).max(18),
  }),
  chamada_trabalho_falhou: z.strictObject({ codigoErro }),
  pendencia_humana_registrada: z.strictObject({ totalAcoes: contagem }),
  pendencia_insumo_registrada: z.strictObject({ alternativa: z.enum(['A', 'B']) }),
  entrega_criada: z.strictObject({ entregaId: uuid, tipo: z.enum(['html', 'texto']), publicadaComoHtml: z.boolean() }),
  auditoria_concluida: z.strictObject({ antipadroesCount: contagem, regrasCumpridasPercent: percentual }),
  auditoria_interrompida: z.strictObject({ codigoErro }),
  demanda_concluida: z.strictObject({ indiceGeral: percentual.nullable(), antipadroesCount: contagem.nullable() }),
  demanda_reaberta: z.strictObject({ origem: z.enum(['resposta', 'manual']) }),
  demanda_devolvida_para_fila: z.strictObject({
    motivoDevolucao: z.enum(['nunca_iniciada', 'parada_sistemica', 'falha_da_demanda', 'watchdog']),
    codigoErro: codigoErro.nullable(),
    tentativaPlanejada: tentativaPlanejada.optional(),
  }),
  demanda_falhou: z.strictObject({ codigoErro }),
  // Fase 2 — Entrega 2 (Policy Engine, modo shadow): só decisão, estágio, ids/versionamento e código
  // fechado — nunca a condição da regra, o nome da política ou qualquer texto. Os enums de estagio/decisao
  // são redeclarados aqui (em vez de importados de src/db/politicas.ts) para não criar import circular —
  // politicas.ts já importa deste módulo para emitir o próprio evento.
  politica_avaliada: z.strictObject({
    estagio: z.enum(['pre', 'during', 'post']),
    decisao: z.enum(['allow', 'warn', 'require_approval', 'deny']),
    politicaId: uuid.nullable(),
    regraId: uuid.nullable(),
    versaoRegra: z.number().int().positive().nullable(),
    // Só nas operações da Fase 3 (planejamento, integração): as legadas mantêm o formato original.
    operacao: z.enum(['planejamento', 'integracao']).optional(),
  }),
  // Fase 3.1 (modo "planejar"): só ids, versão, contagens e códigos fechados — nunca a chave de uma
  // tarefa, texto do modelo ou da demanda.
  plano_registrado: z.strictObject({
    planoId: uuid,
    versao: z.number().int().positive(),
    modo: z.enum(['shadow', 'execucao']),
    totalTarefas: contagem,
    totalDependencias: contagem,
  }),
  plano_rejeitado: z.strictObject({
    planoId: uuid,
    versao: z.number().int().positive(),
    motivoRejeicao: z.enum([
      'sem_tarefas',
      'limite_tarefas',
      'chave_duplicada',
      'chave_reservada',
      'dependencia_inexistente',
      'autodependencia',
      'ciclo',
    ]),
  }),
  planejamento_falhou: z.strictObject({ codigoErro }),
};

export interface NovoEvento {
  demandaId: string;
  // Identidade imutável da execução: o run_id quando existe uma run, ou um UUID gerado uma única vez
  // no início de uma ação de interface. Nunca demandas.tentativas — esse contador pode diminuir
  // (devolverParaFila) ou zerar (reabrirDemanda), então duas execuções distintas podem ter o mesmo
  // número de tentativa. É correlacaoId, não tentativa, quem entra na chave de idempotência.
  correlacaoId: string;
  runId?: string | null;
  // null quando o evento não prova que o processamento chegou a começar (ver comentário da coluna na
  // migration). Um valor planejado, quando faz sentido, vai em metadata.tentativaPlanejada.
  tentativa: number | null;
  tipoEvento: TipoEvento;
  ator: string;
  metadata?: Record<string, unknown>;
  chaveIdempotencia: string;
}

export interface Evento {
  id: string;
  demandaId: string;
  correlacaoId: string;
  runId: string | null;
  tentativa: number | null;
  sequenciaDemanda: number;
  tipoEvento: TipoEvento;
  schemaVersao: number;
  ator: string;
  resumo: string;
  metadata: Record<string, unknown>;
  chaveIdempotencia: string;
  ocorridoEm: string;
}

interface Linha {
  id: string;
  demanda_id: string;
  correlacao_id: string;
  run_id: string | null;
  tentativa: number | null;
  sequencia_demanda: string;
  tipo_evento: TipoEvento;
  schema_versao: number;
  ator: string;
  resumo: string;
  metadata: Record<string, unknown>;
  chave_idempotencia: string;
  ocorrido_em: Date;
}

const COLUNAS = `id, demanda_id, correlacao_id, run_id, tentativa, sequencia_demanda, tipo_evento, schema_versao,
  ator, resumo, metadata, chave_idempotencia, ocorrido_em`;

function mapear(l: Linha): Evento {
  return {
    id: l.id,
    demandaId: l.demanda_id,
    correlacaoId: l.correlacao_id,
    runId: l.run_id,
    tentativa: l.tentativa,
    sequenciaDemanda: Number(l.sequencia_demanda),
    tipoEvento: l.tipo_evento,
    schemaVersao: l.schema_versao,
    ator: l.ator,
    resumo: l.resumo,
    metadata: l.metadata,
    chaveIdempotencia: l.chave_idempotencia,
    ocorridoEm: l.ocorrido_em.toISOString(),
  };
}

// Junta partes estáveis (nunca texto livre de usuário/modelo) numa chave determinística.
// O mesmo conjunto de partes sempre produz a mesma chave: é isso que torna o registro idempotente.
export function montarChaveIdempotencia(...partes: readonly (string | number)[]): string {
  return partes.map(String).join('|');
}

// AVISO DE CONSISTÊNCIA: este ledger é observacional e degradável, não transacional. Cada escrita é sua
// própria transação, separada da transação que grava o estado real (demanda/relatório/mensagem). Uma
// falha aqui é logada e ignorada por quem chama (ver EmitirEvento em processar-demanda.ts) — o ledger
// nunca pode impedir nem atrasar o resultado real. Isso significa que ele pode, em casos raros (queda
// exatamente entre as duas transações), ficar atrás do estado real ou perder um evento pontual. Ele não
// é a fonte da verdade sobre o que aconteceu com a demanda — demandas/relatorios/mensagens continuam
// sendo — é uma trilha auditável de apoio.
//
// Idempotente por natureza: duas chamadas com a mesma chave_idempotencia devolvem o mesmo evento, nunca
// duplicam nem lançam erro — seguro para retry. Bloqueia a linha da demanda (mesmo mecanismo já usado no
// claim da fila) só para serializar o cálculo de sequencia_demanda.
//
// resumo nunca vem de fora: é sempre o texto fixo de RESUMOS_POR_TIPO. metadata é validada e recortada
// pelo schema exato do tipo_evento (METADATA_SCHEMAS) antes do INSERT — um campo fora do schema, ou de
// tipo errado (ex.: uma string livre onde só um enum é aceito), lança e nada é gravado.
export async function registrarEvento(pool: pg.Pool, e: NovoEvento): Promise<Evento> {
  if (!TIPOS_EVENTO_VALIDOS.has(e.tipoEvento)) {
    throw new Error(`Tipo de evento não permitido: "${e.tipoEvento}".`);
  }
  const metadataValidada = METADATA_SCHEMAS[e.tipoEvento].parse(e.metadata ?? {}) as Record<string, unknown>;
  const resumo = RESUMOS_POR_TIPO[e.tipoEvento];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM demandas WHERE id = $1 FOR UPDATE', [e.demandaId]);

    const existente = await client.query<Linha>(
      `SELECT ${COLUNAS} FROM agent_events WHERE demanda_id = $1 AND chave_idempotencia = $2`,
      [e.demandaId, e.chaveIdempotencia],
    );
    if (existente.rows[0]) {
      await client.query('COMMIT');
      return mapear(existente.rows[0]);
    }

    const { rows: proximaRows } = await client.query<{ prox: string }>(
      'SELECT COALESCE(MAX(sequencia_demanda), 0) + 1 AS prox FROM agent_events WHERE demanda_id = $1',
      [e.demandaId],
    );
    const sequenciaDemanda = proximaRows[0]!.prox;

    const inserida = await client.query<Linha>(
      `INSERT INTO agent_events (demanda_id, correlacao_id, run_id, tentativa, sequencia_demanda, tipo_evento,
         schema_versao, ator, resumo, metadata, chave_idempotencia)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${COLUNAS}`,
      [
        e.demandaId,
        e.correlacaoId,
        e.runId ?? null,
        e.tentativa,
        sequenciaDemanda,
        e.tipoEvento,
        SCHEMA_VERSAO_ATUAL,
        e.ator,
        resumo,
        JSON.stringify(metadataValidada),
        e.chaveIdempotencia,
      ],
    );
    await client.query('COMMIT');
    return mapear(inserida.rows[0]!);
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

// id (o cursor global) é sempre a ordenação oficial — nunca sequencia_demanda ou ocorrido_em sozinhos,
// que não distinguem empates de forma garantida. id é chave primária: a ordem é sempre estável.
export async function listarEventosDaDemanda(pool: pg.Pool, demandaId: string): Promise<Evento[]> {
  const { rows } = await pool.query<Linha>(`SELECT ${COLUNAS} FROM agent_events WHERE demanda_id = $1 ORDER BY id ASC`, [
    demandaId,
  ]);
  return rows.map(mapear);
}

export async function listarEventosDaRun(pool: pg.Pool, runId: string): Promise<Evento[]> {
  const { rows } = await pool.query<Linha>(`SELECT ${COLUNAS} FROM agent_events WHERE run_id = $1 ORDER BY id ASC`, [
    runId,
  ]);
  return rows.map(mapear);
}
