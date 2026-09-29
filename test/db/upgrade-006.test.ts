import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarDemanda } from '../../src/db/demandas.ts';
import { listarEventosDaDemanda } from '../../src/db/eventos.ts';
import { migrate } from '../../src/db/migrate.ts';
import { gastoDoMes, iniciarRun, registrarPasso } from '../../src/db/operacao.ts';
import { criarEnvelope, situacaoDeCusto } from '../../src/db/orquestracao.ts';
import { listarPlanosDaDemanda, registrarPlanoShadow, validarPlano, type TarefaPlanejada } from '../../src/db/planos.ts';
import { listarAvaliacoesDaDemanda } from '../../src/db/politicas.ts';
import { ativarPlano } from '../../src/db/tarefas.ts';
import { comTransacao } from '../../src/db/tx.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { registrarPlanoDeTeste } from '../helpers/execucao.ts';

// Upgrade de um banco parado na 005, com dados gravados pelo código da Fase 3.1, para a 006. O SQL abaixo é
// literal do código da 3.1 (ed8cdad): é o que existe em produção antes do deploy desta entrega e o que volta
// a rodar se o código for revertido com a 006 já aplicada.

async function proximaVersao31(c: pg.PoolClient, demandaId: string): Promise<number> {
  await c.query('SELECT id FROM demandas WHERE id = $1 FOR UPDATE', [demandaId]);
  const { rows } = await c.query<{ prox: number }>('SELECT COALESCE(MAX(versao), 0) + 1 AS prox FROM planos_demanda WHERE demanda_id = $1', [
    demandaId,
  ]);
  return rows[0]!.prox;
}

async function planoShadow31(pool: pg.Pool, demandaId: string, runId: string, tarefas: readonly TarefaPlanejada[]): Promise<string> {
  return comTransacao(pool, async (c) => {
    const versao = await proximaVersao31(c, demandaId);
    const { rows: planoRows } = await c.query<{ id: string }>(
      `INSERT INTO planos_demanda (demanda_id, versao, criado_pela_run_id, modo, estado)
       VALUES ($1, $2, $3, 'shadow', 'registrado') RETURNING id`,
      [demandaId, versao, runId],
    );
    const planoId = planoRows[0]!.id;
    const ids = new Map<string, string>();
    for (const t of tarefas) {
      const { rows } = await c.query<{ id: string }>('INSERT INTO tarefas (plano_id, chave, tipo, capacidade) VALUES ($1, $2, $3, $4) RETURNING id', [
        planoId,
        t.chave,
        t.tipo,
        t.capacidade,
      ]);
      ids.set(t.chave, rows[0]!.id);
    }
    for (const t of tarefas) {
      for (const dep of t.dependeDe) {
        await c.query('INSERT INTO tarefas_dependencias (tarefa_id, depende_de_id) VALUES ($1, $2)', [ids.get(t.chave), ids.get(dep)]);
      }
    }
    return planoId;
  });
}

async function planoRejeitado31(pool: pg.Pool, demandaId: string, runId: string, motivo: string): Promise<string> {
  return comTransacao(pool, async (c) => {
    const versao = await proximaVersao31(c, demandaId);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO planos_demanda (demanda_id, versao, criado_pela_run_id, modo, estado, motivo_rejeicao)
       VALUES ($1, $2, $3, 'shadow', 'rejeitado', $4) RETURNING id`,
      [demandaId, versao, runId, motivo],
    );
    return rows[0]!.id;
  });
}

function tarefasValidas(): TarefaPlanejada[] {
  const v = validarPlano({
    tarefas: [
      { chave: 'dados', capacidade: 'd1', dependeDe: [] },
      { chave: 'api', capacidade: 'd2', dependeDe: ['dados'] },
    ],
  });
  if (!v.valido) throw new Error('plano de teste invalido');
  return v.tarefas;
}

const TABELAS = [
  'demandas',
  'runs',
  'agentes',
  'planos_demanda',
  'tarefas',
  'tarefas_dependencias',
  'agent_steps',
  'avaliacoes_politica',
  'agent_events',
] as const;

async function colunasDe(pool: pg.Pool, tabela: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [tabela],
  );
  return rows.map((l) => l.column_name);
}

// Todas as linhas de cada tabela, só com as colunas que existiam antes da 006, em ordem estável.
async function fotografar(pool: pg.Pool, colunas: Record<string, string[]>): Promise<Record<string, unknown[]>> {
  const foto: Record<string, unknown[]> = {};
  for (const [tabela, cols] of Object.entries(colunas)) {
    const lista = cols.map((c) => `"${c}"`).join(', ');
    foto[tabela] = (await pool.query(`SELECT ${lista} FROM ${tabela} ORDER BY ${lista}`)).rows;
  }
  return foto;
}

describe('upgrade 005 → 006 com dados shadow existentes', () => {
  let db: TestDb;
  let demandaId: string;
  let runId: string;
  let planoId: string;
  let colunasAntes: Record<string, string[]>;
  let fotoAntes: Record<string, unknown[]>;
  let fotoDepois: Record<string, unknown[]>;
  let colunasNovas: Record<string, unknown[]>;
  let aplicadas: string[];

  beforeAll(async () => {
    db = await createTestDb({ ate: '005_planos_tarefas.sql' });
    const { rows: migradas } = await db.pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(migradas.map((l) => l.name).at(-1)).toBe('005_planos_tarefas.sql');

    demandaId = (await criarDemanda(db.pool, { titulo: 'Demanda da Fase 3.1', categoria: 'd1' })).id;
    runId = await iniciarRun(db.pool);
    planoId = await planoShadow31(db.pool, demandaId, runId, tarefasValidas());
    await planoRejeitado31(db.pool, demandaId, runId, 'ciclo');
    for (const custoUsd of [0.123456, 0.2]) {
      await registrarPasso(db.pool, {
        runId,
        demandaId,
        papel: 'frota:architect',
        modelo: 'claude-sonnet-5',
        tokensIn: 100,
        tokensOut: 10,
        cacheRead: 0,
        cacheWrite: 0,
        custoUsd,
        duracaoMs: 50,
      });
    }
    await db.pool.query(
      `INSERT INTO avaliacoes_politica (demanda_id, run_id, regra_id, politica_id, estagio, decisao, contexto, versao_regra)
       VALUES ($1, $2, NULL, NULL, 'pre', 'allow', $3, NULL)`,
      [
        demandaId,
        runId,
        JSON.stringify({
          agente: 'frota:gestores',
          papel: 'coordenador',
          categoria: 'gestores',
          estado: 'ativo',
          modelo: 'claude-sonnet-5',
          operacao: 'planejamento',
          prioridade: 'MEDIUM',
        }),
      ],
    );
    await db.pool.query(
      `INSERT INTO agent_events (demanda_id, correlacao_id, run_id, tentativa, sequencia_demanda, tipo_evento,
         schema_versao, ator, resumo, metadata, chave_idempotencia)
       VALUES ($1, $2, $2, 1, 1, 'plano_registrado', 1, 'frota:gestores', 'Plano de tarefas registrado (modo planejar — não executa).', $3, $4)`,
      [
        demandaId,
        runId,
        JSON.stringify({ planoId, versao: 1, modo: 'shadow', totalTarefas: 3, totalDependencias: 3 }),
        `${runId}|plano_registrado`,
      ],
    );

    colunasAntes = Object.fromEntries(await Promise.all(TABELAS.map(async (t) => [t, await colunasDe(db.pool, t)] as const)));
    fotoAntes = await fotografar(db.pool, colunasAntes);
    aplicadas = await migrate(db.pool, { ate: '006_execucao_tarefas.sql' });

    // Lido logo depois da migração, antes de qualquer teste gravar linhas novas.
    fotoDepois = await fotografar(db.pool, colunasAntes);
    const distintos = async (sql: string) => (await db.pool.query(sql)).rows;
    colunasNovas = {
      planos_demanda: await distintos('SELECT DISTINCT motivo_abandono, ativado_em, encerrado_em FROM planos_demanda'),
      tarefas: await distintos(
        `SELECT DISTINCT objetivo, claim_id, agente_chave, agente_versao, agente_papel, modelo, tentativas, max_tentativas, timeout_segundos,
                lease_token, lease_expira_em, enviada_em, iniciada_em, concluida_em, codigo_erro, entrega_id
           FROM tarefas`,
      ),
      agent_steps: await distintos('SELECT DISTINCT plano_id, tarefa_id, operacao FROM agent_steps'),
      avaliacoes_politica: await distintos('SELECT DISTINCT tarefa_id, claim_id FROM avaliacoes_politica'),
      agent_events: await distintos('SELECT DISTINCT tarefa_id FROM agent_events'),
    };
  });
  afterAll(async () => {
    await db.drop();
  });

  it('o banco estava parado na 005 e recebe so a 006', () => {
    expect(aplicadas).toEqual(['006_execucao_tarefas.sql']);
    expect(fotoAntes.planos_demanda).toHaveLength(2);
    expect(fotoAntes.tarefas).toHaveLength(3);
    expect(fotoAntes.tarefas_dependencias).toHaveLength(3);
  });

  it('nenhuma linha existente muda: as colunas antigas ficam iguais e as novas vem nulas ou com o padrao', () => {
    expect(fotoDepois).toEqual(fotoAntes);
    expect(colunasNovas).toEqual({
      planos_demanda: [{ motivo_abandono: null, ativado_em: null, encerrado_em: null }],
      tarefas: [
        {
          objetivo: null,
          claim_id: null,
          agente_chave: null,
          agente_versao: null,
          agente_papel: null,
          modelo: null,
          tentativas: 0,
          max_tentativas: 2,
          timeout_segundos: null,
          lease_token: null,
          lease_expira_em: null,
          enviada_em: null,
          iniciada_em: null,
          concluida_em: null,
          codigo_erro: null,
          entrega_id: null,
        },
      ],
      agent_steps: [{ plano_id: null, tarefa_id: null, operacao: null }],
      avaliacoes_politica: [{ tarefa_id: null, claim_id: null }],
      agent_events: [{ tarefa_id: null }],
    });
  });

  it('planos e tarefas shadow continuam imutaveis', async () => {
    await expect(db.pool.query("UPDATE planos_demanda SET estado = 'ativo' WHERE id = $1", [planoId])).rejects.toThrow(
      'planos_demanda: plano shadow é imutável (UPDATE não é permitido)',
    );
    await expect(db.pool.query('DELETE FROM planos_demanda WHERE id = $1', [planoId])).rejects.toThrow('planos_demanda: DELETE não é permitido');
    await expect(db.pool.query("UPDATE tarefas SET estado = 'pronta' WHERE plano_id = $1", [planoId])).rejects.toThrow(
      'tarefas: tarefa de plano shadow é imutável (UPDATE não é permitido)',
    );
    await expect(db.pool.query('DELETE FROM tarefas WHERE plano_id = $1', [planoId])).rejects.toThrow('tarefas: DELETE não é permitido');
    await expect(
      db.pool.query("INSERT INTO tarefas (plano_id, chave, tipo, capacidade, objetivo) VALUES ($1, 'extra', 'especialista', 'd3', 'Objetivo')", [
        planoId,
      ]),
    ).rejects.toThrow('tarefas: tarefa de plano shadow não tem objetivo nem timeout');
    expect(await ativarPlano(db.pool, planoId)).toEqual({ ativado: false });
  });

  it('o SQL literal da 3.1 continua gravando planos shadow na 006 (codigo revertido com a 006 aplicada)', async () => {
    const outra = (await criarDemanda(db.pool, { titulo: 'Depois do upgrade', categoria: 'd2' })).id;
    const novo = await planoShadow31(db.pool, outra, runId, tarefasValidas());
    await planoRejeitado31(db.pool, outra, runId, 'limite_tarefas');
    const planos = await listarPlanosDaDemanda(db.pool, outra);
    expect(planos.map((p) => [p.id === novo, p.versao, p.modo, p.estado, p.motivoRejeicao, p.tarefas.length])).toEqual([
      [true, 1, 'shadow', 'registrado', null, 3],
      [false, 2, 'shadow', 'rejeitado', 'limite_tarefas', 0],
    ]);
  });

  it('o codigo novo le as linhas antigas e grava planos shadow e em execucao no banco atualizado', async () => {
    const [plano] = await listarPlanosDaDemanda(db.pool, demandaId);
    expect(plano).toEqual({
      id: planoId,
      demandaId,
      versao: 1,
      criadoPelaRunId: runId,
      modo: 'shadow',
      estado: 'registrado',
      motivoRejeicao: null,
      motivoAbandono: null,
      tarefas: [
        { chave: 'api', tipo: 'especialista', capacidade: 'd2', estado: 'pendente', dependeDe: ['dados'] },
        { chave: 'dados', tipo: 'especialista', capacidade: 'd1', estado: 'pendente', dependeDe: [] },
        { chave: 'integracao', tipo: 'integracao', capacidade: 'gestores', estado: 'pendente', dependeDe: ['api', 'dados'] },
      ],
    });
    expect(await listarAvaliacoesDaDemanda(db.pool, demandaId)).toMatchObject([{ estagio: 'pre', decisao: 'allow', tarefaId: null, claimId: null }]);
    expect(await listarEventosDaDemanda(db.pool, demandaId)).toMatchObject([{ tipoEvento: 'plano_registrado', tarefaId: null }]);

    const shadow = await registrarPlanoShadow(db.pool, { demandaId, runId, tarefas: tarefasValidas() });
    expect(shadow.totalTarefas).toBe(3);
    await criarEnvelope(db.pool, { demandaId, tetoBaseUsd: '2.00' });
    const execucao = await registrarPlanoDeTeste(db.pool, { demandaId, runId });
    expect(await ativarPlano(db.pool, execucao.planoId)).toMatchObject({ ativado: true, tarefasProntas: 1 });
  });

  it('o gasto legado da demanda, de antes da 006 e do envelope, conta no comprometido', async () => {
    await criarEnvelope(db.pool, { demandaId, tetoBaseUsd: '2.00' });
    expect(await situacaoDeCusto(db.pool, demandaId)).toEqual({ limiteUsd: '2.00', comprometidoUsd: '0.323456', disponivelUsd: '1.676544' });
  });

  it('os passos gravados antes da 006 passam nos CHECK novos e ficam imutaveis depois do upgrade', async () => {
    const { rows: passos } = await db.pool.query<{ id: string }>('SELECT id FROM agent_steps WHERE demanda_id = $1', [demandaId]);
    expect(passos).toHaveLength(2);
    for (const { id } of passos) {
      for (const set of ['custo_usd = 0', 'demanda_id = NULL', "modelo = 'claude-haiku-4-5'"]) {
        await expect(db.pool.query(`UPDATE agent_steps SET ${set} WHERE id = $1`, [id]), set).rejects.toThrow(
          'agent_steps é append-only: UPDATE não é permitido',
        );
      }
      await expect(db.pool.query('DELETE FROM agent_steps WHERE id = $1', [id])).rejects.toThrow('agent_steps é append-only: DELETE não é permitido');
    }
    expect(await situacaoDeCusto(db.pool, demandaId)).toEqual({ limiteUsd: '2.00', comprometidoUsd: '0.323456', disponivelUsd: '1.676544' });
  });
});

describe('upgrade 005 → 006 com um passo fora do dominio', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb({ ate: '005_planos_tarefas.sql' });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('a 006 falha inteira, sem aplicar nada, e so entra depois que a linha e corrigida', async () => {
    await registrarPasso(db.pool, {
      runId: await iniciarRun(db.pool),
      demandaId: null,
      papel: 'frota:architect',
      modelo: 'claude-sonnet-5',
      tokensIn: 100,
      tokensOut: 10,
      cacheRead: 0,
      cacheWrite: 0,
      custoUsd: 0.1,
      duracaoMs: -5,
    });
    const antes = (await db.pool.query('SELECT * FROM agent_steps')).rows;

    await expect(migrate(db.pool, { ate: '006_execucao_tarefas.sql' })).rejects.toThrow('check constraint "agent_steps_duracao_ms_check" of relation "agent_steps" is violated by some row');
    const { rows: migradas } = await db.pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(migradas.map((l) => l.name).at(-1)).toBe('005_planos_tarefas.sql');
    const { rows: tabela } = await db.pool.query<{ t: string | null }>("SELECT to_regclass('public.reservas_custo')::text AS t");
    expect(tabela[0]!.t).toBeNull();
    expect(await colunasDe(db.pool, 'agent_steps')).not.toContain('plano_id');
    expect((await db.pool.query('SELECT * FROM agent_steps')).rows).toEqual(antes);

    // Na 005 agent_steps ainda aceita UPDATE: corrigida a linha, a 006 entra.
    await db.pool.query('UPDATE agent_steps SET duracao_ms = NULL WHERE duracao_ms < 0');
    expect(await migrate(db.pool, { ate: '006_execucao_tarefas.sql' })).toEqual(['006_execucao_tarefas.sql']);
  });
});

describe('migration 006 num banco novo', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it('roda no Postgres 16, a versao principal do Postgres do Railway', async () => {
    const { rows } = await db.pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    expect(Math.floor(Number(rows[0]!.v) / 10_000)).toBe(16);
  });

  it('cria as tabelas e funcoes novas e os gatilhos de COMMIT adiados', async () => {
    const { rows: tabelas } = await db.pool.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('orquestracao_demandas','artefatos_tarefa','reservas_custo','autorizacoes_custo')
        ORDER BY 1`,
    );
    expect(tabelas.map((l) => l.t)).toEqual(['artefatos_tarefa', 'autorizacoes_custo', 'orquestracao_demandas', 'reservas_custo']);

    const { rows: funcoes } = await db.pool.query<{ f: string }>(
      `SELECT proname AS f FROM pg_proc
        WHERE proname IN ('orquestracao_limite_usd','orquestracao_comprometido_usd','referencia_url_valida','artefato_referencias_validas','texto_e_json')
        ORDER BY 1`,
    );
    expect(funcoes.map((l) => l.f)).toEqual([
      'artefato_referencias_validas',
      'orquestracao_comprometido_usd',
      'orquestracao_limite_usd',
      'referencia_url_valida',
      'texto_e_json',
    ]);

    const { rows: adiados } = await db.pool.query(
      `SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
        WHERE tgname IN ('orquestracao_demandas_confere_no_commit','planos_demanda_confere_no_commit','autorizacoes_custo_confere_no_commit')
        ORDER BY tgname`,
    );
    expect(adiados).toEqual([
      { tgname: 'autorizacoes_custo_confere_no_commit', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'orquestracao_demandas_confere_no_commit', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'planos_demanda_confere_no_commit', tgdeferrable: true, tginitdeferred: true },
    ]);
  });

  it('agent_steps: CHECK de dominio validados, plano conferido so no INSERT e gatilhos contra UPDATE e DELETE', async () => {
    const { rows: checks } = await db.pool.query(
      "SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'agent_steps'::regclass AND contype = 'c' ORDER BY conname",
    );
    expect(checks).toEqual(
      [
        'agent_steps_cache_read_check',
        'agent_steps_cache_write_check',
        'agent_steps_custo_usd_check',
        'agent_steps_duracao_ms_check',
        'agent_steps_operacao_check',
        'agent_steps_plano_operacao_check',
        'agent_steps_tarefa_check',
        'agent_steps_tokens_in_check',
        'agent_steps_tokens_out_check',
      ].map((conname) => ({ conname, convalidated: true })),
    );
    const { rows: gatilhos } = await db.pool.query<{ def: string }>(
      "SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'agent_steps'::regclass AND NOT tgisinternal ORDER BY tgname",
    );
    expect(gatilhos.map((l) => l.def)).toEqual([
      'CREATE TRIGGER agent_steps_confere_plano BEFORE INSERT ON public.agent_steps FOR EACH ROW WHEN ((new.plano_id IS NOT NULL)) EXECUTE FUNCTION agent_steps_conferir_plano()',
      'CREATE TRIGGER agent_steps_impede_delete BEFORE DELETE ON public.agent_steps FOR EACH ROW EXECUTE FUNCTION agent_steps_bloquear_alteracao()',
      'CREATE TRIGGER agent_steps_impede_update BEFORE UPDATE ON public.agent_steps FOR EACH ROW EXECUTE FUNCTION agent_steps_bloquear_alteracao()',
    ]);
  });

  it('o caminho legado grava e soma passos, com duracao zero ou nula', async () => {
    const passo = {
      runId: await iniciarRun(db.pool),
      demandaId: (await criarDemanda(db.pool, { titulo: 'Banco novo', categoria: 'd1' })).id,
      papel: 'frota:architect',
      modelo: 'claude-sonnet-5',
      tokensIn: 100,
      tokensOut: 10,
      cacheRead: 0,
      cacheWrite: 0,
    };
    await registrarPasso(db.pool, { ...passo, custoUsd: 0.25, duracaoMs: 0 });
    await registrarPasso(db.pool, { ...passo, custoUsd: 0, duracaoMs: null });
    expect(await gastoDoMes(db.pool)).toBeCloseTo(0.25, 6);
  });

  it('migrar de novo nao aplica nada, e parar numa migration inexistente falha antes de tocar no banco', async () => {
    expect(await migrate(db.pool)).toEqual([]);
    await expect(migrate(db.pool, { ate: '999_inexistente.sql' })).rejects.toThrow('Migração inexistente: 999_inexistente.sql.');
  });
});
