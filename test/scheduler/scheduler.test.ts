import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { iniciarScheduler, type Gatilho, type Scheduler } from '../../src/scheduler/scheduler.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { esperar } from '../helpers/fakes.ts';

// Cron no futuro distante: o teste dispara as execucoes manualmente.
const CRON_INATIVO = '0 3 1 1 *';

describe('iniciarScheduler', () => {
  let db: TestDb;
  const abertos: Scheduler[] = [];

  beforeAll(async () => {
    db = await createTestDb();
  });
  // Um agendador por teste: se o anterior seguisse vivo, o worker dele pegaria os jobs do proximo.
  afterEach(async () => {
    for (const s of abertos.splice(0)) await s.parar();
  });
  afterAll(async () => {
    await db.drop();
  });

  async function iniciar(tarefa: (gatilho: Gatilho) => Promise<void>): Promise<Scheduler> {
    const s = await iniciarScheduler({
      connectionString: db.url,
      cron: CRON_INATIVO,
      tarefa,
      pollingIntervalSeconds: 0.5,
    });
    abertos.push(s);
    return s;
  }

  it('executa a tarefa quando um disparo entra na fila, identificando o gatilho como manual', async () => {
    const gatilhos: Gatilho[] = [];
    const s = await iniciar(async (gatilho) => {
      gatilhos.push(gatilho);
    });

    expect(await s.dispararAgora()).toBe(true);

    await esperar(() => gatilhos.length === 1, 20_000);
    expect(gatilhos).toEqual(['manual']);
  });

  it('descarta um disparo novo enquanto ha um na fila ou em andamento, e volta a aceitar depois', async () => {
    let iniciou = false;
    let chamadas = 0;
    let liberar: () => void = () => {};
    const bloqueio = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    const s = await iniciar(async () => {
      chamadas++;
      iniciou = true;
      if (chamadas === 1) await bloqueio;
    });

    expect(await s.dispararAgora()).toBe(true);
    expect(await s.dispararAgora()).toBe(false);
    await esperar(() => iniciou, 20_000);
    expect(await s.dispararAgora()).toBe(false);

    liberar();
    await esperar(() => chamadas === 1, 20_000);
    await esperar(async () => s.dispararAgora(), 20_000);
    await esperar(() => chamadas === 2, 20_000);
    expect(chamadas).toBe(2);
  });

  it('mantem o servico de pe quando a tarefa lanca erro', async () => {
    let chamadas = 0;
    const s = await iniciar(async () => {
      chamadas++;
      if (chamadas === 1) throw new Error('falha simulada');
    });
    await esperar(async () => s.dispararAgora(), 20_000);
    await esperar(() => chamadas >= 1, 20_000);
    await esperar(async () => s.dispararAgora(), 20_000);
    await esperar(() => chamadas >= 2, 20_000);
    expect(chamadas).toBeGreaterThanOrEqual(2);
  });
});
