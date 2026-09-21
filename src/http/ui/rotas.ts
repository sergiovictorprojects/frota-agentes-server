import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  arquivarDemanda,
  contarPorStatus,
  criarDemanda,
  listarDemandas,
  obterDemanda,
  reabrirDemanda,
} from '../../db/demandas.ts';
import { adicionarMensagem, listarMensagens } from '../../db/mensagens.ts';
import { obterFlags, pausarFrota, retomarFrota, ultimaRun } from '../../db/operacao.ts';
import { listarRelatorios, relatorioMaisRecente } from '../../db/relatorios.ts';
import { CATEGORIAS, PRIORIDADES, STATUS } from '../../domain/setores.ts';
import { log } from '../../util/log.ts';
import { credenciaisValidas, origemConfiavel } from '../auth.ts';
import type { Bruto } from './html.ts';
import { pagina, type Aba, type EstadoFrota } from './layout.ts';
import { paginaDetalhe, paginaFila, paginaMensagem, paginaNova, paginaRelatorios } from './paginas.ts';

export interface DependenciasUi {
  pool: pg.Pool;
  usuario: string;
  senha: string;
  disparar?: () => Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVISOS_DISPARO: Readonly<Record<string, string>> = {
  ok: 'Execução enfileirada: ela começa em instantes.',
  ignorado: 'Já existe uma execução na fila ou em andamento.',
  indisponivel: 'O disparo manual não está disponível.',
};

const vazioParaUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opcional = (max: number, mensagem: string) =>
  z.preprocess(vazioParaUndefined, z.string().trim().max(max, mensagem).optional());

// Datas impossíveis como 2026-13-45 dão NaN em Date.parse e 2026-02-31 "rola" para março: as duas são recusadas.
function dataExiste(texto: string): boolean {
  const instante = Date.parse(`${texto}T00:00:00Z`);
  return !Number.isNaN(instante) && new Date(instante).toISOString().startsWith(texto);
}

const NovaDemandaForm = z.object({
  titulo: z.string().trim().min(1, 'Informe o título.').max(200, 'O título aceita no máximo 200 caracteres.'),
  categoria: z.enum(CATEGORIAS, 'Escolha um setor válido.'),
  prioridade: z.enum(PRIORIDADES, 'Escolha uma prioridade válida.').default('MEDIUM'),
  prazo: z.preprocess(
    vazioParaUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use uma data no formato AAAA-MM-DD.')
      .refine(dataExiste, 'Essa data não existe.')
      .optional(),
  ),
  solicitante: opcional(200, 'O solicitante aceita no máximo 200 caracteres.'),
  descricao: opcional(20000, 'A descrição aceita no máximo 20000 caracteres.'),
  referencias: opcional(5000, 'As referências aceitam no máximo 5000 caracteres.'),
});

const RespostaForm = z.object({
  texto: z.string().trim().min(1, 'Escreva a resposta.').max(4000, 'A resposta aceita no máximo 4000 caracteres.'),
});

const cabecalho = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

function textoDoCorpo(corpo: unknown): Record<string, string> {
  const saida: Record<string, string> = {};
  if (typeof corpo === 'object' && corpo !== null) {
    for (const [chave, valor] of Object.entries(corpo)) if (typeof valor === 'string') saida[chave] = valor;
  }
  return saida;
}

interface Respostas {
  enviar(reply: FastifyReply, codigo: number, titulo: string, aba: Aba | null, corpo: Bruto, aviso?: string | null): Promise<FastifyReply>;
  naoEncontrada(reply: FastifyReply): Promise<FastifyReply>;
  conflito(reply: FastifyReply, texto: string): Promise<FastifyReply>;
}

function criarRespostas(pool: pg.Pool): Respostas {
  async function estado(): Promise<EstadoFrota> {
    const [flags, run] = await Promise.all([obterFlags(pool), ultimaRun(pool)]);
    return {
      pausado: flags.pausado,
      motivo: flags.pausadoMotivo,
      ultimaRun: run
        ? { iniciadoEm: run.iniciadoEm, status: run.status, demandasProcessadas: run.demandasProcessadas }
        : null,
    };
  }
  const enviar: Respostas['enviar'] = async (reply, codigo, titulo, aba, corpo, aviso) => {
    const conteudo = pagina({ titulo, ativo: aba, estado: await estado(), corpo, aviso });
    return reply.code(codigo).type('text/html; charset=utf-8').send(conteudo);
  };
  return {
    enviar,
    naoEncontrada: (reply) =>
      enviar(reply, 404, 'Não encontrada', null, paginaMensagem('Não encontrada', 'Essa demanda não existe.')),
    conflito: (reply, texto) => enviar(reply, 409, 'Ação indisponível', null, paginaMensagem('Ação indisponível', texto)),
  };
}

// preHandler, e não onRequest: o limite de requisições roda em onRequest de rota, que só vem depois dos
// hooks de instância. Com a autenticação em onRequest, tentativas de senha errada nunca eram contadas.
function registrarAutenticacao(app: FastifyInstance, d: DependenciasUi): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!credenciaisValidas(req.headers.authorization, d.usuario, d.senha)) {
      // O X-Forwarded-For é informativo e forjável: serve para investigar, nunca para decidir.
      log('aviso', 'auth_falhou', { ip: req.ip, xff_nao_confiavel: cabecalho(req.headers['x-forwarded-for']) ?? null });
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="Frota", charset="UTF-8"')
        .type('text/plain; charset=utf-8')
        .send('Autenticação necessária.');
    }
    const escrita = req.method !== 'GET' && req.method !== 'HEAD';
    const origem = {
      origin: cabecalho(req.headers.origin),
      secFetchSite: cabecalho(req.headers['sec-fetch-site']),
      host: cabecalho(req.headers.host),
    };
    if (escrita && !origemConfiavel(origem)) {
      return reply.code(403).type('text/plain; charset=utf-8').send('Origem não permitida.');
    }
  });
}

function registrarFila(app: FastifyInstance, d: DependenciasUi, r: Respostas): void {
  app.get('/', async (req, reply) => {
    const consulta = z.object({ status: z.enum(STATUS).optional(), disparo: z.string().optional() }).safeParse(req.query);
    const filtro = consulta.success ? (consulta.data.status ?? null) : null;
    const aviso = consulta.success && consulta.data.disparo ? (AVISOS_DISPARO[consulta.data.disparo] ?? null) : null;
    const [demandas, contagem, flags] = await Promise.all([
      listarDemandas(d.pool, { status: filtro ?? undefined, limite: 100 }),
      contarPorStatus(d.pool),
      obterFlags(d.pool),
    ]);
    const corpo = paginaFila({ demandas, contagem, filtro, pausado: flags.pausado, podeExecutar: d.disparar !== undefined });
    return r.enviar(reply, 200, 'Fila', 'fila', corpo, aviso);
  });

  app.get('/relatorios', async (_req, reply) =>
    r.enviar(reply, 200, 'Relatórios', 'relatorios', paginaRelatorios({ relatorios: await listarRelatorios(d.pool, 100) })),
  );
}

function registrarCriacao(app: FastifyInstance, d: DependenciasUi, r: Respostas): void {
  app.get('/demandas/nova', async (_req, reply) =>
    r.enviar(reply, 200, 'Nova demanda', 'nova', paginaNova({ valores: {}, erros: [] })),
  );

  app.post('/demandas', async (req, reply) => {
    const valores = textoDoCorpo(req.body);
    const validado = NovaDemandaForm.safeParse(valores);
    if (!validado.success) {
      const erros = validado.error.issues.map((i) => i.message);
      return r.enviar(reply, 400, 'Nova demanda', 'nova', paginaNova({ valores, erros }));
    }
    const criada = await criarDemanda(d.pool, validado.data);
    return reply.redirect(`/demandas/${criada.id}`, 303);
  });
}

function registrarDetalheEAcoes(app: FastifyInstance, d: DependenciasUi, r: Respostas): void {
  app.get<{ Params: { id: string } }>('/demandas/:id', async (req, reply) => {
    const demanda = UUID.test(req.params.id) ? await obterDemanda(d.pool, req.params.id) : null;
    if (!demanda) return r.naoEncontrada(reply);
    const [mensagens, relatorio] = await Promise.all([listarMensagens(d.pool, demanda.id), relatorioMaisRecente(d.pool, demanda.id)]);
    return r.enviar(reply, 200, demanda.titulo, 'fila', paginaDetalhe({ demanda, mensagens, relatorio }));
  });

  app.post<{ Params: { id: string } }>('/demandas/:id/responder', async (req, reply) => {
    const demanda = UUID.test(req.params.id) ? await obterDemanda(d.pool, req.params.id) : null;
    if (!demanda) return r.naoEncontrada(reply);
    if (demanda.status !== 'Aguardando humano' && demanda.status !== 'Aguardando insumo') {
      return r.conflito(reply, 'Esta demanda não está esperando uma resposta.');
    }
    const validado = RespostaForm.safeParse(textoDoCorpo(req.body));
    if (!validado.success) return r.conflito(reply, validado.error.issues.map((i) => i.message).join(' '));
    await adicionarMensagem(d.pool, {
      demandaId: demanda.id,
      autor: 'solicitante',
      setor: demanda.categoria === 'gestores' ? null : demanda.categoria,
      texto: validado.data.texto,
    });
    await reabrirDemanda(d.pool, demanda.id);
    return reply.redirect(`/demandas/${demanda.id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/demandas/:id/reabrir', async (req, reply) => {
    const reaberta = UUID.test(req.params.id) ? await reabrirDemanda(d.pool, req.params.id) : null;
    if (!reaberta) return r.conflito(reply, 'Só é possível reabrir demandas que falharam ou estão esperando resposta.');
    return reply.redirect(`/demandas/${reaberta.id}`, 303);
  });

  app.post<{ Params: { id: string } }>('/demandas/:id/arquivar', async (req, reply) => {
    const arquivada = UUID.test(req.params.id) ? await arquivarDemanda(d.pool, req.params.id) : null;
    if (!arquivada) return r.conflito(reply, 'Não é possível arquivar uma demanda em andamento ou já arquivada.');
    return reply.redirect('/', 303);
  });
}

function registrarControlesDaFrota(app: FastifyInstance, d: DependenciasUi): void {
  app.post('/executar', async (_req, reply) => {
    const resultado = d.disparar ? ((await d.disparar()) ? 'ok' : 'ignorado') : 'indisponivel';
    return reply.redirect(`/?disparo=${resultado}`, 303);
  });

  app.post('/frota/pausar', async (_req, reply) => {
    await pausarFrota(d.pool, 'Pausada manualmente pela interface');
    return reply.redirect('/', 303);
  });

  app.post('/frota/retomar', async (_req, reply) => {
    await retomarFrota(d.pool);
    return reply.redirect('/', 303);
  });
}

export async function registrarUi(app: FastifyInstance, d: DependenciasUi): Promise<void> {
  const respostas = criarRespostas(d.pool);
  registrarAutenticacao(app, d);
  registrarFila(app, d, respostas);
  registrarCriacao(app, d, respostas);
  registrarDetalheEAcoes(app, d, respostas);
  registrarControlesDaFrota(app, d);
}
