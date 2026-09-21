import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError, type z } from 'zod';
import { listarDemandas } from '../../src/db/demandas.ts';
import { listarMensagens } from '../../src/db/mensagens.ts';
import { listarAprendizado, listarRelatorios } from '../../src/db/relatorios.ts';
import { ArquivoLegadoSchema, importarLegado } from '../../src/legacy/importar.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

type Arquivo = Required<z.input<typeof ArquivoLegadoSchema>>;

const arquivo = (): Arquivo => ({
  demandas: [
    {
      titulo: 'Sistema Organizacional',
      descricao: 'CRM, agenda e scrum — ação 📦',
      categoria: 'd1',
      prioridade: 'HIGH',
      prazo: '2026-10-01',
      solicitante: 'Anderson',
      referencias: null,
      status: 'Concluída',
      entregaUrl: 'https://claude.ai/artifact/exemplo',
      criadoEm: '2026-09-17T10:00:00.000Z',
      mensagens: [
        { autor: 'agente', setor: 'd1', agente: 'ecc:architect', texto: 'Plano definido', criadoEm: '2026-09-17T10:05:00.000Z' },
        { autor: 'solicitante', texto: 'Pode seguir', criadoEm: '2026-09-17T10:06:00.000Z' },
      ],
    },
    {
      titulo: 'Em curso',
      categoria: 'd11',
      status: 'Em andamento',
      criadoEm: '2026-09-18T09:00:00.000Z',
    },
  ],
  relatorios: [
    {
      demandaTitulo: 'Sistema Organizacional',
      gerente: 'Gerente',
      nivelComplexidade: 4,
      setoresEnvolvidos: ['d1', 'gestores', 'd99', 'd3'],
      fontesUtilizadas: 'briefing',
      metricas: { acoesRealizadas: 'muitas', tempoTotal: '2h', indiceGeral: 93, antipadroesCount: 0, regrasCumpridasPercent: 100 },
      ganhos: 'g',
      perdas: 'p',
      aprendizado: 'a',
      ponderacoes: [{ setor: 'd1', nota: 9 }, { setor: 'd3', nota: 'ok' }],
      entregaUrl: null,
      criadoEm: '2026-09-17T12:00:00.000Z',
    },
    {
      demandaTitulo: 'Demanda que nao existe',
      gerente: 'x',
      nivelComplexidade: 1,
      metricas: {},
      criadoEm: '2026-09-17T12:00:00.000Z',
    },
  ],
  aprendizado: [
    { data: '2026-09-17', demanda: 'Sistema Organizacional', nivel: 4, aprendizado: 'Registrar trade-offs', indice: 93 },
  ],
});

describe('importarLegado', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, aprendizado_evolucao CASCADE');
  });

  it('importa demandas, mensagens, relatorios e aprendizado preservando datas e Unicode', async () => {
    const r = await importarLegado(db.pool, arquivo());

    expect(r).toEqual({
      demandas: { inseridas: 2, jaExistiam: 0, devolvidasParaFila: 1, aguardandoInsumo: 0 },
      mensagens: 3,
      relatorios: { inseridos: 1, jaExistiam: 0, semDemanda: ['Demanda que nao existe'] },
      aprendizado: { inseridas: 1, jaExistiam: 0 },
    });

    const demandas = await listarDemandas(db.pool);
    const org = demandas.find((d) => d.titulo === 'Sistema Organizacional')!;
    expect(org).toMatchObject({
      descricao: 'CRM, agenda e scrum — ação 📦',
      categoria: 'd1',
      prioridade: 'HIGH',
      prazo: '2026-10-01',
      status: 'Concluída',
      entregaUrl: 'https://claude.ai/artifact/exemplo',
      criadoEm: '2026-09-17T10:00:00.000Z',
    });
    const mensagens = await listarMensagens(db.pool, org.id);
    expect(mensagens.map((m) => [m.autor, m.agente, m.texto])).toEqual([
      ['agente', 'ecc:architect', 'Plano definido'],
      ['solicitante', null, 'Pode seguir'],
    ]);

    const [relatorio] = await listarRelatorios(db.pool);
    expect(relatorio).toMatchObject({
      demandaId: org.id,
      setoresEnvolvidos: ['d1', 'd3'],
      metricas: { indiceGeral: 93 },
      ponderacoes: [{ setor: 'd1', nota: '9' }, { setor: 'd3', nota: 'ok' }],
      criadoEm: '2026-09-17T12:00:00.000Z',
    });
    expect((await listarAprendizado(db.pool))[0]).toMatchObject({ demanda: 'Sistema Organizacional', nivel: 4, indice: 93 });
  });

  it('recoloca na fila a demanda que estava em andamento e registra o motivo', async () => {
    await importarLegado(db.pool, arquivo());
    const emCurso = (await listarDemandas(db.pool)).find((d) => d.titulo === 'Em curso')!;
    expect(emCurso.status).toBe('Nova');
    const mensagens = await listarMensagens(db.pool, emCurso.id);
    expect(mensagens.at(-1)?.texto).toContain('voltou para a fila');
  });

  it('mantem aguardando insumo, sem refazer o trabalho, a demanda em andamento que ja tem relatorio e entrega', async () => {
    const dados = arquivo();
    dados.demandas[1] = {
      ...dados.demandas[1]!,
      titulo: 'Rascunho publicado',
      entregaUrl: 'https://claude.ai/artifact/rascunho',
    };
    dados.relatorios.push({ ...dados.relatorios[0]!, demandaTitulo: 'Rascunho publicado', criadoEm: '2026-09-18T18:06:20.000Z' });

    const r = await importarLegado(db.pool, dados);

    expect(r.demandas).toMatchObject({ devolvidasParaFila: 0, aguardandoInsumo: 1 });
    const d = (await listarDemandas(db.pool)).find((x) => x.titulo === 'Rascunho publicado')!;
    expect(d).toMatchObject({ status: 'Aguardando insumo', alternativaInsumo: 'A', entregaUrl: 'https://claude.ai/artifact/rascunho' });
    expect((await listarMensagens(db.pool, d.id)).at(-1)?.texto).toContain('aguarda o insumo');
  });

  it('sem entrega, o rascunho em andamento com relatorio vira alternativa B', async () => {
    const dados = arquivo();
    dados.relatorios.push({ ...dados.relatorios[0]!, demandaTitulo: 'Em curso', criadoEm: '2026-09-18T18:06:20.000Z' });

    await importarLegado(db.pool, dados);

    const d = (await listarDemandas(db.pool)).find((x) => x.titulo === 'Em curso')!;
    expect(d).toMatchObject({ status: 'Aguardando insumo', alternativaInsumo: 'B' });
  });

  it('e idempotente: rodar de novo nao duplica nada', async () => {
    await importarLegado(db.pool, arquivo());

    const segunda = await importarLegado(db.pool, arquivo());

    expect(segunda).toEqual({
      demandas: { inseridas: 0, jaExistiam: 2, devolvidasParaFila: 0, aguardandoInsumo: 0 },
      mensagens: 0,
      relatorios: { inseridos: 0, jaExistiam: 1, semDemanda: ['Demanda que nao existe'] },
      aprendizado: { inseridas: 0, jaExistiam: 1 },
    });
    expect(await listarDemandas(db.pool)).toHaveLength(2);
    expect(await listarRelatorios(db.pool)).toHaveLength(1);
    expect(await listarAprendizado(db.pool)).toHaveLength(1);
  });

  it('rejeita arquivo invalido sem importar nada (tudo ou nada)', async () => {
    const ruim = arquivo();
    ruim.demandas[1] = { ...ruim.demandas[1]!, categoria: 'd99' as 'd1' };

    await expect(importarLegado(db.pool, ruim)).rejects.toBeInstanceOf(ZodError);

    expect(await listarDemandas(db.pool)).toHaveLength(0);
  });

  it('desfaz tudo quando um registro falha no meio da importacao', async () => {
    const ruim = arquivo();
    ruim.aprendizado.push({ data: 'nao-e-data', demanda: 'x', nivel: 2, aprendizado: 'y', indice: 1 });

    await expect(importarLegado(db.pool, ruim)).rejects.toThrow();

    expect(await listarDemandas(db.pool)).toHaveLength(0);
    expect(await listarRelatorios(db.pool)).toHaveLength(0);
  });

  it('recusa titulos repetidos, porque os relatorios sao ligados as demandas pelo titulo', async () => {
    const duplicado = arquivo();
    duplicado.demandas.push({ ...duplicado.demandas[0]!, criadoEm: '2026-09-19T00:00:00.000Z' });

    await expect(importarLegado(db.pool, duplicado)).rejects.toThrow(/Título repetido/);

    expect(await listarDemandas(db.pool)).toHaveLength(0);
  });

  it('aceita um arquivo so com demandas', async () => {
    const r = await importarLegado(db.pool, { demandas: [{ titulo: 'Sozinha', categoria: 'd2', status: 'Nova', criadoEm: '2026-09-01T00:00:00Z' }] });
    expect(r.demandas.inseridas).toBe(1);
    expect(r.relatorios).toEqual({ inseridos: 0, jaExistiam: 0, semDemanda: [] });
  });
});
