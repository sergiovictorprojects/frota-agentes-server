import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listarMigracoesDisponiveis, migrate } from '../../src/db/migrate.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('migrate', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('cria todas as tabelas do esquema', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const nomes = rows.map((r) => r.table_name);
    for (const t of [
      'agent_steps',
      'aprendizado_evolucao',
      'demandas',
      'entregas',
      'mensagens',
      'relatorios',
      'runs',
      'schema_migrations',
      'system_flags',
    ]) {
      expect(nomes).toContain(t);
    }
  });

  it('e idempotente: uma segunda execucao nao aplica nada', async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it('registra as migracoes aplicadas', async () => {
    const { rows } = await db.pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(await listarMigracoesDisponiveis());
  });

  it('cria demandas com status Nova e prioridade MEDIUM por padrao', async () => {
    const { rows } = await db.pool.query(
      "INSERT INTO demandas (titulo, categoria) VALUES ('Teste', 'd1') RETURNING status, prioridade, tentativas",
    );
    expect(rows[0]).toEqual({ status: 'Nova', prioridade: 'MEDIUM', tentativas: 0 });
  });

  it('rejeita categoria, prioridade e status fora do dominio', async () => {
    await expect(db.pool.query("INSERT INTO demandas (titulo, categoria) VALUES ('x', 'd99')")).rejects.toThrow();
    await expect(
      db.pool.query("INSERT INTO demandas (titulo, categoria, prioridade) VALUES ('x', 'd1', 'URGENT')"),
    ).rejects.toThrow();
    await expect(
      db.pool.query("INSERT INTO demandas (titulo, categoria, status) VALUES ('x', 'd1', 'Inexistente')"),
    ).rejects.toThrow();
  });

  it('aceita texto Unicode fora do Latin-1 (banco em UTF-8)', async () => {
    const { rows } = await db.pool.query<{ titulo: string }>(
      "INSERT INTO demandas (titulo, categoria) VALUES ('Painel 📦 → ✓ ção', 'd1') RETURNING titulo",
    );
    expect(rows[0]?.titulo).toBe('Painel 📦 → ✓ ção');
  });

  it('mantem system_flags como linha unica, inicialmente sem pausa', async () => {
    const { rows } = await db.pool.query('SELECT pausado, pausado_motivo FROM system_flags');
    expect(rows).toEqual([{ pausado: false, pausado_motivo: null }]);
    await expect(db.pool.query('INSERT INTO system_flags (id) VALUES (2)')).rejects.toThrow();
  });

  it('apaga mensagens e entregas junto com a demanda (cascade)', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      "INSERT INTO demandas (titulo, categoria) VALUES ('Cascata', 'd1') RETURNING id",
    );
    const id = rows[0]!.id;
    await db.pool.query("INSERT INTO mensagens (demanda_id, autor, texto) VALUES ($1, 'agente', 'oi')", [id]);
    await db.pool.query("INSERT INTO entregas (demanda_id, titulo, conteudo) VALUES ($1, 't', '<p>x</p>')", [id]);
    await db.pool.query('DELETE FROM demandas WHERE id = $1', [id]);
    const m = await db.pool.query('SELECT 1 FROM mensagens WHERE demanda_id = $1', [id]);
    const e = await db.pool.query('SELECT 1 FROM entregas WHERE demanda_id = $1', [id]);
    expect(m.rowCount).toBe(0);
    expect(e.rowCount).toBe(0);
  });
});

describe('migrate concorrente', () => {
  it('dois processos migrando o mesmo banco aplicam cada migracao uma unica vez', async () => {
    const raw = await createTestDb({ migrar: false });
    try {
      const total = (await listarMigracoesDisponiveis()).length;
      const [a, b] = await Promise.all([migrate(raw.pool), migrate(raw.pool)]);
      expect([a.length, b.length].sort((x, y) => x - y)).toEqual([0, total]);
    } finally {
      await raw.drop();
    }
  });
});
