import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { ConfigError, loadConfig, type Config } from './config/env.ts';
import { migrate } from './db/migrate.ts';
import { createPool } from './db/pool.ts';
import { criarApp } from './http/app.ts';
import { AnthropicLlm } from './llm/llm.ts';
import { modeloConhecido } from './llm/models.ts';
import { LlmComOrcamento } from './llm/orcamento.ts';
import { criarNotificador } from './notify/fabrica.ts';
import { processarFila, type DependenciasFila } from './orchestrator/processar-fila.ts';
import { iniciarScheduler, type Scheduler } from './scheduler/scheduler.ts';
import { log, mensagemDeErro } from './util/log.ts';

function montarDependenciasDaFila(config: Config, pool: pg.Pool): DependenciasFila {
  const notificador = criarNotificador(config);
  const llm = new LlmComOrcamento({
    llm: new AnthropicLlm(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })),
    pool,
    orcamentoMensalUsd: config.MONTHLY_BUDGET_USD,
    notificador,
  });
  return {
    pool,
    llm,
    modeloTrabalho: config.MODEL_WORK,
    modeloAuditoria: config.MODEL_AUDIT,
    urlBase: config.PUBLIC_BASE_URL,
    notificador,
    maxDemandasPorRun: config.MAX_DEMANDAS_POR_RUN,
    minutosAbandono: config.STALE_CLAIM_MINUTES,
  };
}

function encerrarAoReceberSinal(encerrar: () => Promise<void>): void {
  let encerrando = false;
  const receber = (sinal: string): void => {
    if (encerrando) return;
    encerrando = true;
    log('info', 'encerrando', { sinal });
    void encerrar().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => receber('SIGTERM'));
  process.on('SIGINT', () => receber('SIGINT'));
}

async function main(): Promise<void> {
  const config = loadConfig();
  for (const modelo of [config.MODEL_WORK, config.MODEL_AUDIT]) {
    if (!modeloConhecido(modelo)) throw new ConfigError(`Modelo sem preço cadastrado: ${modelo}`);
  }

  const pool = createPool(config.DATABASE_URL);
  await migrate(pool);

  const depsFila = montarDependenciasDaFila(config, pool);
  const scheduler: Scheduler = await iniciarScheduler({
    connectionString: config.DATABASE_URL,
    cron: config.CRON_PROCESSAR_FILA,
    tarefa: async (gatilho) => {
      await processarFila(depsFila, gatilho);
    },
  });
  const app = await criarApp({
    pool,
    usuario: config.UI_USER,
    senha: config.UI_PASSWORD,
    disparar: () => scheduler.dispararAgora(),
  });
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  log('info', 'servico_iniciado', { porta: config.PORT, cron: config.CRON_PROCESSAR_FILA });

  encerrarAoReceberSinal(async () => {
    await app.close();
    await scheduler.parar();
    await pool.end();
  });
}

main().catch((erro) => {
  // ConfigError só cita nomes de variáveis, nunca valores: é seguro logar.
  log('erro', 'falha_no_boot', { erro: mensagemDeErro(erro) });
  process.exit(1);
});
