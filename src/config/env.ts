import { z } from 'zod';

// Uma variável presente mas vazia (`CHAVE=`) conta como ausente.
const opcional = <T extends z.ZodType>(esquema: T) => z.preprocess((v) => (v === '' ? undefined : v), esquema.optional());

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'deve comecar com postgres:// ou postgresql://'),
  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-', 'deve comecar com sk-ant-').min(20, 'curta demais'),
  UI_PASSWORD: z.string().min(16, 'deve ter ao menos 16 caracteres'),
  PUBLIC_BASE_URL: z
    .string()
    .url('deve ser uma URL valida')
    .transform((u) => u.replace(/\/+$/, '')),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  UI_USER: z.string().min(1).default('frota'),
  CRON_PROCESSAR_FILA: z.string().min(1).default('*/10 * * * *'),
  MONTHLY_BUDGET_USD: z.coerce.number().positive('deve ser maior que zero').default(50),
  MAX_DEMANDAS_POR_RUN: z.coerce.number().int().min(1).max(10).default(3),
  MODEL_WORK: z.string().min(1).default('claude-sonnet-5'),
  MODEL_AUDIT: z.string().min(1).default('claude-sonnet-5'),
  // Maior que o prazo do job no agendador (60 min): uma run só é dada como morta depois de o job expirar.
  STALE_CLAIM_MINUTES: z.coerce.number().int().min(5).default(90),
  // Sem canal de e-mail configurado, os avisos ficam só no log do serviço.
  NOTIFY_CHANNEL: z.enum(['console', 'email']).default('console'),
  RESEND_API_KEY: opcional(z.string().min(10, 'curta demais')),
  NOTIFY_EMAIL_TO: opcional(z.email('deve ser um e-mail válido')),
  // O remetente de teste do Resend só entrega para o e-mail com que a conta foi criada.
  NOTIFY_EMAIL_FROM: z.string().min(3).default('Frota <onboarding@resend.dev>'),
}).superRefine((c, ctx) => {
  if (c.NOTIFY_CHANNEL !== 'email') return;
  for (const campo of ['RESEND_API_KEY', 'NOTIFY_EMAIL_TO'] as const) {
    if (!c[campo]) ctx.addIssue({ code: 'custom', path: [campo], message: 'obrigatória quando NOTIFY_CHANNEL=email' });
  }
});

export type Config = Readonly<z.infer<typeof schema>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// A mensagem cita so o nome da variavel e a regra violada, nunca o valor recebido.
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const resultado = schema.safeParse(env);
  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.code === 'invalid_type' ? 'ausente ou de tipo invalido' : i.message}`)
      .join('\n');
    throw new ConfigError(`Configuracao invalida:\n${problemas}`);
  }
  return Object.freeze(resultado.data);
}
