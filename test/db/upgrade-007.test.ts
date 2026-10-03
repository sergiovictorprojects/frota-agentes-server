import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { obterAgentePorChave } from '../../src/db/agentes.ts';
import { migrate } from '../../src/db/migrate.ts';
import { criarEntrega } from '../../src/db/relatorios.ts';
import { SETORES } from '../../src/domain/setores.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('upgrade 006 → 010', () => {
  let db: TestDb;
  let demandaId: string;
  let entregaId: string;
  let aplicadas: string[];

  beforeAll(async () => {
    db = await createTestDb({ ate: '006_execucao_tarefas.sql' });
    const { rows } = await db.pool.query<{ id: string }>(
      "INSERT INTO demandas (titulo, categoria) VALUES ('Existente antes da 007', 'd11') RETURNING id",
    );
    demandaId = rows[0]!.id;
    entregaId = (await criarEntrega(db.pool, { demandaId, titulo: 'Entrega antiga', conteudo: '<p>preservada</p>' })).id;
    aplicadas = await migrate(db.pool);
  });
  afterAll(async () => db.drop());

  it('aplica 007, 008, 009 e 010 e preserva as linhas existentes', async () => {
    expect(aplicadas).toEqual([
      '007_artefatos_entregaveis.sql',
      '008_demanda_especificacao_extensa.sql',
      '009_resultado_esperado_demanda.sql',
      '010_estimativa_uso_demanda.sql',
    ]);
    expect((await db.pool.query('SELECT id FROM demandas WHERE id = $1', [demandaId])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT id FROM entregas WHERE id = $1', [entregaId])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT 1 FROM artefatos_entregaveis')).rowCount).toBe(0);
    expect((await db.pool.query('SELECT resultado_esperado, criterios_aceite FROM demandas WHERE id = $1', [demandaId])).rows[0]).toEqual({
      resultado_esperado: 'outro',
      criterios_aceite: '',
    });
    expect((await db.pool.query('SELECT complexidade, estimativa_uso FROM demandas WHERE id = $1', [demandaId])).rows[0]).toEqual({
      complexidade: 'MEDIUM',
      estimativa_uso: {},
    });
  });

  it('eleva os limites de especificação no banco', async () => {
    await expect(
      db.pool.query("UPDATE demandas SET descricao = $1, referencias = $2 WHERE id = $3", ['a'.repeat(100_000), 'b'.repeat(20_000), demandaId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(db.pool.query("UPDATE demandas SET descricao = $1 WHERE id = $2", ['a'.repeat(100_001), demandaId])).rejects.toThrow(
      /demandas_descricao_check/,
    );
    await expect(db.pool.query("UPDATE demandas SET referencias = $1 WHERE id = $2", ['b'.repeat(20_001), demandaId])).rejects.toThrow(
      /demandas_referencias_check/,
    );
  });

  it('preenche e versiona as capacidades dos agentes já existentes', async () => {
    const design = (await obterAgentePorChave(db.pool, SETORES.d11.papel))!;
    const auditor = (await obterAgentePorChave(db.pool, SETORES.d17.papel))!;
    expect(design.versao).toBe(2);
    expect(design.capacidades.gerarArtefatos).toEqual(['pdf', 'pptx', 'html', 'svg', 'zip']);
    expect(auditor.capacidades.gerarArtefatos).toEqual([]);

    const { rows } = await db.pool.query<{ ator: string; campos_alterados: Record<string, unknown> }>(
      'SELECT ator, campos_alterados FROM agentes_historico WHERE agente_id = $1',
      [design.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ator).toBe('sistema:migration_007');
    expect(rows[0]!.campos_alterados).toHaveProperty('gerarArtefatos');
  });

  it('é idempotente', async () => {
    expect(await migrate(db.pool)).toEqual([]);
  });

  it('valida resultado esperado e limite de critérios de aceite no banco', async () => {
    await expect(
      db.pool.query("UPDATE demandas SET resultado_esperado = 'interface', criterios_aceite = $1 WHERE id = $2", [
        'Deve entregar HTML interativo.',
        demandaId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(db.pool.query("UPDATE demandas SET resultado_esperado = 'powerpoint' WHERE id = $1", [demandaId])).rejects.toThrow(
      /demandas_resultado_esperado_check/,
    );
    await expect(db.pool.query('UPDATE demandas SET criterios_aceite = $1 WHERE id = $2', ['a'.repeat(10_001), demandaId])).rejects.toThrow(
      /demandas_criterios_aceite_check/,
    );
  });
});
