import type { Config } from '../config/env.ts';
import { mensagemDeErro } from '../util/log.ts';
import { NotificadorEmail } from './email.ts';
import { NotificadorConsole, type Notificacao, type Notificador } from './notificador.ts';

type ConfigDeNotificacao = Pick<Config, 'NOTIFY_CHANNEL' | 'RESEND_API_KEY' | 'NOTIFY_EMAIL_TO' | 'NOTIFY_EMAIL_FROM'>;

// Entrega em todos os canais e só depois reporta as falhas: um e-mail que não sai não pode apagar o
// registro no log, que é onde o aviso continua existindo mesmo com o provedor de e-mail fora do ar.
export class NotificadorMultiplo implements Notificador {
  private readonly canais: readonly Notificador[];

  constructor(canais: readonly Notificador[]) {
    this.canais = canais;
  }

  async notificar(n: Notificacao): Promise<void> {
    const resultados = await Promise.allSettled(this.canais.map((c) => c.notificar(n)));
    const falhas = resultados.flatMap((r) => (r.status === 'rejected' ? [mensagemDeErro(r.reason)] : []));
    if (falhas.length > 0) throw new Error(`Falha em ${falhas.length} de ${this.canais.length} canais de aviso: ${falhas.join(' | ')}`);
  }
}

export function criarNotificador(config: ConfigDeNotificacao, opcoes: { buscar?: typeof fetch } = {}): Notificador {
  if (config.NOTIFY_CHANNEL !== 'email') return new NotificadorConsole();
  if (!config.RESEND_API_KEY || !config.NOTIFY_EMAIL_TO) {
    throw new Error('NOTIFY_CHANNEL=email exige RESEND_API_KEY e NOTIFY_EMAIL_TO.');
  }
  const email = new NotificadorEmail({
    apiKey: config.RESEND_API_KEY,
    de: config.NOTIFY_EMAIL_FROM,
    para: config.NOTIFY_EMAIL_TO,
    buscar: opcoes.buscar,
  });
  return new NotificadorMultiplo([new NotificadorConsole(), email]);
}
