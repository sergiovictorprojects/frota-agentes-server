import { describe, expect, it, vi } from 'vitest';
import { NotificadorEmail } from '../../src/notify/email.ts';

const CHAVE = 're_chave_de_teste_1234567890';

function montar(resposta: Response | Error = new Response('{"id":"abc"}', { status: 200 })) {
  const buscar = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (resposta instanceof Error) throw resposta;
    return resposta;
  });
  const notificador = new NotificadorEmail({
    apiKey: CHAVE,
    de: 'Frota <onboarding@resend.dev>',
    para: 'dono@exemplo.com',
    buscar: buscar as unknown as typeof fetch,
  });
  return { buscar, notificador };
}

const corpoEnviado = (buscar: ReturnType<typeof montar>['buscar']) =>
  JSON.parse(String(buscar.mock.calls[0]![1]!.body)) as Record<string, unknown>;

describe('NotificadorEmail', () => {
  it('envia um POST para a API com a chave no cabecalho e o corpo em JSON', async () => {
    const { buscar, notificador } = montar();

    await notificador.notificar({ nivel: 'info', titulo: 'Fila processada', corpo: 'Tudo certo' });

    expect(buscar).toHaveBeenCalledTimes(1);
    const [url, init] = buscar.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init).toMatchObject({ method: 'POST' });
    expect(init!.headers).toEqual({ Authorization: `Bearer ${CHAVE}`, 'Content-Type': 'application/json' });
    expect(init!.signal).toBeDefined();
    expect(corpoEnviado(buscar)).toEqual({
      from: 'Frota <onboarding@resend.dev>',
      to: ['dono@exemplo.com'],
      subject: '[Frota] Fila processada',
      text: 'Tudo certo',
    });
  });

  it.each([
    ['info', '[Frota] Titulo'],
    ['aviso', '[Frota] [Aviso] Titulo'],
    ['critico', '[Frota] [CRÍTICO] Titulo'],
  ] as const)('marca o assunto conforme o nivel %s', async (nivel, esperado) => {
    const { buscar, notificador } = montar();
    await notificador.notificar({ nivel, titulo: 'Titulo', corpo: 'c' });
    expect(corpoEnviado(buscar).subject).toBe(esperado);
  });

  it('remove quebras de linha do assunto para impedir injecao de cabecalhos e limita o tamanho', async () => {
    const { buscar, notificador } = montar();

    await notificador.notificar({ nivel: 'info', titulo: `linha1\r\nBcc: alguem@evil.example\n${'x'.repeat(500)}`, corpo: 'c' });

    const assunto = String(corpoEnviado(buscar).subject);
    expect(assunto).not.toMatch(/[\r\n]/);
    expect(assunto.length).toBeLessThanOrEqual(200);
  });

  it('manda o corpo so como texto puro, nunca como HTML', async () => {
    const { buscar, notificador } = montar();

    await notificador.notificar({ nivel: 'aviso', titulo: 't', corpo: '<script>alert(1)</script>' });

    const corpo = corpoEnviado(buscar);
    expect(corpo.text).toBe('<script>alert(1)</script>');
    expect(corpo).not.toHaveProperty('html');
  });

  it('falha com o status e a explicacao do servico quando o envio e recusado, sem vazar a chave', async () => {
    const { notificador } = montar(
      new Response('{"message":"You can only send testing emails to your own email address"}', { status: 403 }),
    );

    const erro = await notificador.notificar({ nivel: 'info', titulo: 't', corpo: 'c' }).catch((e: Error) => e);

    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toContain('HTTP 403');
    expect((erro as Error).message).toContain('own email address');
    expect((erro as Error).message).not.toContain(CHAVE);
  });

  it('falha quando o servico nao responde, sem vazar a chave', async () => {
    const { notificador } = montar(new Error('fetch failed'));

    const erro = await notificador.notificar({ nivel: 'info', titulo: 't', corpo: 'c' }).catch((e: Error) => e);

    expect((erro as Error).message).toContain('Não foi possível contatar o serviço de e-mail');
    expect((erro as Error).message).toContain('fetch failed');
    expect((erro as Error).message).not.toContain(CHAVE);
  });

  it('nao quebra quando a recusa vem sem corpo legivel', async () => {
    const { notificador } = montar(new Response('', { status: 500 }));
    await expect(notificador.notificar({ nivel: 'info', titulo: 't', corpo: 'c' })).rejects.toThrow('HTTP 500).');
  });
});
