import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from 'vitest';
import { AuditoriaSchema, ResultadoExecucaoSchema } from '../../src/orchestrator/schemas.ts';

const execucaoValida = {
  plano: 'Entregar análise',
  nivelComplexidade: 2,
  setoresEnvolvidos: ['d1'],
  acaoHumana: null,
  insumoCritico: null,
  entrega: { tipo: 'texto', titulo: 'Análise', conteudo: 'Conteúdo' },
  resumo: 'Feito',
  fontesUtilizadas: 'briefing',
  autoavaliacao: 80,
  ganhos: 'g',
  perdas: 'p',
  aprendizado: 'a',
  ponderacoes: [],
};

// Estes testes existem porque zodOutputFormat só falha em tempo de execução: um esquema que ele não
// consiga converter para JSON Schema quebraria toda chamada real ao modelo e nenhum teste com o
// modelo falso perceberia.
describe('esquemas de saida estruturada', () => {
  it.each([
    ['execucao', ResultadoExecucaoSchema],
    ['auditoria', AuditoriaSchema],
  ] as const)('o esquema de %s converte para JSON Schema aceito pela API', (_nome, schema) => {
    const formato = zodOutputFormat(schema);
    const js = formato.schema as { type?: string; additionalProperties?: boolean; required?: string[] };
    expect(js.type).toBe('object');
    expect(js.additionalProperties).toBe(false);
    expect((js.required ?? []).length).toBeGreaterThan(0);
  });

  it('exige todos os campos da execucao e aceita campos anulaveis como obrigatorios com valor nulo', () => {
    const js = zodOutputFormat(ResultadoExecucaoSchema).schema as { required: string[] };
    for (const campo of ['plano', 'acaoHumana', 'insumoCritico', 'entrega', 'autoavaliacao', 'ponderacoes']) {
      expect(js.required).toContain(campo);
    }
  });

  it('aceita uma execucao valida e rejeita nivel de complexidade fora de 1 a 4', () => {
    expect(ResultadoExecucaoSchema.safeParse(execucaoValida).success).toBe(true);
    expect(ResultadoExecucaoSchema.safeParse({ ...execucaoValida, nivelComplexidade: 5 }).success).toBe(false);
  });

  it('rejeita setor inexistente e alternativa de insumo desconhecida', () => {
    expect(ResultadoExecucaoSchema.safeParse({ ...execucaoValida, setoresEnvolvidos: ['d99'] }).success).toBe(false);
    expect(
      ResultadoExecucaoSchema.safeParse({ ...execucaoValida, insumoCritico: { descricao: 'x', alternativa: 'Z' } }).success,
    ).toBe(false);
  });

  it('tolera textos longos o bastante para nao descartar uma execucao paga por poucos caracteres', () => {
    const r = ResultadoExecucaoSchema.safeParse({ ...execucaoValida, plano: 'p'.repeat(1500), resumo: 'r'.repeat(3500) });
    expect(r.success).toBe(true);
  });

  it('aceita uma auditoria sem violacoes e uma com violacoes', () => {
    expect(AuditoriaSchema.safeParse({ violacoes: [], observacoes: '' }).success).toBe(true);
    expect(
      AuditoriaSchema.safeParse({ violacoes: [{ regra: 'r', evidencia: 'e', gravidade: 'HIGH' }], observacoes: 'x' }).success,
    ).toBe(true);
    expect(
      AuditoriaSchema.safeParse({ violacoes: [{ regra: 'r', evidencia: 'e', gravidade: 'ENORME' }], observacoes: '' }).success,
    ).toBe(false);
  });
});
