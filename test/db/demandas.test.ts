import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  atualizarDemanda,
  contarPorStatus,
  criarDemanda,
  devolverParaFila,
  existeDemandaNova,
  liberarDemandasAbandonadas,
  listarDemandas,
  obterDemanda,
  registrarTentativa,
  reivindicarDemandas,
} from '../../src/db/demandas.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('demandas', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas CASCADE');
  });

  async function criarComIdade(titulo: string, minutosAtras: number): Promise<string> {
    const d = await criarDemanda(db.pool, { titulo, categoria: 'd1' });
    await db.pool.query("UPDATE demandas SET criado_em = now() - make_interval(mins => $2::int) WHERE id = $1", [
      d.id,
      minutosAtras,
    ]);
    return d.id;
  }

  it('cria e le uma demanda com os campos mapeados para camelCase', async () => {
    const criada = await criarDemanda(db.pool, {
      titulo: 'Sistema de estoque',
      descricao: 'Painel 3D',
      categoria: 'd11',
      prioridade: 'HIGH',
      prazo: '2026-10-01',
      solicitante: 'Juliano',
      referencias: 'imagem anexa',
    });
    const lida = await obterDemanda(db.pool, criada.id);
    expect(lida).toMatchObject({
      titulo: 'Sistema de estoque',
      categoria: 'd11',
      prioridade: 'HIGH',
      prazo: '2026-10-01',
      solicitante: 'Juliano',
      status: 'Nova',
      entregaUrl: null,
      tentativas: 0,
      claimedByRun: null,
    });
    expect(new Date(lida!.criadoEm).toString()).not.toBe('Invalid Date');
  });

  it('devolve null para demanda inexistente', async () => {
    expect(await obterDemanda(db.pool, randomUUID())).toBeNull();
  });

  it('lista por status, da mais recente para a mais antiga', async () => {
    await criarComIdade('velha', 30);
    await criarComIdade('nova', 1);
    const [primeira, segunda] = await listarDemandas(db.pool, { status: 'Nova' });
    expect([primeira?.titulo, segunda?.titulo]).toEqual(['nova', 'velha']);
    expect(await listarDemandas(db.pool, { status: 'Concluída' })).toEqual([]);
  });

  it('informa se existe demanda Nova e conta por status', async () => {
    expect(await existeDemandaNova(db.pool)).toBe(false);
    await criarDemanda(db.pool, { titulo: 'a', categoria: 'd1' });
    expect(await existeDemandaNova(db.pool)).toBe(true);
    expect(await contarPorStatus(db.pool)).toEqual({ Nova: 1 });
  });

  it('reivindica as mais antigas primeiro, no maximo o limite, e marca Em andamento', async () => {
    const ids = [
      await criarComIdade('c', 10),
      await criarComIdade('a', 50),
      await criarComIdade('e', 1),
      await criarComIdade('b', 30),
      await criarComIdade('d', 5),
    ];
    const run = randomUUID();
    const pegas = await reivindicarDemandas(db.pool, run, 3);

    expect(pegas.map((d) => d.titulo)).toEqual(['a', 'b', 'c']);
    for (const d of pegas) {
      expect(d.status).toBe('Em andamento');
      expect(d.tentativas).toBe(0);
      expect(d.claimedByRun).toBe(run);
      expect(d.claimedAt).not.toBeNull();
    }
    const restantes = await Promise.all(ids.map((id) => obterDemanda(db.pool, id)));
    expect(restantes.filter((d) => d?.status === 'Nova')).toHaveLength(2);
  });

  it('devolve lista vazia quando nao ha demandas Nova', async () => {
    expect(await reivindicarDemandas(db.pool, randomUUID(), 3)).toEqual([]);
  });

  it('nunca entrega a mesma demanda a duas execucoes concorrentes', async () => {
    for (let i = 0; i < 12; i++) await criarDemanda(db.pool, { titulo: `d${i}`, categoria: 'd1' });

    const resultados = await Promise.all(
      Array.from({ length: 6 }, () => reivindicarDemandas(db.pool, randomUUID(), 3)),
    );
    const ids = resultados.flat().map((d) => d.id);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('libera demandas abandonadas: volta para Nova ou vira Falhou apos o limite de tentativas', async () => {
    const d1 = await criarDemanda(db.pool, { titulo: 'recuperavel', categoria: 'd1' });
    const d2 = await criarDemanda(db.pool, { titulo: 'sem-chance', categoria: 'd1' });
    const d3 = await criarDemanda(db.pool, { titulo: 'recente', categoria: 'd1' });
    await db.pool.query(
      `UPDATE demandas SET status = 'Em andamento', claimed_at = now() - interval '120 minutes', tentativas = $2
        WHERE id = $1`,
      [d1.id, 1],
    );
    await db.pool.query(
      `UPDATE demandas SET status = 'Em andamento', claimed_at = now() - interval '120 minutes', tentativas = $2
        WHERE id = $1`,
      [d2.id, 3],
    );
    await db.pool.query(
      "UPDATE demandas SET status = 'Em andamento', claimed_at = now() - interval '1 minute', tentativas = 1 WHERE id = $1",
      [d3.id],
    );

    const liberadas = await liberarDemandasAbandonadas(db.pool, 60);

    expect(liberadas.map((l) => l.status).sort()).toEqual(['Falhou', 'Nova']);
    expect((await obterDemanda(db.pool, d1.id))?.status).toBe('Nova');
    expect((await obterDemanda(db.pool, d1.id))?.claimedAt).toBeNull();
    expect((await obterDemanda(db.pool, d2.id))?.status).toBe('Falhou');
    expect((await obterDemanda(db.pool, d3.id))?.status).toBe('Em andamento');
  });

  it('atualiza status e entrega, e solta a reivindicacao ao sair de Em andamento', async () => {
    await criarDemanda(db.pool, { titulo: 'x', categoria: 'd1' });
    const [pega] = await reivindicarDemandas(db.pool, randomUUID(), 1);

    const atualizada = await atualizarDemanda(db.pool, pega!.id, {
      status: 'Concluída',
      entregaUrl: 'https://frota.exemplo.com/entregas/abc',
    });

    expect(atualizada).toMatchObject({
      status: 'Concluída',
      entregaUrl: 'https://frota.exemplo.com/entregas/abc',
      claimedByRun: null,
      claimedAt: null,
    });
  });

  it('grava alternativa de insumo e bloqueio humano como JSON sem tocar nos outros campos', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'y', categoria: 'd1', prioridade: 'LOW' });
    const atualizada = await atualizarDemanda(db.pool, d.id, {
      status: 'Aguardando humano',
      alternativaInsumo: 'B',
      bloqueioHumano: { motivo: 'exige pagamento', acaoNecessaria: ['aprovar'] },
    });
    expect(atualizada).toMatchObject({
      prioridade: 'LOW',
      status: 'Aguardando humano',
      alternativaInsumo: 'B',
      bloqueioHumano: { motivo: 'exige pagamento', acaoNecessaria: ['aprovar'] },
    });
  });

  it('atualizar sem campos devolve a demanda como esta; id inexistente devolve null', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'z', categoria: 'd1' });
    expect((await atualizarDemanda(db.pool, d.id, {}))?.titulo).toBe('z');
    expect(await atualizarDemanda(db.pool, randomUUID(), { status: 'Arquivada' })).toBeNull();
  });

  it('conta a tentativa so quando o trabalho comeca, e nao ao reivindicar o lote', async () => {
    await criarDemanda(db.pool, { titulo: 'w', categoria: 'd1' });
    const [pega] = await reivindicarDemandas(db.pool, randomUUID(), 1);
    expect(pega!.tentativas).toBe(0);

    await registrarTentativa(db.pool, pega!.id);

    expect((await obterDemanda(db.pool, pega!.id))?.tentativas).toBe(1);
  });

  it('devolve para a fila desfazendo a tentativa de quem ja tinha comecado', async () => {
    await criarDemanda(db.pool, { titulo: 'iniciada', categoria: 'd1' });
    const [pega] = await reivindicarDemandas(db.pool, randomUUID(), 1);
    await registrarTentativa(db.pool, pega!.id);

    await devolverParaFila(db.pool, pega!.id, true);

    expect(await obterDemanda(db.pool, pega!.id)).toMatchObject({ status: 'Nova', tentativas: 0, claimedByRun: null });
  });

  it('devolve para a fila sem tocar nas tentativas de quem nunca comecou', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'nao-iniciada', categoria: 'd1' });
    await db.pool.query('UPDATE demandas SET tentativas = 2 WHERE id = $1', [d.id]);
    const [pega] = await reivindicarDemandas(db.pool, randomUUID(), 1);

    await devolverParaFila(db.pool, pega!.id);

    expect(await obterDemanda(db.pool, d.id)).toMatchObject({ status: 'Nova', tentativas: 2 });
  });

  it('uma demanda reivindicada e nunca iniciada nao chega a Falhou pelo vigia', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'lote-perdido', categoria: 'd1' });
    await db.pool.query('UPDATE demandas SET tentativas = 2 WHERE id = $1', [d.id]);
    await reivindicarDemandas(db.pool, randomUUID(), 1);
    await db.pool.query("UPDATE demandas SET claimed_at = now() - interval '3 hours' WHERE id = $1", [d.id]);

    await liberarDemandasAbandonadas(db.pool, 60);

    expect(await obterDemanda(db.pool, d.id)).toMatchObject({ status: 'Nova', tentativas: 2 });
  });
});
