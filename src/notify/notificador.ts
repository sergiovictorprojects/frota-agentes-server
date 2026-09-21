export type NivelNotificacao = 'info' | 'aviso' | 'critico';

export interface Notificacao {
  nivel: NivelNotificacao;
  titulo: string;
  corpo: string;
}

export interface Notificador {
  notificar(n: Notificacao): Promise<void>;
}

// Canal padrão até o usuário escolher Telegram ou e-mail: uma linha JSON por notificação no log do serviço.
export class NotificadorConsole implements Notificador {
  async notificar(n: Notificacao): Promise<void> {
    console.log(JSON.stringify({ ts: new Date().toISOString(), tipo: 'notificacao', ...n }));
  }
}
