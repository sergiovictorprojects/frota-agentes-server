import type pg from 'pg';
import { z } from 'zod';
import { CATEGORIAS, SETORES, type Categoria } from '../domain/setores.ts';
import { FORMATOS_ENTREGAVEIS, type FormatoEntregavel } from '../domain/artefatos-entregaveis.ts';
import { capacidadesPadraoDoAgente, type CapacidadesAgente } from '../domain/capacidades-agentes.ts';

export const PAPEIS_AGENTE = ['coordenador', 'executor', 'avaliador', 'auditor'] as const;
export type PapelAgente = (typeof PAPEIS_AGENTE)[number];

export const ESTADOS_AGENTE = ['ativo', 'suspenso', 'sob_demanda'] as const;
export type EstadoAgente = (typeof ESTADOS_AGENTE)[number];

export interface Agente {
  id: string;
  chave: string;
  nome: string;
  descricao: string;
  categoria: Categoria;
  papel: PapelAgente;
  estado: EstadoAgente;
  versao: number;
  modeloPermitido: string;
  politicaRef: string | null;
  capacidades: CapacidadesAgente;
  criadoEm: string;
  atualizadoEm: string;
}

// Formato fechado (slug curto), não texto livre: um prompt, uma frase ou um segredo colado aqui nunca
// bate no padrão — nem passa pelo Zod nem pelo CHECK equivalente na migration 003.
const POLITICA_REF_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Identificador curto e controlado (ex.: "sistema", "operador:ana"), nunca uma frase livre. Mesmo padrão
// do CHECK em agentes_historico.ator (migration 003).
const ATOR_RE = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;

// Validação runtime: garante que uma linha vinda do banco realmente obedece o formato esperado antes de
// devolver ao chamador, em vez de confiar cegamente no shape do driver.
const AgenteSchema = z.object({
  id: z.uuid(),
  chave: z.string().min(1).max(100),
  nome: z.string().min(1).max(200),
  descricao: z.string().min(1).max(500),
  categoria: z.enum(CATEGORIAS),
  papel: z.enum(PAPEIS_AGENTE),
  estado: z.enum(ESTADOS_AGENTE),
  versao: z.number().int().positive(),
  modeloPermitido: z.string().min(1).max(100),
  politicaRef: z.string().regex(POLITICA_REF_RE).nullable(),
  capacidades: z.object({
    gerarArtefatos: z.array(z.enum(FORMATOS_ENTREGAVEIS)),
    publicarArtefatos: z.boolean(),
    lerAnexos: z.boolean(),
    maxArtefatosPorDemanda: z.number().int().min(0).max(5),
    maxBytesPorArtefato: z.number().int().min(0).max(5 * 1024 * 1024),
  }),
  criadoEm: z.string(),
  atualizadoEm: z.string(),
});

interface Linha {
  id: string;
  chave: string;
  nome: string;
  descricao: string;
  categoria: string;
  papel: string;
  estado: string;
  versao: number;
  modelo_permitido: string;
  politica_ref: string | null;
  gerar_artefatos: FormatoEntregavel[];
  publicar_artefatos: boolean;
  ler_anexos: boolean;
  max_artefatos_por_demanda: number;
  max_bytes_por_artefato: number;
  criado_em: Date;
  atualizado_em: Date;
}

const COLUNAS = `id, chave, nome, descricao, categoria, papel, estado, versao, modelo_permitido, politica_ref,
  gerar_artefatos, publicar_artefatos, ler_anexos, max_artefatos_por_demanda, max_bytes_por_artefato,
  criado_em, atualizado_em`;

function mapear(l: Linha): Agente {
  return AgenteSchema.parse({
    id: l.id,
    chave: l.chave,
    nome: l.nome,
    descricao: l.descricao,
    categoria: l.categoria,
    papel: l.papel,
    estado: l.estado,
    versao: l.versao,
    modeloPermitido: l.modelo_permitido,
    politicaRef: l.politica_ref,
    capacidades: {
      gerarArtefatos: l.gerar_artefatos,
      publicarArtefatos: l.publicar_artefatos,
      lerAnexos: l.ler_anexos,
      maxArtefatosPorDemanda: l.max_artefatos_por_demanda,
      maxBytesPorArtefato: l.max_bytes_por_artefato,
    },
    criadoEm: l.criado_em.toISOString(),
    atualizadoEm: l.atualizado_em.toISOString(),
  });
}

export async function obterAgentePorChave(pool: pg.Pool, chave: string): Promise<Agente | null> {
  const { rows } = await pool.query<Linha>(`SELECT ${COLUNAS} FROM agentes WHERE chave = $1`, [chave]);
  return rows[0] ? mapear(rows[0]) : null;
}

export async function listarAgentesAtivos(pool: pg.Pool): Promise<Agente[]> {
  const { rows } = await pool.query<Linha>(`SELECT ${COLUNAS} FROM agentes WHERE estado = 'ativo' ORDER BY chave`);
  return rows.map(mapear);
}

export async function listarAgentesSobDemanda(pool: pg.Pool): Promise<Agente[]> {
  const { rows } = await pool.query<Linha>(`SELECT ${COLUNAS} FROM agentes WHERE estado = 'sob_demanda' ORDER BY chave`);
  return rows.map(mapear);
}

// "Autorizado" exige três coisas: o agente existe, está "ativo" (sob_demanda propositalmente NÃO conta —
// exige acionamento explícito, que esta entrega não implementa) e o modelo da chamada bate exatamente com
// modelo_permitido. Um agente configurado para um modelo não pode ser acionado com outro — torna
// modelo_permitido efetivo, não apenas descritivo.
export async function agenteEstaAutorizado(pool: pg.Pool, chave: string, modelo: string): Promise<boolean> {
  const agente = await obterAgentePorChave(pool, chave);
  return agente?.estado === 'ativo' && agente.modeloPermitido === modelo;
}

export function papelDoSetor(categoria: Categoria): PapelAgente {
  if (categoria === 'gestores') return 'coordenador';
  // d17 é literalmente o auditor da run: PAPEL_AUDITOR em processar-demanda.ts é SETORES.d17.papel
  // ("frota:agent-evaluator"), usado em toda chamada de auditoria, não só quando a demanda é da
  // categoria d17. Por isso "agent-evaluator" não ganha uma linha própria no catálogo: é este mesmo
  // agente, não um segundo.
  if (categoria === 'd17') return 'auditor';
  return 'executor';
}

// Idempotente: religar o serviço não duplica nem sobrescreve estado, versão ou qualquer outro campo já
// ajustado manualmente — ON CONFLICT DO NOTHING. A fonte dos dados é SETORES (src/domain/setores.ts),
// não uma segunda lista hardcoded em paralelo: os 19 setores atuais (gestores + d1..d18) viram 19
// agentes, preservando compatibilidade total com o que já existe.
//
// modelo_permitido nasce diferenciado por papel: o auditor (d17, PAPEL_AUDITOR) usa modeloAuditoria —
// o mesmo modelo que auditar() de fato chama em processar-demanda.ts — e todo o resto (coordenador e
// executores) usa modeloTrabalho, o mesmo que a execução de fato chama.
export async function seedAgentesPadrao(pool: pg.Pool, modeloTrabalho: string, modeloAuditoria: string): Promise<void> {
  // Os testes de upgrade montam deliberadamente bancos parados na 005/006. Em produção migrate() sempre chega
  // à 007 antes do seed; este detector mantém o fixture de upgrade fiel à versão antiga sem exigir SQL paralelo.
  const { rows: estrutura } = await pool.query<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agentes' AND column_name = 'gerar_artefatos'
     ) AS existe`,
  );
  const temCapacidadesPersistidas = estrutura[0]?.existe === true;
  for (const categoria of CATEGORIAS) {
    const setor = SETORES[categoria];
    const papel = papelDoSetor(categoria);
    const modelo = papel === 'auditor' ? modeloAuditoria : modeloTrabalho;
    const capacidades = capacidadesPadraoDoAgente({ categoria, papel });
    const base = [setor.papel, setor.nome, `Setor ${setor.nome} (${categoria}).`, categoria, papel, modelo];
    if (temCapacidadesPersistidas) {
      await pool.query(
        `INSERT INTO agentes (chave, nome, descricao, categoria, papel, modelo_permitido,
           gerar_artefatos, publicar_artefatos, ler_anexos, max_artefatos_por_demanda, max_bytes_por_artefato)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (chave) DO NOTHING`,
        [
          ...base,
          capacidades.gerarArtefatos,
          capacidades.publicarArtefatos,
          capacidades.lerAnexos,
          capacidades.maxArtefatosPorDemanda,
          capacidades.maxBytesPorArtefato,
        ],
      );
    } else {
      await pool.query(
        `INSERT INTO agentes (chave, nome, descricao, categoria, papel, modelo_permitido)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (chave) DO NOTHING`,
        base,
      );
    }
  }
}

export interface MudancasAgente {
  estado?: EstadoAgente;
  modeloPermitido?: string;
  politicaRef?: string | null;
  gerarArtefatos?: readonly FormatoEntregavel[];
  publicarArtefatos?: boolean;
  lerAnexos?: boolean;
  maxArtefatosPorDemanda?: number;
  maxBytesPorArtefato?: number;
}

function formatosNormalizados(formatos: readonly FormatoEntregavel[]): FormatoEntregavel[] {
  const solicitados = new Set(formatos);
  if (solicitados.size !== formatos.length || formatos.some((f) => !(FORMATOS_ENTREGAVEIS as readonly string[]).includes(f))) {
    throw new Error('gerarArtefatos contém formato inválido ou duplicado.');
  }
  return FORMATOS_ENTREGAVEIS.filter((f) => solicitados.has(f));
}

export interface AgenteHistorico {
  id: string;
  agenteId: string;
  ator: string;
  camposAlterados: Record<string, { de: unknown; para: unknown }>;
  versaoAnterior: number;
  versaoNova: number;
  ocorridoEm: string;
}

const AgenteHistoricoSchema = z.object({
  id: z.string(),
  agenteId: z.uuid(),
  ator: z.string().regex(ATOR_RE),
  camposAlterados: z.record(z.string(), z.object({ de: z.unknown(), para: z.unknown() })),
  versaoAnterior: z.number().int().positive(),
  versaoNova: z.number().int().positive(),
  ocorridoEm: z.string(),
});

interface LinhaHistorico {
  id: string;
  agente_id: string;
  ator: string;
  campos_alterados: Record<string, { de: unknown; para: unknown }>;
  versao_anterior: number;
  versao_nova: number;
  ocorrido_em: Date;
}

function mapearHistorico(l: LinhaHistorico): AgenteHistorico {
  return AgenteHistoricoSchema.parse({
    id: l.id,
    agenteId: l.agente_id,
    ator: l.ator,
    camposAlterados: l.campos_alterados,
    versaoAnterior: l.versao_anterior,
    versaoNova: l.versao_nova,
    ocorridoEm: l.ocorrido_em.toISOString(),
  });
}

// Jeito recomendado (não o único possível — ver migrations 003 e 007) de mudar estado, modelo, política
// ou capacidades. A garantia real não está aqui: está no gatilho agentes_controlar_mudancas, que grava
// agentes_historico e incrementa versao como parte
// do próprio UPDATE, para qualquer UPDATE que chegue à tabela — inclusive um SQL direto que nunca ouviu
// falar desta função. O que esta função faz é (a) validar o formato de ator e politicaRef antes de ir ao
// banco, e (b) identificar quem está fazendo a mudança via set_config, que o gatilho lê para preencher
// agentes_historico.ator — puramente informativo, não uma permissão: um UPDATE que pula esta função ainda
// assim grava a trilha, só que atribuída a 'sistema:sql_direto'.
export async function atualizarAgente(
  pool: pg.Pool,
  chave: string,
  ator: string,
  mudancas: MudancasAgente,
): Promise<Agente> {
  if (!ATOR_RE.test(ator)) {
    throw new Error(`ator inválido: "${ator}" precisa ser um identificador curto e controlado.`);
  }
  if (mudancas.politicaRef != null && !POLITICA_REF_RE.test(mudancas.politicaRef)) {
    throw new Error(`politicaRef inválida: "${mudancas.politicaRef}" precisa ser uma referência curta (formato de slug).`);
  }
  if (
    mudancas.maxArtefatosPorDemanda !== undefined &&
    (!Number.isInteger(mudancas.maxArtefatosPorDemanda) || mudancas.maxArtefatosPorDemanda < 0 || mudancas.maxArtefatosPorDemanda > 5)
  ) {
    throw new Error('maxArtefatosPorDemanda precisa ser um inteiro de 0 a 5.');
  }
  if (
    mudancas.maxBytesPorArtefato !== undefined &&
    (!Number.isInteger(mudancas.maxBytesPorArtefato) || mudancas.maxBytesPorArtefato < 0 || mudancas.maxBytesPorArtefato > 5 * 1024 * 1024)
  ) {
    throw new Error('maxBytesPorArtefato precisa ser um inteiro de 0 a 5242880.');
  }
  if (mudancas.lerAnexos === true) throw new Error('Leitura de anexos ainda não está implementada.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Linha>(`SELECT ${COLUNAS} FROM agentes WHERE chave = $1 FOR UPDATE`, [chave]);
    if (!rows[0]) throw new Error(`Agente "${chave}" não encontrado.`);
    const atual = mapear(rows[0]);
    const formatos = mudancas.gerarArtefatos === undefined
      ? [...atual.capacidades.gerarArtefatos]
      : formatosNormalizados(mudancas.gerarArtefatos);
    const publicar = mudancas.publicarArtefatos ?? atual.capacidades.publicarArtefatos;
    const maxArtefatos = mudancas.maxArtefatosPorDemanda ?? atual.capacidades.maxArtefatosPorDemanda;
    const maxBytes = mudancas.maxBytesPorArtefato ?? atual.capacidades.maxBytesPorArtefato;
    if (publicar && atual.papel !== 'coordenador') throw new Error('Somente coordenador pode publicar artefatos.');
    if ((atual.papel === 'auditor' || atual.papel === 'avaliador') && (formatos.length > 0 || publicar || maxArtefatos > 0 || maxBytes > 0)) {
      throw new Error(`${atual.papel} não pode gerar nem publicar artefatos.`);
    }
    if ((formatos.length === 0) !== (maxArtefatos === 0 && maxBytes === 0)) {
      throw new Error('Agente sem formatos precisa de limites zero; agente com formatos precisa de limites positivos.');
    }

    const semMudancaReal =
      (mudancas.estado === undefined || mudancas.estado === atual.estado) &&
      (mudancas.modeloPermitido === undefined || mudancas.modeloPermitido === atual.modeloPermitido) &&
      (mudancas.politicaRef === undefined || mudancas.politicaRef === atual.politicaRef) &&
      JSON.stringify(formatos) === JSON.stringify(atual.capacidades.gerarArtefatos) &&
      (mudancas.publicarArtefatos === undefined || mudancas.publicarArtefatos === atual.capacidades.publicarArtefatos) &&
      (mudancas.lerAnexos === undefined || mudancas.lerAnexos === atual.capacidades.lerAnexos) &&
      (mudancas.maxArtefatosPorDemanda === undefined ||
        mudancas.maxArtefatosPorDemanda === atual.capacidades.maxArtefatosPorDemanda) &&
      (mudancas.maxBytesPorArtefato === undefined || mudancas.maxBytesPorArtefato === atual.capacidades.maxBytesPorArtefato);
    if (semMudancaReal) {
      await client.query('ROLLBACK');
      return atual;
    }

    // set_config(..., true) é o equivalente parametrizável de SET LOCAL: dura só esta transação, nunca
    // vaza para outra conexão do pool. O gatilho lê isto só para atribuir a trilha — não é um portão.
    await client.query("SELECT set_config('frota.ator_da_alteracao', $1, true)", [ator]);
    const atualizado = await client.query<Linha>(
      `UPDATE agentes SET estado = $2, modelo_permitido = $3, politica_ref = $4,
         gerar_artefatos = $5, publicar_artefatos = $6, ler_anexos = $7,
         max_artefatos_por_demanda = $8, max_bytes_por_artefato = $9
       WHERE chave = $1 RETURNING ${COLUNAS}`,
      [
        chave,
        mudancas.estado ?? atual.estado,
        mudancas.modeloPermitido ?? atual.modeloPermitido,
        mudancas.politicaRef !== undefined ? mudancas.politicaRef : atual.politicaRef,
        formatos,
        publicar,
        mudancas.lerAnexos ?? atual.capacidades.lerAnexos,
        maxArtefatos,
        maxBytes,
      ],
    );
    await client.query('COMMIT');
    return mapear(atualizado.rows[0]!);
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw erro;
  } finally {
    client.release();
  }
}

export async function listarHistoricoDoAgente(pool: pg.Pool, agenteId: string): Promise<AgenteHistorico[]> {
  const { rows } = await pool.query<LinhaHistorico>(
    `SELECT id, agente_id, ator, campos_alterados, versao_anterior, versao_nova, ocorrido_em
       FROM agentes_historico WHERE agente_id = $1 ORDER BY id ASC`,
    [agenteId],
  );
  return rows.map(mapearHistorico);
}
