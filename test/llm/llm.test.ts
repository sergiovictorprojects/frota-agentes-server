import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicLlm, LlmError, type PedidoLlm } from '../../src/llm/llm.ts';

const schema = z.object({ resposta: z.string(), nota: z.number().int() });

function clienteFalso(resultado: unknown) {
  const chamadas: Record<string, unknown>[] = [];
  const client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        chamadas.push(params);
        return {
          finalMessage: async () => {
            if (resultado instanceof Error) throw resultado;
            return resultado;
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, chamadas };
}

const mensagem = (sobrescrever: Record<string, unknown> = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ resposta: 'ok', nota: 9 }) }],
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 },
  ...sobrescrever,
});

const pedido: PedidoLlm<z.infer<typeof schema>> = {
  modelo: 'claude-sonnet-5',
  papel: 'frota:architect',
  sistema: 'SISTEMA',
  usuario: 'USUARIO',
  schema,
  maxTokens: 1000,
};

async function falha(resultado: unknown): Promise<LlmError> {
  const { client } = clienteFalso(resultado);
  try {
    await new AnthropicLlm(client).gerar(pedido);
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    return e as LlmError;
  }
  throw new Error('deveria ter falhado');
}

describe('AnthropicLlm', () => {
  it('devolve o valor validado e mapeia o uso, inclusive os tokens de cache', async () => {
    const { client } = clienteFalso(mensagem());
    const r = await new AnthropicLlm(client).gerar(pedido);
    expect(r.valor).toEqual({ resposta: 'ok', nota: 9 });
    expect(r.uso).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 200 });
    expect(r.modelo).toBe('claude-sonnet-5');
  });

  it('envia modelo, limite, sistema com cache e formato estruturado', async () => {
    const { client, chamadas } = clienteFalso(mensagem());
    await new AnthropicLlm(client).gerar(pedido);
    const enviado = chamadas[0]!;
    expect(enviado.model).toBe('claude-sonnet-5');
    expect(enviado.max_tokens).toBe(1000);
    expect(enviado.system).toEqual([{ type: 'text', text: 'SISTEMA', cache_control: { type: 'ephemeral' } }]);
    expect(enviado.messages).toEqual([{ role: 'user', content: 'USUARIO' }]);
    expect((enviado.output_config as { format?: unknown }).format).toBeDefined();
  });

  it('trata tokens de cache ausentes como zero', async () => {
    const { client } = clienteFalso(
      mensagem({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null } }),
    );
    const r = await new AnthropicLlm(client).gerar(pedido);
    expect(r.uso).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('junta blocos de texto e ignora blocos de raciocinio', async () => {
    const metade = JSON.stringify({ resposta: 'ok', nota: 3 });
    const { client } = clienteFalso(
      mensagem({
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: metade.slice(0, 10) },
          { type: 'text', text: metade.slice(10) },
        ],
      }),
    );
    expect((await new AnthropicLlm(client).gerar(pedido)).valor).toEqual({ resposta: 'ok', nota: 3 });
  });

  it('classifica recusa, mantendo o uso ja consumido', async () => {
    const erro = await falha(mensagem({ stop_reason: 'refusal' }));
    expect(erro.tipo).toBe('recusa');
    expect(erro.uso?.outputTokens).toBe(40);
  });

  it('classifica resposta cortada por max_tokens', async () => {
    const erro = await falha(mensagem({ stop_reason: 'max_tokens' }));
    expect(erro.tipo).toBe('truncado');
    expect(erro.uso).not.toBeNull();
  });

  it('classifica texto que nao e JSON', async () => {
    const erro = await falha(mensagem({ content: [{ type: 'text', text: 'ola, isto nao e json' }] }));
    expect(erro.tipo).toBe('invalido');
    expect(erro.uso).not.toBeNull();
  });

  it('classifica JSON fora do esquema', async () => {
    const erro = await falha(mensagem({ content: [{ type: 'text', text: JSON.stringify({ resposta: 1 }) }] }));
    expect(erro.tipo).toBe('invalido');
  });

  it('classifica falha de API com o status HTTP, sem uso a contabilizar', async () => {
    const erro = await falha(Object.assign(new Error('overloaded'), { status: 529 }));
    expect(erro.tipo).toBe('api');
    expect(erro.status).toBe(529);
    expect(erro.uso).toBeNull();
    expect(erro.message).toContain('529');
  });

  it('classifica falha de API sem status', async () => {
    const erro = await falha(new Error('socket hang up'));
    expect(erro).toMatchObject({ tipo: 'api', status: null });
  });
});
