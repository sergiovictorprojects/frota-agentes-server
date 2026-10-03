import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { Uso } from './models.ts';

export interface PedidoLlm<T> {
  modelo: string;
  // Papel do servidor que está falando (ex.: frota:architect). Vai para o registro de passos.
  papel: string;
  sistema: string;
  usuario: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  contexto?: { runId?: string | null; demandaId?: string | null };
}

export interface RespostaLlm<T> {
  valor: T;
  uso: Uso;
  modelo: string;
  duracaoMs: number;
}

export interface Llm {
  gerar<T>(pedido: PedidoLlm<T>): Promise<RespostaLlm<T>>;
}

export type TipoErroLlm = 'recusa' | 'truncado' | 'invalido' | 'api' | 'timeout';
export type CausaErroApiLlm =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'overload'
  | 'bad_request'
  | 'nao_encontrado'
  | 'servidor'
  | 'rede'
  | 'desconhecida';

export class LlmError extends Error {
  readonly tipo: TipoErroLlm;
  // Tokens já consumidos: mesmo uma resposta ruim custa dinheiro e precisa ser contabilizada.
  readonly uso: Uso | null;
  readonly status: number | null;
  readonly causa: CausaErroApiLlm | null;

  constructor(tipo: TipoErroLlm, mensagem: string, uso: Uso | null = null, status: number | null = null, causa: CausaErroApiLlm | null = null) {
    super(mensagem);
    this.name = 'LlmError';
    this.tipo = tipo;
    this.uso = uso;
    this.status = status;
    this.causa = causa;
  }
}

function classificarCausaApi(status: number | null, texto: string): CausaErroApiLlm {
  const normalizado = texto.toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || normalizado.includes('credit') || normalizado.includes('quota') || normalizado.includes('balance')) return 'quota';
  if (status === 429 || normalizado.includes('rate limit')) return 'rate_limit';
  if (status === 408 || normalizado.includes('timeout') || normalizado.includes('timed out')) return 'timeout';
  if (status === 400 || status === 413 || status === 422) return 'bad_request';
  if (status === 404) return 'nao_encontrado';
  if (status === 529 || normalizado.includes('overload') || normalizado.includes('overloaded')) return 'overload';
  if (status !== null && status >= 500) return 'servidor';
  if (status === null) return 'rede';
  return 'desconhecida';
}

function descreverErroApi(erro: unknown): { mensagem: string; status: number | null; causa: CausaErroApiLlm } {
  const status =
    typeof erro === 'object' && erro !== null && 'status' in erro && typeof erro.status === 'number'
      ? erro.status
      : null;
  const texto = erro instanceof Error ? erro.message : String(erro);
  const causa = classificarCausaApi(status, texto);
  return { mensagem: `Falha na API da Anthropic${status ? ` (${status})` : ''}: ${texto.slice(0, 300)}`, status, causa };
}

function extrairUso(usage: Anthropic.Usage): Uso {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export class AnthropicLlm implements Llm {
  private readonly client: Pick<Anthropic, 'messages'>;

  constructor(client: Pick<Anthropic, 'messages'>) {
    this.client = client;
  }

  // Sempre em streaming: respostas longas (páginas HTML) estouram o timeout HTTP sem ele.
  async gerar<T>(pedido: PedidoLlm<T>): Promise<RespostaLlm<T>> {
    // Relógio monotônico: o de parede pode voltar durante a chamada, e agent_steps recusa duração negativa.
    const inicio = performance.now();

    let mensagem: Anthropic.Message;
    try {
      mensagem = await this.client.messages
        .stream({
          model: pedido.modelo,
          max_tokens: pedido.maxTokens,
          system: [{ type: 'text', text: pedido.sistema, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: pedido.usuario }],
          output_config: { format: zodOutputFormat(pedido.schema) },
        })
        .finalMessage();
    } catch (erro) {
      const { mensagem: texto, status, causa } = descreverErroApi(erro);
      throw new LlmError('api', texto, null, status, causa);
    }

    const uso = extrairUso(mensagem.usage);
    if (mensagem.stop_reason === 'refusal') throw new LlmError('recusa', 'O modelo recusou o pedido.', uso);
    if (mensagem.stop_reason === 'max_tokens') {
      throw new LlmError('truncado', 'A resposta foi cortada por max_tokens.', uso);
    }

    const texto = mensagem.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let json: unknown;
    try {
      json = JSON.parse(texto);
    } catch {
      throw new LlmError('invalido', 'A resposta do modelo não é JSON válido.', uso);
    }
    const validado = pedido.schema.safeParse(json);
    if (!validado.success) throw new LlmError('invalido', 'A resposta do modelo fugiu do esquema esperado.', uso);

    return { valor: validado.data, uso, modelo: pedido.modelo, duracaoMs: Math.round(performance.now() - inicio) };
  }
}
