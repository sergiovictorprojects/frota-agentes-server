import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { obterEntrega } from '../db/relatorios.ts';
import { html } from './ui/html.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// O HTML entregue foi escrito por um modelo, possivelmente influenciado por texto de terceiros. Duas camadas:
// 1) a URL que se abre (/entregas/<id>) é uma moldura nossa, com um aviso sempre visível, e o conteúdo
//    roda num iframe sandbox SEM allow-top-navigation: ele não consegue mandar a página principal para
//    outro endereço nem se passar por uma tela do próprio serviço;
// 2) o conteúdo (/conteudo) tem CSP sandbox sem allow-same-origin (origem opaca: não lê cookies nem o
//    resto do site), sem rede (connect-src none) e só carrega scripts inline ou do cdnjs.
const CSP_MOLDURA = [
  "default-src 'none'",
  "style-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CSP_CONTEUDO = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()';

function moldura(id: string, titulo: string): string {
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${titulo}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body class="moldura">
<p class="aviso-entrega" role="note">Conteúdo gerado por IA e isolado desta página. Nunca digite senhas, dados pessoais ou de pagamento nele.</p>
<iframe class="entrega" title="${titulo}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/entregas/${id}/conteudo"></iframe>
</body>
</html>
`.valor;
}

// A URL é um segredo (UUID aleatório): quem tem o link abre a entrega, sem senha, como um link de compartilhamento.
export async function registrarEntregas(app: FastifyInstance, pool: pg.Pool): Promise<void> {
  app.get<{ Params: { id: string } }>('/entregas/:id', async (req, reply) => {
    const entrega = UUID.test(req.params.id) ? await obterEntrega(pool, req.params.id) : null;
    if (!entrega) return reply.code(404).type('text/plain; charset=utf-8').send('Entrega não encontrada.');
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP_MOLDURA)
      .header('Permissions-Policy', PERMISSIONS_POLICY)
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('Cache-Control', 'no-store')
      .send(moldura(entrega.id, entrega.titulo));
  });

  app.get<{ Params: { id: string } }>('/entregas/:id/conteudo', async (req, reply) => {
    const entrega = UUID.test(req.params.id) ? await obterEntrega(pool, req.params.id) : null;
    if (!entrega) return reply.code(404).type('text/plain; charset=utf-8').send('Entrega não encontrada.');

    // Aberto direto, como página de topo, o conteúdo ficaria sem o aviso da moldura: devolve para ela.
    const destino = req.headers['sec-fetch-dest'];
    if (typeof destino === 'string' && destino !== 'iframe') return reply.redirect(`/entregas/${entrega.id}`, 302);

    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP_CONTEUDO)
      .header('Permissions-Policy', PERMISSIONS_POLICY)
      .header('X-DNS-Prefetch-Control', 'off')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('Cache-Control', 'no-store')
      .send(entrega.conteudo);
  });
}
