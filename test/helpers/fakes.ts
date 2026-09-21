import type { Llm, PedidoLlm, RespostaLlm } from '../../src/llm/llm.ts';
import type { Uso } from '../../src/llm/models.ts';
import type { Notificacao, Notificador } from '../../src/notify/notificador.ts';

export class NotificadorMemoria implements Notificador {
  readonly enviadas: Notificacao[] = [];

  async notificar(n: Notificacao): Promise<void> {
    this.enviadas.push(n);
  }
}

// Espera uma condição assíncrona ficar verdadeira, consultando a cada 100 ms.
export async function esperar(condicao: () => boolean | Promise<boolean>, limiteMs = 5000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await condicao()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condição não atendida em ${limiteMs} ms`);
}

export const USO_PADRAO: Uso = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };

// Responde com o valor devolvido por `responder`; se for um Error, lança. O valor passa pelo
// schema do pedido, como na implementação real, para os testes pegarem respostas fora do esquema.
export class LlmFalso implements Llm {
  readonly pedidos: PedidoLlm<unknown>[] = [];
  private readonly responder: (pedido: PedidoLlm<unknown>, indice: number) => unknown;
  private readonly uso: Uso;

  constructor(responder: (pedido: PedidoLlm<unknown>, indice: number) => unknown, uso: Uso = USO_PADRAO) {
    this.responder = responder;
    this.uso = uso;
  }

  async gerar<T>(pedido: PedidoLlm<T>): Promise<RespostaLlm<T>> {
    const registrado = pedido as PedidoLlm<unknown>;
    this.pedidos.push(registrado);
    const bruto = this.responder(registrado, this.pedidos.length - 1);
    if (bruto instanceof Error) throw bruto;
    return { valor: pedido.schema.parse(bruto), uso: this.uso, modelo: pedido.modelo, duracaoMs: 5 };
  }
}
