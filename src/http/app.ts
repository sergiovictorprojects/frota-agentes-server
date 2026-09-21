import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { obterFlags, ultimaRun } from '../db/operacao.ts';
import { log, mensagemDeErro } from '../util/log.ts';
import { registrarEntregas } from './entregas.ts';
import { CSS } from './ui/estilos.ts';
import { registrarUi } from './ui/rotas.ts';

export interface DependenciasApp {
  pool: pg.Pool;
  usuario: string;
  senha: string;
  disparar?: () => Promise<boolean>;
  limitePorMinuto?: number;
}

const TAMANHO_MAXIMO_CORPO = 64 * 1024;
// Vale para tudo o que chega ao serviço. A 300 por minuto, adivinhar uma senha de 16+ caracteres aleatórios é inviável.
const LIMITE_PADRAO_POR_MINUTO = 300;
const CSP_UI = "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export async function criarApp(d: DependenciasApp): Promise<FastifyInstance> {
  // Sem trustProxy de propósito: não sabemos como o proxy do provedor monta o X-Forwarded-For, e confiar
  // nele deixaria qualquer cliente forjar o IP e escapar do limite. Sem isso, req.ip é o do proxy e o
  // limite passa a ser único para todos: falha fechado e não dá para ser contornado por cabeçalho.
  const app = Fastify({ bodyLimit: TAMANHO_MAXIMO_CORPO });
  await app.register(rateLimit, { max: d.limitePorMinuto ?? LIMITE_PADRAO_POR_MINUTO, timeWindow: '1 minute' });
  await app.register(formbody);

  app.addHook('onSend', async (_req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (!reply.hasHeader('content-security-policy')) reply.header('Content-Security-Policy', CSP_UI);
    if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler(async (erro: unknown, req, reply) => {
    const status = typeof erro === 'object' && erro !== null && 'statusCode' in erro ? erro.statusCode : undefined;
    const codigo = typeof status === 'number' && status >= 400 ? status : 500;
    if (codigo >= 500) log('erro', 'erro_http', { rota: req.routeOptions.url, erro: mensagemDeErro(erro) });
    // Em 4xx a mensagem vem do próprio Fastify (corpo grande demais, limite excedido) e é segura de mostrar.
    return reply
      .code(codigo)
      .type('text/plain; charset=utf-8')
      .send(codigo >= 500 ? 'Erro interno.' : mensagemDeErro(erro));
  });

  app.get('/health', async (_req, reply) => {
    try {
      const [run, flags] = await Promise.all([ultimaRun(d.pool), obterFlags(d.pool)]);
      return {
        status: 'ok',
        pausado: flags.pausado,
        ultimaRun: run
          ? { iniciadoEm: run.iniciadoEm, status: run.status, demandasProcessadas: run.demandasProcessadas }
          : null,
      };
    } catch (erro) {
      log('erro', 'health_falhou', { erro: mensagemDeErro(erro) });
      return reply.code(503).send({ status: 'erro' });
    }
  });

  app.get('/app.css', async (_req, reply) =>
    reply.type('text/css; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(CSS),
  );

  await registrarEntregas(app, d.pool);
  await app.register(async (ui) => registrarUi(ui, d));
  return app;
}
