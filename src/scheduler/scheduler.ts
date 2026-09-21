import { PgBoss } from 'pg-boss';
import { log, mensagemDeErro } from '../util/log.ts';

const FILA = 'processar-fila';
const EXPIRA_EM_SEGUNDOS = 60 * 60;
// O worker envia batimentos sozinho. Se o processo morrer sem avisar (falta de memória, kill -9), o job
// é dado como falho em cerca de um minuto, em vez de segurar a fila "exclusive" pela hora inteira.
const HEARTBEAT_SEGUNDOS = 60;
const ESPERA_ENCERRAMENTO_MS = 30_000;

export type Gatilho = 'cron' | 'manual';

export interface OpcoesScheduler {
  connectionString: string;
  cron: string;
  tarefa: (gatilho: Gatilho) => Promise<void>;
  pollingIntervalSeconds?: number;
}

export interface Scheduler {
  // Devolve false quando já existe uma execução na fila ou em andamento (política exclusive).
  dispararAgora(): Promise<boolean>;
  parar(): Promise<void>;
}

// O relógio vive dentro do próprio serviço, guardado no Postgres: não depende do computador de ninguém.
// A política "exclusive" descarta um disparo novo enquanto o anterior ainda roda, então nunca há
// duas execuções sobrepostas nem fila acumulada.
export async function iniciarScheduler(o: OpcoesScheduler): Promise<Scheduler> {
  const boss = new PgBoss(o.connectionString);
  boss.on('error', (erro) => log('erro', 'erro_pgboss', { erro: mensagemDeErro(erro) }));
  await boss.start();
  // createQueue não altera uma fila que já existe: mudar estas opções depois exige recriar a fila.
  await boss.createQueue(FILA, {
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: EXPIRA_EM_SEGUNDOS,
    heartbeatSeconds: HEARTBEAT_SEGUNDOS,
  });
  await boss.schedule(FILA, o.cron);
  await boss.work<{ gatilho?: Gatilho } | null>(FILA, { pollingIntervalSeconds: o.pollingIntervalSeconds ?? 10 }, async (jobs) => {
    const gatilho: Gatilho = jobs.some((j) => j.data?.gatilho === 'manual') ? 'manual' : 'cron';
    try {
      await o.tarefa(gatilho);
    } catch (erro) {
      log('erro', 'erro_run', { erro: mensagemDeErro(erro) });
      throw erro;
    }
  });

  return {
    async dispararAgora() {
      return (await boss.send(FILA, { gatilho: 'manual' })) !== null;
    },
    async parar() {
      await boss.stop({ graceful: true, timeout: ESPERA_ENCERRAMENTO_MS });
    },
  };
}
