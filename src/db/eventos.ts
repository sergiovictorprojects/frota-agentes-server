import type pg from 'pg';
import { z } from 'zod';
import { CATEGORIAS, PRIORIDADES } from '../domain/setores.ts';
import { RESULTADOS_ESPERADOS } from '../domain/resultado-esperado.ts';

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
  'roteamento_validado',
  // Fase 3.2 (execução por tarefas). Os schemas entram na PR 3.2a; quem emite é a PR 3.2b.
  'rota_definida',
  'plano_ativado',
  'plano_retomado',
  'plano_abandonado',
  'plano_concluido',
  'fallback_legado',
  'agente_selecionado',
  'tarefa_iniciada',
  'tarefa_concluida',
  'tarefa_falhou',
  'tarefa_devolvida',
  'tarefa_lease_expirado',
  'tarefa_resultado_descartado',
  'custo_demanda_excedido',
  'custo_acima_da_reserva',
  'custo_adicional_autorizado',
  'gasto_retido_reconhecido',
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
  // Fase 3.2: só acrescentam (seção 7 do plano e ADR 0007).
  'lease_expirado',
  'artefato_invalido',
  'custo_demanda_excedido',
  'prazo_da_run',
  'llm_timeout',
  'contexto_excedido',
  'agente_alterado',
] as const;
export type CodigoErro = (typeof CODIGOS_ERRO)[number];

// Os códigos com que uma tarefa falha: os mesmos do CHECK tarefas_codigo_erro_check (migration 006).
export const CODIGOS_ERRO_TAREFA = [
  'contexto_excedido',
  'artefato_invalido',
  'lease_expirado',
  'llm_recusa',
  'llm_truncado',
  'llm_invalido',
  'llm_api',
  'llm_timeout',
  'falha_inesperada',
] as const satisfies readonly CodigoErro[];
export type CodigoErroTarefa = (typeof CODIGOS_ERRO_TAREFA)[number];

// Ator dos eventos que o próprio sistema registra (fila, watchdog, roteamento), como já é hoje.
export const ATOR_SISTEMA = 'sistema';

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
  roteamento_validado: 'Roteamento da demanda validado por regras.',
  rota_definida: 'Rota do processamento definida.',
  plano_ativado: 'Plano de tarefas ativado para execução.',
  plano_retomado: 'Plano de tarefas retomado.',
  plano_abandonado: 'Plano de tarefas abandonado.',
  plano_concluido: 'Plano de tarefas concluído.',
  fallback_legado: 'Demanda desviada para o fluxo legado.',
  agente_selecionado: 'Agente selecionado para a tarefa.',
  tarefa_iniciada: 'Tarefa iniciada: envio registrado.',
  tarefa_concluida: 'Tarefa concluída.',
  tarefa_falhou: 'Tarefa falhou.',
  tarefa_devolvida: 'Tarefa devolvida antes do envio, sem consumir tentativa.',
  tarefa_lease_expirado: 'Lease da tarefa expirado.',
  tarefa_resultado_descartado: 'Resultado da tarefa descartado.',
  custo_demanda_excedido: 'Teto de custo da demanda atingido: a chamada não foi feita.',
  custo_acima_da_reserva: 'Custo real acima do valor reservado.',
  custo_adicional_autorizado: 'Custo adicional autorizado.',
  gasto_retido_reconhecido: 'Gasto retido reconhecido.',
};

// plano_registrado de um plano em execução (Fase 3.2) tem o próprio texto fixo: o de cima diz "não executa".
const RESUMO_PLANO_EM_EXECUCAO = 'Plano de tarefas registrado para execução.';

function resumoDo(tipo: TipoEvento, metadata: Record<string, unknown>): string {
  if (tipo === 'plano_registrado' && metadata.modo === 'execucao') return RESUMO_PLANO_EM_EXECUCAO;
  return RESUMOS_POR_TIPO[tipo];
}

const categoria = z.enum(CATEGORIAS);
const prioridade = z.enum(PRIORIDADES);
const resultadoEsperado = z.enum(RESULTADOS_ESPERADOS);
const codigoErro = z.enum(CODIGOS_ERRO);
const uuid = z.uuid();
const contagem = z.number().int().nonnegative();
const percentual = z.number().int().min(0).max(100);
const tentativaPlanejada = z.number().int().positive();
const versaoPlano = z.number().int().positive();

// Fase 3.2. Vocabulários fechados; os que espelham o banco repetem os CHECK da migration 006. Redeclarados aqui
// (em vez de importados de planos.ts, tarefas.ts e orquestracao.ts) pelo mesmo motivo do politica_avaliada:
// esses módulos importam este para emitir os próprios eventos.
const MOTIVOS_REJEICAO_PLANO = [
  'sem_tarefas',
  'limite_tarefas',
  'chave_duplicada',
  'chave_reservada',
  'capacidade_nao_executora',
  'dependencia_inexistente',
  'autodependencia',
  'ciclo',
  'objetivo_invalido',
] as const;
const MOTIVOS_ABANDONO_PLANO = [
  'tarefa_falhou',
  'agente_indisponivel',
  'pendencia_humana',
  'orquestracao_desligada',
  'demanda_encerrada',
] as const;
// Os mesmos de orquestracao_demandas.motivo_legado: todo fallback fixa a rota com o próprio motivo.
const MOTIVOS_FALLBACK = ['plano_rejeitado', 'planejamento_falhou', 'tarefa_falhou', 'agente_indisponivel'] as const;
// A rota que o processamento tomou (tabela de roteamento, seção 3.2 do plano) e por quê.
export const ROTAS_PROCESSAMENTO = ['pos_integracao', 'retomada', 'tarefas', 'legado_fixo', 'shadow', 'legado'] as const;
export const MOTIVOS_ROTA = [
  'integracao_concluida',
  'plano_ativo',
  'rota_fixada',
  'categoria_ligada',
  'flag_planejar',
  'flag_desligada',
  'categoria_desligada',
] as const;
const tipoTarefa = z.enum(['especialista', 'integracao']);
const capacidadeTarefa = z.enum([
  'gestores', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
  'd10', 'd11', 'd12', 'd13', 'd14', 'd15', 'd16', 'd18',
]);
const operacaoCusto = z.enum(['planejamento', 'execucao', 'integracao', 'auditoria']);
// Chave de agente: o mesmo formato fechado do contexto de política (nunca texto livre).
const chaveAgente = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/);
// Dólar como número, com no máximo 6 casas: recusa lixo de ponto flutuante (0.1 + 0.2) em vez de gravá-lo.
const usd = z
  .number()
  .nonnegative()
  .max(1_000_000)
  .refine((v) => Number(v.toFixed(6)) === v, { message: 'valor em dólar com mais de 6 casas decimais' });

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
    motivoDevolucao: z.enum(['nunca_iniciada', 'parada_sistemica', 'falha_da_demanda', 'watchdog', 'prazo_da_run']),
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
    // Só nas operações da Fase 3 (o planejamento e as avaliações por tarefa): as legadas mantêm o formato
    // original. Numa avaliação por tarefa, claimId liga o evento ao snapshot do claim (a tarefa vai na coluna).
    operacao: z.enum(['planejamento', 'execucao', 'integracao']).optional(),
    claimId: uuid.optional(),
  }),
  // Fase 3.1 (modo "planejar") e 3.2: só ids, versão, contagens e códigos fechados — nunca a chave de uma
  // tarefa, o objetivo, texto do modelo ou da demanda.
  plano_registrado: z.strictObject({
    planoId: uuid,
    versao: versaoPlano,
    modo: z.enum(['shadow', 'execucao']),
    totalTarefas: contagem,
    totalDependencias: contagem,
  }),
  plano_rejeitado: z.strictObject({ planoId: uuid, versao: versaoPlano, motivoRejeicao: z.enum(MOTIVOS_REJEICAO_PLANO) }),
  planejamento_falhou: z.strictObject({ codigoErro }),
  roteamento_validado: z.strictObject({
    resultadoEsperado,
    categoria,
    categoriaSugerida: categoria.nullable(),
    decisao: z.enum(['permitir', 'aguardar_humano']),
    motivo: z.enum(['compativel', 'categoria_incompativel', 'criterios_ausentes']),
  }),
  // Fase 3.2 (seção 7 do plano). Nunca lease_token, lease, chave ou objetivo de tarefa, conteúdo, resumo ou
  // referência de artefato, URL, prompt ou texto de erro. claimId pode: identifica o claim, mas não autoriza nada.
  rota_definida: z.strictObject({ rota: z.enum(ROTAS_PROCESSAMENTO), motivoRota: z.enum(MOTIVOS_ROTA) }),
  plano_ativado: z.strictObject({ planoId: uuid, versao: versaoPlano, totalTarefas: contagem }),
  plano_retomado: z.strictObject({ planoId: uuid, versao: versaoPlano, tarefasConcluidas: contagem, tarefasRestantes: contagem }),
  plano_abandonado: z.strictObject({
    planoId: uuid,
    versao: versaoPlano,
    motivoAbandono: z.enum(MOTIVOS_ABANDONO_PLANO),
    tarefasCanceladas: contagem,
  }),
  plano_concluido: z.strictObject({ planoId: uuid, versao: versaoPlano, entregaId: uuid }),
  fallback_legado: z.strictObject({
    planoId: uuid.nullable(),
    motivoFallback: z.enum(MOTIVOS_FALLBACK),
    codigoErro: codigoErro.nullable(),
  }),
  agente_selecionado: z.strictObject({
    claimId: uuid,
    agente: chaveAgente,
    versaoAgente: z.number().int().positive(),
    capacidade: capacidadeTarefa,
  }),
  tarefa_iniciada: z.strictObject({
    claimId: uuid,
    tipo: tipoTarefa,
    tentativa: z.number().int().positive(),
    maxTentativas: z.number().int().min(1).max(3),
    artefatosIntegrais: contagem,
    artefatosSoResumo: contagem,
    conversaOmitida: contagem,
  }),
  tarefa_concluida: z.strictObject({
    claimId: uuid,
    tipo: tipoTarefa,
    tentativa: z.number().int().positive(),
    artefatoId: uuid,
    bytes: contagem,
    totalReferencias: contagem,
    referenciasDescartadas: contagem,
    duracaoMs: contagem,
  }),
  // contexto_excedido acontece antes do claim: claimId nulo e ator "sistema" (conferido em registrarEvento).
  tarefa_falhou: z
    .strictObject({
      claimId: uuid.nullable(),
      tipo: tipoTarefa,
      tentativa: contagem,
      codigoErro: z.enum(CODIGOS_ERRO_TAREFA),
      definitiva: z.boolean(),
    })
    .refine((m) => (m.codigoErro === 'contexto_excedido') === (m.claimId === null), {
      message: 'tarefa_falhou: claimId é nulo exatamente em contexto_excedido',
    })
    .refine((m) => m.codigoErro !== 'contexto_excedido' || m.definitiva, {
      message: 'tarefa_falhou: contexto_excedido é sempre definitiva',
    }),
  tarefa_devolvida: z.strictObject({
    claimId: uuid,
    codigoErro: z.enum([
      'frota_pausada',
      'orcamento_excedido',
      'custo_demanda_excedido',
      'prazo_da_run',
      'agente_nao_autorizado',
      'agente_alterado',
    ]),
  }),
  tarefa_lease_expirado: z.strictObject({
    claimId: uuid,
    tentativa: contagem,
    enviada: z.boolean(),
    destino: z.enum(['pronta', 'falhou']),
  }),
  tarefa_resultado_descartado: z.strictObject({
    claimId: uuid,
    tentativa: z.number().int().positive(),
    motivoDescarte: z.enum(['lease_perdido', 'tarefa_encerrada']),
  }),
  custo_demanda_excedido: z.strictObject({ comprometidoUsd: usd, reservaUsd: usd, limiteUsd: usd, operacao: operacaoCusto }),
  custo_acima_da_reserva: z.strictObject({ operacao: operacaoCusto, reservaUsd: usd, custoRealUsd: usd }),
  custo_adicional_autorizado: z.strictObject({ valorUsd: usd, limiteAnteriorUsd: usd, limiteNovoUsd: usd }),
  gasto_retido_reconhecido: z.strictObject({ valorUsd: usd, operacao: operacaoCusto }),
};

// Onde a coluna tarefa_id é obrigatória, opcional ou proibida (coluna "tarefa_id" da seção 7 do plano). O
// banco confere que a tarefa é da mesma demanda do evento (gatilho agent_events_confere_tarefa).
const TAREFA_OBRIGATORIA: ReadonlySet<TipoEvento> = new Set([
  'agente_selecionado',
  'tarefa_iniciada',
  'tarefa_concluida',
  'tarefa_falhou',
  'tarefa_devolvida',
  'tarefa_lease_expirado',
  'tarefa_resultado_descartado',
]);
const TAREFA_OPCIONAL: ReadonlySet<TipoEvento> = new Set([
  'custo_demanda_excedido',
  'custo_acima_da_reserva',
  'gasto_retido_reconhecido',
  'entrega_criada',
  'politica_avaliada',
]);

// Regras que cruzam a metadata com as colunas do evento. Lança antes de qualquer escrita.
function conferirColunas(e: NovoEvento, metadata: Record<string, unknown>): void {
  const temTarefa = e.tarefaId !== undefined && e.tarefaId !== null;
  if (temTarefa && !uuid.safeParse(e.tarefaId).success) {
    throw new Error('tarefaId precisa ser um uuid.');
  }
  if (TAREFA_OBRIGATORIA.has(e.tipoEvento) && !temTarefa) {
    throw new Error(`O evento ${e.tipoEvento} exige tarefaId.`);
  }
  if (!TAREFA_OBRIGATORIA.has(e.tipoEvento) && !TAREFA_OPCIONAL.has(e.tipoEvento) && temTarefa) {
    throw new Error(`O evento ${e.tipoEvento} não leva tarefaId.`);
  }
  if (e.tipoEvento === 'tarefa_falhou' && (metadata.codigoErro === 'contexto_excedido') !== (e.ator === ATOR_SISTEMA)) {
    throw new Error('tarefa_falhou: o ator é "sistema" exatamente em contexto_excedido.');
  }
  if (e.tipoEvento === 'politica_avaliada' && (metadata.claimId !== undefined) !== temTarefa) {
    throw new Error('politica_avaliada: claimId vem junto com tarefaId, e só com ele.');
  }
}

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
  // Fase 3.2: a tarefa do evento, quando houver (ver TAREFA_OBRIGATORIA e TAREFA_OPCIONAL).
  tarefaId?: string | null;
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
  tarefaId: string | null;
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
  tarefa_id: string | null;
}

const COLUNAS = `id, demanda_id, correlacao_id, run_id, tentativa, sequencia_demanda, tipo_evento, schema_versao,
  ator, resumo, metadata, chave_idempotencia, ocorrido_em, tarefa_id`;

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
    tarefaId: l.tarefa_id,
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
  conferirColunas(e, metadataValidada);
  const resumo = resumoDo(e.tipoEvento, metadataValidada);

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
         schema_versao, ator, resumo, metadata, chave_idempotencia, tarefa_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        e.tarefaId ?? null,
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