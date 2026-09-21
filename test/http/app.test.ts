import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarDemanda, obterDemanda } from '../../src/db/demandas.ts';
import { adicionarMensagem, listarMensagens } from '../../src/db/mensagens.ts';
import { finalizarRun, iniciarRun, obterFlags } from '../../src/db/operacao.ts';
import { criarEntrega, salvarRelatorio } from '../../src/db/relatorios.ts';
import { criarApp } from '../../src/http/app.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

const USUARIO = 'frota';
const SENHA = 'senha-de-teste-123';
const AUTORIZACAO = `Basic ${Buffer.from(`${USUARIO}:${SENHA}`).toString('base64')}`;
const FORM = { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };

describe('aplicacao HTTP', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const disparar = vi.fn<() => Promise<boolean>>();

  beforeAll(async () => {
    db = await createTestDb();
    app = await criarApp({ pool: db.pool, usuario: USUARIO, senha: SENHA, disparar, limitePorMinuto: 10_000 });
  });
  afterAll(async () => {
    await app.close();
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs CASCADE');
    await db.pool.query("UPDATE system_flags SET pausado = false, pausado_motivo = NULL, alertas_enviados = '{}'");
    disparar.mockReset();
  });

  const get = (url: string, headers: Record<string, string> = { authorization: AUTORIZACAO }) =>
    app.inject({ method: 'GET', url, headers });
  const post = (url: string, dados: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: AUTORIZACAO, ...FORM, ...headers },
      payload: new URLSearchParams(dados).toString(),
    });

  describe('health', () => {
    it('responde sem autenticacao, informando pausa e a ultima execucao', async () => {
      const antes = await get('/health', {});
      expect(antes.statusCode).toBe(200);
      expect(antes.json()).toEqual({ status: 'ok', pausado: false, ultimaRun: null });

      const runId = await iniciarRun(db.pool);
      await finalizarRun(db.pool, runId, { status: 'ok', demandasProcessadas: 2 });
      const depois = (await get('/health', {})).json();
      expect(depois.ultimaRun).toMatchObject({ status: 'ok', demandasProcessadas: 2 });
    });

    it('responde 503 quando o banco esta fora do ar, sem vazar detalhes', async () => {
      const quebrado = { query: async () => Promise.reject(new Error('senha do banco: hunter2')) } as unknown as pg.Pool;
      const outro = await criarApp({ pool: quebrado, usuario: USUARIO, senha: SENHA });
      const r = await outro.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain('hunter2');
      await outro.close();
    });
  });

  describe('autenticacao e cabecalhos', () => {
    it('exige credenciais na interface', async () => {
      const sem = await get('/', {});
      expect(sem.statusCode).toBe(401);
      expect(sem.headers['www-authenticate']).toContain('Basic');
      const errada = await get('/', { authorization: `Basic ${Buffer.from(`${USUARIO}:errada`).toString('base64')}` });
      expect(errada.statusCode).toBe(401);
    });

    it('protege todas as rotas de escrita, nao so as de leitura', async () => {
      const r = await app.inject({ method: 'POST', url: '/frota/pausar', headers: { ...FORM } });
      expect(r.statusCode).toBe(401);
      expect((await obterFlags(db.pool)).pausado).toBe(false);
    });

    it('envia cabecalhos de seguranca na interface', async () => {
      const r = await get('/');
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['cache-control']).toBe('no-store');
    });

    it('serve o CSS sem autenticacao', async () => {
      const r = await get('/app.css', {});
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/css');
    });

    it('recusa corpos maiores que 64 KB', async () => {
      const r = await post('/demandas', { titulo: 'x', descricao: 'a'.repeat(70_000) });
      expect(r.statusCode).toBe(413);
    });
  });

  describe('protecao contra CSRF', () => {
    it('recusa escrita vinda de outro site e nao altera nada', async () => {
      const r = await post('/demandas', { titulo: 'Invasora', categoria: 'd1' }, { 'sec-fetch-site': 'cross-site' });
      expect(r.statusCode).toBe(403);
      expect((await db.pool.query('SELECT 1 FROM demandas')).rowCount).toBe(0);
    });

    it('recusa Origin diferente do Host quando o navegador nao envia Sec-Fetch-Site', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/frota/pausar',
        headers: { authorization: AUTORIZACAO, 'content-type': FORM['content-type'], origin: 'https://evil.example', host: 'frota.exemplo.com' },
        payload: '',
      });
      expect(r.statusCode).toBe(403);
      expect((await obterFlags(db.pool)).pausado).toBe(false);
    });
  });

  describe('fila e criacao de demandas', () => {
    it('lista demandas escapando qualquer HTML no titulo', async () => {
      await criarDemanda(db.pool, { titulo: '<script>alert(1)</script>', categoria: 'd1' });
      const r = await get('/');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Fila de demandas');
      expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(r.body).not.toContain('<script>alert(1)');
    });

    it('filtra por status e ignora filtro invalido', async () => {
      await criarDemanda(db.pool, { titulo: 'Aberta', categoria: 'd1' });
      const c = await criarDemanda(db.pool, { titulo: 'Fechada', categoria: 'd1' });
      await db.pool.query("UPDATE demandas SET status = 'Concluída' WHERE id = $1", [c.id]);
      const concluidas = (await get('/?status=Conclu%C3%ADda')).body;
      expect(concluidas).toContain('Fechada');
      expect(concluidas).not.toContain('Aberta');
      expect((await get('/?status=Inventado')).statusCode).toBe(200);
    });

    it('cria uma demanda valida e redireciona para o detalhe', async () => {
      const r = await post('/demandas', {
        titulo: '  Sistema de estoque  ',
        categoria: 'd11',
        prioridade: 'HIGH',
        prazo: '2026-10-01',
        solicitante: 'Juliano',
        descricao: 'Painel 3D',
        referencias: '',
      });
      expect(r.statusCode).toBe(303);
      const id = r.headers.location!.split('/').pop()!;
      expect(await obterDemanda(db.pool, id)).toMatchObject({
        titulo: 'Sistema de estoque',
        categoria: 'd11',
        prioridade: 'HIGH',
        prazo: '2026-10-01',
        solicitante: 'Juliano',
        referencias: null,
        status: 'Nova',
      });
    });

    it('rejeita dados invalidos com mensagens e sem criar nada, preservando o que foi digitado', async () => {
      const r = await post('/demandas', { titulo: '   ', categoria: 'd99', prazo: '2026-02-31', descricao: 'texto que fica' });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('Informe o título.');
      expect(r.body).toContain('Escolha um setor válido.');
      expect(r.body).toContain('Essa data não existe.');
      expect(r.body).toContain('texto que fica');
      expect((await db.pool.query('SELECT 1 FROM demandas')).rowCount).toBe(0);
    });

    it.each(['2026-13-45', '2026-00-10', '2026-02-31', 'amanha'])('recusa o prazo impossivel %s com 400, nunca com 500', async (prazo) => {
      const r = await post('/demandas', { titulo: 'x', categoria: 'd1', prazo });
      expect(r.statusCode).toBe(400);
      expect((await db.pool.query('SELECT 1 FROM demandas')).rowCount).toBe(0);
    });

    it('nao reflete HTML injetado de volta no formulario', async () => {
      const r = await post('/demandas', { titulo: '"><script>alert(1)</script>', categoria: 'd99' });
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain('<script>alert(1)');
    });
  });

  describe('detalhe e acoes', () => {
    it('mostra a linha do tempo dos agentes, o relatorio e o link da entrega, tudo escapado', async () => {
      const d = await criarDemanda(db.pool, { titulo: 'Detalhada', categoria: 'd1', descricao: '<img src=x onerror=alert(1)>' });
      await adicionarMensagem(db.pool, { demandaId: d.id, autor: 'agente', agente: 'frota:architect', texto: 'Plano: <b>entregar</b>' });
      const entrega = await criarEntrega(db.pool, { demandaId: d.id, titulo: 'T', conteudo: '<p>x</p>' });
      const url = `https://frota.exemplo.com/entregas/${entrega.id}`;
      await db.pool.query('UPDATE demandas SET entrega_url = $2 WHERE id = $1', [d.id, url]);
      await salvarRelatorio(db.pool, {
        demandaId: d.id,
        demandaTitulo: 'Detalhada',
        gerente: 'frota:architect',
        nivelComplexidade: 3,
        setoresEnvolvidos: ['d1'],
        fontesUtilizadas: null,
        metricas: { acoesRealizadas: '2 chamadas', tempoTotal: '9s', indiceGeral: 88, antipadroesCount: 1, regrasCumpridasPercent: 50 },
        ganhos: 'bom',
        perdas: 'algo',
        aprendizado: 'muito',
        ponderacoes: [{ setor: 'd1', nota: 'ok' }],
        entregaUrl: url,
      });

      const r = await get(`/demandas/${d.id}`);

      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('frota:architect');
      expect(r.body).toContain('Plano: &lt;b&gt;entregar&lt;/b&gt;');
      expect(r.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(r.body).not.toContain('<img src=x');
      expect(r.body).toContain(`href="${url}"`);
      expect(r.body).toContain('88');
      expect(r.body).toContain('50%');
    });

    it('devolve 404 para demanda inexistente ou id que nao e UUID, sem erro 500', async () => {
      expect((await get(`/demandas/${randomUUID()}`)).statusCode).toBe(404);
      expect((await get("/demandas/1'; DROP TABLE demandas;--")).statusCode).toBe(404);
    });

    it('responde a um pedido de insumo: grava a mensagem do solicitante e recoloca na fila', async () => {
      const d = await criarDemanda(db.pool, { titulo: 'Espera', categoria: 'd1' });
      await db.pool.query("UPDATE demandas SET status = 'Aguardando insumo', alternativa_insumo = 'B' WHERE id = $1", [d.id]);

      const r = await post(`/demandas/${d.id}/responder`, { texto: 'O logo é azul' });

      expect(r.statusCode).toBe(303);
      expect(await obterDemanda(db.pool, d.id)).toMatchObject({ status: 'Nova', tentativas: 0 });
      const msgs = await listarMensagens(db.pool, d.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ autor: 'solicitante', texto: 'O logo é azul' });
    });

    it('nao aceita resposta para uma demanda que nao esta esperando', async () => {
      const d = await criarDemanda(db.pool, { titulo: 'Nova', categoria: 'd1' });
      expect((await post(`/demandas/${d.id}/responder`, { texto: 'oi' })).statusCode).toBe(409);
      expect(await listarMensagens(db.pool, d.id)).toHaveLength(0);
    });

    it('reabre uma demanda que falhou zerando as tentativas', async () => {
      const d = await criarDemanda(db.pool, { titulo: 'Falhou', categoria: 'd1' });
      await db.pool.query("UPDATE demandas SET status = 'Falhou', tentativas = 3 WHERE id = $1", [d.id]);
      expect((await post(`/demandas/${d.id}/reabrir`)).statusCode).toBe(303);
      expect(await obterDemanda(db.pool, d.id)).toMatchObject({ status: 'Nova', tentativas: 0 });
      expect((await post(`/demandas/${d.id}/reabrir`)).statusCode).toBe(409);
    });

    it('arquiva demandas, exceto as que estao em andamento', async () => {
      const a = await criarDemanda(db.pool, { titulo: 'Arquivavel', categoria: 'd1' });
      const b = await criarDemanda(db.pool, { titulo: 'Em curso', categoria: 'd1' });
      await db.pool.query("UPDATE demandas SET status = 'Em andamento' WHERE id = $1", [b.id]);

      expect((await post(`/demandas/${a.id}/arquivar`)).statusCode).toBe(303);
      expect((await obterDemanda(db.pool, a.id))?.status).toBe('Arquivada');
      expect((await post(`/demandas/${b.id}/arquivar`)).statusCode).toBe(409);
      expect((await obterDemanda(db.pool, b.id))?.status).toBe('Em andamento');
    });
  });

  describe('controles da frota', () => {
    it('pausa e retoma a frota', async () => {
      expect((await post('/frota/pausar')).statusCode).toBe(303);
      expect(await obterFlags(db.pool)).toMatchObject({ pausado: true });
      expect((await get('/')).body).toContain('Retomar frota');
      expect((await post('/frota/retomar')).statusCode).toBe(303);
      expect(await obterFlags(db.pool)).toMatchObject({ pausado: false });
    });

    it('dispara uma execucao manual e informa o resultado', async () => {
      disparar.mockResolvedValueOnce(true);
      const ok = await post('/executar');
      expect(ok.headers.location).toBe('/?disparo=ok');
      expect((await get('/?disparo=ok')).body).toContain('Execução enfileirada');

      disparar.mockResolvedValueOnce(false);
      expect((await post('/executar')).headers.location).toBe('/?disparo=ignorado');
      expect(disparar).toHaveBeenCalledTimes(2);
    });

    it('sem disparador configurado, avisa que o disparo manual nao esta disponivel', async () => {
      const semDisparo = await criarApp({ pool: db.pool, usuario: USUARIO, senha: SENHA });
      const r = await semDisparo.inject({ method: 'POST', url: '/executar', headers: { authorization: AUTORIZACAO, ...FORM } });
      expect(r.headers.location).toBe('/?disparo=indisponivel');
      await semDisparo.close();
    });
  });

  describe('relatorios', () => {
    it('lista os relatorios existentes', async () => {
      const d = await criarDemanda(db.pool, { titulo: 'Com relatorio', categoria: 'd1' });
      await salvarRelatorio(db.pool, {
        demandaId: d.id,
        demandaTitulo: 'Com relatorio',
        gerente: 'g',
        nivelComplexidade: 2,
        setoresEnvolvidos: [],
        fontesUtilizadas: null,
        metricas: { acoesRealizadas: 'x', tempoTotal: '1s', indiceGeral: null, antipadroesCount: null, regrasCumpridasPercent: null, auditoriaFalhou: true },
        ganhos: null,
        perdas: null,
        aprendizado: null,
        ponderacoes: [],
        entregaUrl: null,
      });
      const r = await get('/relatorios');
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Com relatorio');
      expect(r.body).toContain('não medido');
    });
  });

  describe('entregas hospedadas', () => {
    async function novaEntrega(conteudo: string, titulo = 'Painel <3D>') {
      const d = await criarDemanda(db.pool, { titulo: 'Com entrega', categoria: 'd1' });
      return criarEntrega(db.pool, { demandaId: d.id, titulo, conteudo });
    }

    it('abre uma moldura com aviso e o conteudo gerado num iframe sandbox sem navegar a pagina principal', async () => {
      const e = await novaEntrega('<h1>Olá</h1><script>top.location = "https://evil.example"</script>');

      const r = await get(`/entregas/${e.id}`, {});

      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Conteúdo gerado por IA e isolado desta página');
      expect(r.body).toContain(`src="/entregas/${e.id}/conteudo"`);
      expect(r.body).toContain('sandbox="allow-scripts"');
      expect(r.body).not.toContain('allow-top-navigation');
      expect(r.body).not.toContain('allow-same-origin');
      expect(r.body).toContain('<title>Painel &lt;3D&gt;</title>');
      expect(r.body).not.toContain('evil.example');
      const csp = r.headers['content-security-policy'] as string;
      expect(csp).toContain("frame-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(r.headers['permissions-policy']).toContain('camera=()');
      expect(r.headers['x-robots-tag']).toContain('noindex');
    });

    it('serve o conteudo sem senha, isolado em sandbox, sem rede e so embutido pela propria moldura', async () => {
      const conteudo = '<!doctype html><h1>Olá 📦</h1><script>document.title = "x"</script>';
      const e = await novaEntrega(conteudo);

      const r = await get(`/entregas/${e.id}/conteudo`, { 'sec-fetch-dest': 'iframe' });

      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(conteudo);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      const csp = r.headers['content-security-policy'] as string;
      expect(csp).toContain('sandbox allow-scripts');
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).not.toContain('allow-top-navigation');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(r.headers['permissions-policy']).toContain('microphone=()');
      expect(r.headers['x-dns-prefetch-control']).toBe('off');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    });

    it('nao deixa o conteudo ser aberto direto como pagina de topo: redireciona para a moldura', async () => {
      const e = await novaEntrega('<p>x</p>');

      const r = await get(`/entregas/${e.id}/conteudo`, { 'sec-fetch-dest': 'document' });

      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(`/entregas/${e.id}`);
    });

    it('serve o conteudo a clientes que nao informam Sec-Fetch-Dest, como o curl', async () => {
      const e = await novaEntrega('<p>x</p>');
      expect((await get(`/entregas/${e.id}/conteudo`, {})).statusCode).toBe(200);
    });

    it('devolve 404 para entrega inexistente ou id invalido, na moldura e no conteudo', async () => {
      expect((await get(`/entregas/${randomUUID()}`, {})).statusCode).toBe(404);
      expect((await get('/entregas/nao-e-uuid', {})).statusCode).toBe(404);
      expect((await get(`/entregas/${randomUUID()}/conteudo`, {})).statusCode).toBe(404);
      expect((await get('/entregas/nao-e-uuid/conteudo', {})).statusCode).toBe(404);
    });
  });

  describe('limite de requisicoes', () => {
    it('responde 429 depois de exceder o limite por minuto', async () => {
      const limitado = await criarApp({ pool: db.pool, usuario: USUARIO, senha: SENHA, limitePorMinuto: 5 });
      const codigos: number[] = [];
      for (let i = 0; i < 8; i++) codigos.push((await limitado.inject({ method: 'GET', url: '/health' })).statusCode);
      expect(codigos.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(codigos.slice(5)).toEqual([429, 429, 429]);
      await limitado.close();
    });

    it('conta tambem as tentativas de senha errada, senao o login seria vulneravel a forca bruta', async () => {
      const limitado = await criarApp({ pool: db.pool, usuario: USUARIO, senha: SENHA, limitePorMinuto: 3 });
      const errada = { authorization: `Basic ${Buffer.from(`${USUARIO}:tentativa`).toString('base64')}` };
      const codigos: number[] = [];
      for (let i = 0; i < 6; i++) codigos.push((await limitado.inject({ method: 'GET', url: '/', headers: errada })).statusCode);
      expect(codigos).toEqual([401, 401, 401, 429, 429, 429]);
      await limitado.close();
    });

    it('nao confia no X-Forwarded-For: forjar o cabecalho nao escapa do limite', async () => {
      const limitado = await criarApp({ pool: db.pool, usuario: USUARIO, senha: SENHA, limitePorMinuto: 3 });
      const codigos: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await limitado.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-for': `10.0.0.${i}` } });
        codigos.push(r.statusCode);
      }
      expect(codigos).toEqual([401, 401, 401, 429, 429, 429]);
      await limitado.close();
    });
  });

  describe('transporte', () => {
    it('envia HSTS para manter o navegador em HTTPS', async () => {
      const r = await get('/health', {});
      expect(r.headers['strict-transport-security']).toContain('max-age=');
    });
  });
});
