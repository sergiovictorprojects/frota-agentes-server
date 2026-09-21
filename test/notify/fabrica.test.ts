import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificadorEmail } from '../../src/notify/email.ts';
import { criarNotificador, NotificadorMultiplo } from '../../src/notify/fabrica.ts';
import { NotificadorConsole } from '../../src/notify/notificador.ts';
import { NotificadorMemoria } from '../helpers/fakes.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const aviso = { nivel: 'aviso', titulo: 'Orçamento em 80%', corpo: 'Gasto: US$ 40' } as const;

const configEmail = {
  NOTIFY_CHANNEL: 'email',
  RESEND_API_KEY: 're_chave_de_teste_1234567890',
  NOTIFY_EMAIL_TO: 'dono@exemplo.com',
  NOTIFY_EMAIL_FROM: 'Frota <onboarding@resend.dev>',
} as const;

describe('criarNotificador', () => {
  it('usa so o console quando o canal e console', () => {
    const n = criarNotificador({ NOTIFY_CHANNEL: 'console', NOTIFY_EMAIL_FROM: 'x', RESEND_API_KEY: undefined, NOTIFY_EMAIL_TO: undefined });
    expect(n).toBeInstanceOf(NotificadorConsole);
  });

  it('com o canal email, entrega no e-mail e tambem registra no log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const buscar = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"id":"1"}', { status: 200 }));
    const n = criarNotificador(configEmail, { buscar: buscar as unknown as typeof fetch });

    await n.notificar(aviso);

    expect(buscar).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(buscar.mock.calls[0]![1]!.body))).toMatchObject({
      to: ['dono@exemplo.com'],
      subject: '[Frota] [Aviso] Orçamento em 80%',
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('Orçamento em 80%');
  });

  it('recusa o canal email sem chave ou sem destinatario, em vez de falhar so na hora de avisar', () => {
    expect(() => criarNotificador({ ...configEmail, RESEND_API_KEY: undefined })).toThrow(/RESEND_API_KEY/);
    expect(() => criarNotificador({ ...configEmail, NOTIFY_EMAIL_TO: undefined })).toThrow(/NOTIFY_EMAIL_TO/);
  });

  it('cria um NotificadorEmail internamente para o canal email', () => {
    expect(criarNotificador(configEmail)).toBeInstanceOf(NotificadorMultiplo);
    expect(new NotificadorEmail({ apiKey: 'k', de: 'a@b.c', para: 'd@e.f' })).toBeInstanceOf(NotificadorEmail);
  });
});

describe('NotificadorMultiplo', () => {
  it('entrega em todos os canais', async () => {
    const a = new NotificadorMemoria();
    const b = new NotificadorMemoria();

    await new NotificadorMultiplo([a, b]).notificar(aviso);

    expect(a.enviadas).toEqual([aviso]);
    expect(b.enviadas).toEqual([aviso]);
  });

  it('um canal que falha nao impede os outros de receber, mas a falha e reportada', async () => {
    const bom = new NotificadorMemoria();
    const quebrado = { notificar: async () => Promise.reject(new Error('e-mail fora do ar')) };

    const erro = await new NotificadorMultiplo([quebrado, bom]).notificar(aviso).catch((e: Error) => e);

    expect(bom.enviadas).toEqual([aviso]);
    expect((erro as Error).message).toContain('Falha em 1 de 2 canais');
    expect((erro as Error).message).toContain('e-mail fora do ar');
  });
});
