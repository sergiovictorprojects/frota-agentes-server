import type { NivelNotificacao, Notificacao, Notificador } from './notificador.ts';

// API HTTPS de e-mail, não SMTP: o Railway bloqueia as portas de SMTP nos planos Free, Trial e Hobby.
const URL_API = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;
const LIMITE_ASSUNTO = 200;
const LIMITE_DETALHE = 300;

const PREFIXO: Readonly<Record<NivelNotificacao, string>> = {
  info: '',
  aviso: '[Aviso] ',
  critico: '[CRÍTICO] ',
};

export interface OpcoesEmail {
  apiKey: string;
  de: string;
  para: string;
  buscar?: typeof fetch;
}

// Só texto puro: o corpo nunca é interpretado como HTML, então o conteúdo de uma demanda que apareça num
// aviso não vira marcação. A chave viaja só no cabeçalho e nunca entra em mensagens de erro.
export class NotificadorEmail implements Notificador {
  private readonly apiKey: string;
  private readonly de: string;
  private readonly para: string;
  private readonly buscar: typeof fetch;

  constructor(o: OpcoesEmail) {
    this.apiKey = o.apiKey;
    this.de = o.de;
    this.para = o.para;
    this.buscar = o.buscar ?? fetch;
  }

  async notificar(n: Notificacao): Promise<void> {
    // Quebra de linha no assunto permitiria injetar cabeçalhos de e-mail.
    const assunto = `[Frota] ${PREFIXO[n.nivel]}${n.titulo}`.replace(/[\r\n]+/g, ' ').slice(0, LIMITE_ASSUNTO);

    let resposta: Response;
    try {
      resposta = await this.buscar(URL_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.de, to: [this.para], subject: assunto, text: n.corpo }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : 'erro desconhecido';
      throw new Error(`Não foi possível contatar o serviço de e-mail: ${motivo}`);
    }

    if (!resposta.ok) {
      const detalhe = (await resposta.text().catch(() => '')).slice(0, LIMITE_DETALHE);
      throw new Error(`O serviço de e-mail recusou o envio (HTTP ${resposta.status})${detalhe ? `: ${detalhe}` : '.'}`);
    }
  }
}
