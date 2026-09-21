import type pg from 'pg';
import { z } from 'zod';
import { comTransacao } from '../db/tx.ts';
import { CATEGORIAS, PRIORIDADES } from '../domain/setores.ts';

const texto = z.string().nullish().transform((v) => v ?? null);
const numero = z.number().nullish().transform((v) => v ?? null);

const MensagemLegada = z.object({
  autor: z.enum(['solicitante', 'agente']),
  setor: texto,
  agente: texto,
  texto: z.string().min(1),
  criadoEm: z.string(),
});

const DemandaLegada = z.object({
  titulo: z.string().min(1).max(200),
  descricao: texto,
  categoria: z.enum(CATEGORIAS),
  prioridade: z.enum(PRIORIDADES).default('MEDIUM'),
  prazo: texto,
  solicitante: texto,
  referencias: texto,
  status: z.enum(['Nova', 'Em andamento', 'Concluída', 'Arquivada']),
  entregaUrl: texto,
  criadoEm: z.string(),
  mensagens: z.array(MensagemLegada).default([]),
});

const RelatorioLegado = z.object({
  demandaTitulo: z.string().min(1),
  gerente: z.string().min(1),
  nivelComplexidade: z.number().int().min(1).max(4),
  setoresEnvolvidos: z.array(z.string()).default([]),
  fontesUtilizadas: texto,
  metricas: z.object({
    acoesRealizadas: z.string().default(''),
    tempoTotal: z.string().default(''),
    indiceGeral: numero,
    antipadroesCount: numero,
    regrasCumpridasPercent: numero,
  }),
  ganhos: texto,
  perdas: texto,
  aprendizado: texto,
  ponderacoes: z
    .array(z.object({ setor: z.string(), nota: z.union([z.string(), z.number()]).transform(String) }))
    .default([]),
  entregaUrl: texto,
  criadoEm: z.string(),
});

const AprendizadoLegado = z.object({
  data: z.string(),
  demanda: z.string(),
  nivel: z.number().int().min(1).max(4),
  aprendizado: z.string(),
  indice: numero,
});

export const ArquivoLegadoSchema = z.object({
  demandas: z.array(DemandaLegada),
  relatorios: z.array(RelatorioLegado).default([]),
  aprendizado: z.array(AprendizadoLegado).default([]),
});

export interface ResultadoImportacao {
  demandas: { inseridas: number; jaExistiam: number; devolvidasParaFila: number; aguardandoInsumo: number };
  mensagens: number;
  relatorios: { inseridos: number; jaExistiam: number; semDemanda: string[] };
  aprendizado: { inseridas: number; jaExistiam: number };
}

type Dados = z.output<typeof ArquivoLegadoSchema>;
type DemandaImportada = Dados['demandas'][number];

const NOTA_REENFILEIRADA = 'Importada do sistema anterior enquanto estava em andamento: voltou para a fila.';
const NOTA_AGUARDANDO =
  'Importada do sistema anterior: o trabalho provisório já existe e a demanda aguarda o insumo que faltava. Responda aqui para recolocá-la na fila.';
const CATEGORIAS_DE_SETOR = new Set<string>(CATEGORIAS.filter((c) => c !== 'gestores'));

// Relatórios e aprendizado apontam para a demanda pelo título: dois títulos iguais ligariam o relatório à demanda errada.
function exigirTitulosUnicos(dados: Dados): void {
  const vistos = new Set<string>();
  for (const d of dados.demandas) {
    if (vistos.has(d.titulo)) {
      throw new Error(`Título repetido no arquivo: "${d.titulo}". Os relatórios são associados por título; renomeie uma das demandas.`);
    }
    vistos.add(d.titulo);
  }
}

function novoResultado(): ResultadoImportacao {
  return {
    demandas: { inseridas: 0, jaExistiam: 0, devolvidasParaFila: 0, aguardandoInsumo: 0 },
    mensagens: 0,
    relatorios: { inseridos: 0, jaExistiam: 0, semDemanda: [] },
    aprendizado: { inseridas: 0, jaExistiam: 0 },
  };
}

// "Em andamento" com relatório = o sistema anterior parou num rascunho à espera de um insumo: refazer o
// trabalho custaria de novo. Sem relatório, o trabalho não terminou e volta para a fila.
function destinoDaDemanda(d: DemandaImportada, temRelatorio: boolean) {
  const emAndamento = d.status === 'Em andamento';
  const aguardandoInsumo = emAndamento && temRelatorio;
  const reenfileirar = emAndamento && !aguardandoInsumo;
  return {
    status: aguardandoInsumo ? 'Aguardando insumo' : reenfileirar ? 'Nova' : d.status,
    alternativa: aguardandoInsumo ? (d.entregaUrl ? 'A' : 'B') : null,
    nota: aguardandoInsumo ? NOTA_AGUARDANDO : reenfileirar ? NOTA_REENFILEIRADA : null,
    aguardandoInsumo,
    reenfileirar,
  };
}

async function inserirMensagens(c: pg.PoolClient, demandaId: string, d: DemandaImportada, nota: string | null): Promise<number> {
  const mensagens = nota
    ? [...d.mensagens, { autor: 'agente' as const, setor: null, agente: null, texto: nota, criadoEm: new Date().toISOString() }]
    : d.mensagens;
  for (const m of mensagens) {
    await c.query(
      'INSERT INTO mensagens (demanda_id, autor, setor, agente, texto, criado_em) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)',
      [demandaId, m.autor, m.setor, m.agente, m.texto.slice(0, 4000), m.criadoEm],
    );
  }
  return mensagens.length;
}

async function importarDemandas(c: pg.PoolClient, dados: Dados, resultado: ResultadoImportacao): Promise<Map<string, string>> {
  const titulosComRelatorio = new Set(dados.relatorios.map((r) => r.demandaTitulo));
  const idPorTitulo = new Map<string, string>();

  for (const d of dados.demandas) {
    const existente = await c.query<{ id: string }>('SELECT id FROM demandas WHERE titulo = $1 AND criado_em = $2::timestamptz', [
      d.titulo,
      d.criadoEm,
    ]);
    if (existente.rows[0]) {
      idPorTitulo.set(d.titulo, existente.rows[0].id);
      resultado.demandas.jaExistiam++;
      continue;
    }

    const destino = destinoDaDemanda(d, titulosComRelatorio.has(d.titulo));
    const inserida = await c.query<{ id: string }>(
      `INSERT INTO demandas (titulo, descricao, categoria, prioridade, prazo, solicitante, referencias, status,
         entrega_url, alternativa_insumo, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz) RETURNING id`,
      [d.titulo, d.descricao ?? '', d.categoria, d.prioridade, d.prazo, d.solicitante, d.referencias, destino.status, d.entregaUrl, destino.alternativa, d.criadoEm],
    );
    const id = inserida.rows[0]!.id;
    idPorTitulo.set(d.titulo, id);
    resultado.demandas.inseridas++;
    if (destino.reenfileirar) resultado.demandas.devolvidasParaFila++;
    if (destino.aguardandoInsumo) resultado.demandas.aguardandoInsumo++;
    resultado.mensagens += await inserirMensagens(c, id, d, destino.nota);
  }
  return idPorTitulo;
}

async function importarRelatorios(
  c: pg.PoolClient,
  dados: Dados,
  idPorTitulo: ReadonlyMap<string, string>,
  resultado: ResultadoImportacao,
): Promise<void> {
  for (const r of dados.relatorios) {
    const demandaId = idPorTitulo.get(r.demandaTitulo);
    if (!demandaId) {
      resultado.relatorios.semDemanda.push(r.demandaTitulo);
      continue;
    }
    const jaExiste = await c.query('SELECT 1 FROM relatorios WHERE demanda_id = $1 AND criado_em = $2::timestamptz', [
      demandaId,
      r.criadoEm,
    ]);
    if (jaExiste.rowCount) {
      resultado.relatorios.jaExistiam++;
      continue;
    }
    await c.query(
      `INSERT INTO relatorios (demanda_id, demanda_titulo, gerente, nivel_complexidade, setores_envolvidos,
         fontes_utilizadas, metricas, ganhos, perdas, aprendizado, ponderacoes, entrega_url, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
      [
        demandaId,
        r.demandaTitulo,
        r.gerente,
        r.nivelComplexidade,
        r.setoresEnvolvidos.filter((s) => CATEGORIAS_DE_SETOR.has(s)),
        r.fontesUtilizadas,
        JSON.stringify(r.metricas),
        r.ganhos,
        r.perdas,
        r.aprendizado,
        JSON.stringify(r.ponderacoes),
        r.entregaUrl,
        r.criadoEm,
      ],
    );
    resultado.relatorios.inseridos++;
  }
}

async function importarAprendizado(c: pg.PoolClient, dados: Dados, resultado: ResultadoImportacao): Promise<void> {
  for (const a of dados.aprendizado) {
    const jaExiste = await c.query('SELECT 1 FROM aprendizado_evolucao WHERE demanda = $1 AND aprendizado = $2', [
      a.demanda,
      a.aprendizado,
    ]);
    if (jaExiste.rowCount) {
      resultado.aprendizado.jaExistiam++;
      continue;
    }
    await c.query('INSERT INTO aprendizado_evolucao (data, demanda, nivel, aprendizado, indice) VALUES ($1::date, $2, $3, $4, $5)', [
      a.data,
      a.demanda,
      a.nivel,
      a.aprendizado,
      a.indice,
    ]);
    resultado.aprendizado.inseridas++;
  }
}

// Tudo-ou-nada e idempotente: chave natural (título + data de criação), então rodar duas vezes não duplica.
export async function importarLegado(pool: pg.Pool, bruto: unknown): Promise<ResultadoImportacao> {
  const dados = ArquivoLegadoSchema.parse(bruto);
  exigirTitulosUnicos(dados);

  return comTransacao(pool, async (c) => {
    const resultado = novoResultado();
    const idPorTitulo = await importarDemandas(c, dados, resultado);
    await importarRelatorios(c, dados, idPorTitulo, resultado);
    await importarAprendizado(c, dados, resultado);
    return resultado;
  });
}
