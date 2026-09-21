import { z } from 'zod';

const setorEnvolvido = z.enum([
  'd1',
  'd2',
  'd3',
  'd4',
  'd5',
  'd6',
  'd7',
  'd8',
  'd9',
  'd10',
  'd11',
  'd12',
  'd13',
  'd14',
  'd15',
  'd16',
  'd17',
  'd18',
]);

// Os limites de tamanho são folgados de propósito: a API da Anthropic não os aplica (a SDK só os
// escreve na descrição do campo) e uma violação aqui jogaria fora uma execução já paga.
export const ResultadoExecucaoSchema = z.object({
  plano: z.string().min(1).max(2000),
  nivelComplexidade: z.number().int().min(1).max(4),
  setoresEnvolvidos: z.array(setorEnvolvido).max(18),
  acaoHumana: z
    .object({
      motivo: z.string().min(1).max(2000),
      acoesNecessarias: z.array(z.string().max(1000)).max(20),
    })
    .nullable(),
  insumoCritico: z
    .object({
      descricao: z.string().min(1).max(2000),
      alternativa: z.enum(['A', 'B', 'C']),
    })
    .nullable(),
  entrega: z
    .object({
      tipo: z.enum(['html', 'texto']),
      titulo: z.string().min(1).max(300),
      // Cabe no limite de auditoria: o auditor precisa ver a entrega inteira, senão o que passar do corte nunca é conferido.
      conteudo: z.string().min(1).max(120_000),
    })
    .nullable(),
  resumo: z.string().min(1).max(4000),
  fontesUtilizadas: z.string().max(3000),
  autoavaliacao: z.number().int().min(0).max(100),
  ganhos: z.string().max(8000),
  perdas: z.string().max(8000),
  aprendizado: z.string().max(8000),
  ponderacoes: z.array(z.object({ setor: z.string().max(200), nota: z.string().max(2000) })).max(20),
});
export type ResultadoExecucao = z.infer<typeof ResultadoExecucaoSchema>;

export const AuditoriaSchema = z.object({
  violacoes: z
    .array(
      z.object({
        regra: z.string().max(1000),
        evidencia: z.string().max(2000),
        gravidade: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      }),
    )
    .max(50),
  observacoes: z.string().max(4000),
});
export type ResultadoAuditoriaBruto = z.infer<typeof AuditoriaSchema>;
