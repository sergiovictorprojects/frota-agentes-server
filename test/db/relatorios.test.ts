import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDemanda } from '../../src/db/demandas.ts';
import { adicionarMensagem, LIMITE_TEXTO_MENSAGEM, listarMensagens } from '../../src/db/mensagens.ts';
import {
  criarEntrega,
  listarAprendizado,
  listarRelatorios,
  obterEntrega,
  registrarAprendizado,
  relatorioMaisRecente,
  salvarRelatorio,
  type NovoRelatorio,
} from '../../src/db/relatorios.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('mensagens, relatorios e entregas', () => {
  let db: TestDb;
  let demandaId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, aprendizado_evolucao CASCADE');
    demandaId = (await criarDemanda(db.pool, { titulo: 'Base', categoria: 'd1' })).id;
  });

  function relatorio(sobrescrever: Partial<NovoRelatorio> = {}): NovoRelatorio {
    return {
      demandaId,
      demandaTitulo: 'Base',
      gerente: 'frota:architect',
      nivelComplexidade: 3,
      setoresEnvolvidos: ['d1', 'd3'],
      fontesUtilizadas: 'briefing da demanda',
      metricas: {
        acoesRealizadas: '2 chamadas ao modelo',
        tempoTotal: '41s',
        indiceGeral: 88,
        antipadroesCount: 1,
        regrasCumpridasPercent: 67,
      },
      ganhos: 'entrega utilizavel',
      perdas: 'uma regra violada',
      aprendizado: 'registrar trade-offs',
      ponderacoes: [{ setor: 'd1', nota: 'ok' }],
      entregaUrl: null,
      ...sobrescrever,
    };
  }

  it('lista mensagens em ordem cronologica preservando o agente que as escreveu', async () => {
    await adicionarMensagem(db.pool, { demandaId, autor: 'agente', setor: 'd1', agente: 'frota:architect', texto: 'um' });
    await adicionarMensagem(db.pool, { demandaId, autor: 'agente', texto: 'dois' });
    await adicionarMensagem(db.pool, { demandaId, autor: 'solicitante', texto: 'tres' });

    const msgs = await listarMensagens(db.pool, demandaId);

    expect(msgs.map((m) => m.texto)).toEqual(['um', 'dois', 'tres']);
    expect(msgs[0]).toMatchObject({ setor: 'd1', agente: 'frota:architect', autor: 'agente' });
    expect(msgs[1]).toMatchObject({ setor: null, agente: null });
  });

  it('trunca mensagens maiores que o limite em vez de falhar', async () => {
    const m = await adicionarMensagem(db.pool, { demandaId, autor: 'agente', texto: 'x'.repeat(5000) });
    expect(m.texto).toHaveLength(LIMITE_TEXTO_MENSAGEM);
    expect(m.texto.endsWith('…')).toBe(true);
  });

  it('salva e le relatorio com arrays e JSON', async () => {
    const salvo = await salvarRelatorio(db.pool, relatorio());
    const lido = await relatorioMaisRecente(db.pool, demandaId);
    expect(lido).toEqual(salvo);
    expect(lido).toMatchObject({
      setoresEnvolvidos: ['d1', 'd3'],
      metricas: { indiceGeral: 88, antipadroesCount: 1 },
      ponderacoes: [{ setor: 'd1', nota: 'ok' }],
    });
  });

  it('guarda metricas nulas quando a auditoria falhou', async () => {
    const salvo = await salvarRelatorio(
      db.pool,
      relatorio({
        metricas: {
          acoesRealizadas: 'x',
          tempoTotal: '1s',
          indiceGeral: null,
          antipadroesCount: null,
          regrasCumpridasPercent: null,
          auditoriaFalhou: true,
        },
      }),
    );
    expect(salvo.metricas).toMatchObject({ antipadroesCount: null, auditoriaFalhou: true });
  });

  it('devolve o relatorio mais recente da demanda e limita a listagem', async () => {
    await salvarRelatorio(db.pool, relatorio({ gerente: 'primeiro' }));
    await salvarRelatorio(db.pool, relatorio({ gerente: 'segundo' }));
    expect((await relatorioMaisRecente(db.pool, demandaId))?.gerente).toBe('segundo');
    expect(await listarRelatorios(db.pool, 1)).toHaveLength(1);
    expect(await relatorioMaisRecente(db.pool, randomUUID())).toBeNull();
  });

  it('registra aprendizado e lista do mais recente para o mais antigo', async () => {
    await registrarAprendizado(db.pool, { demanda: 'A', nivel: 2, aprendizado: 'primeiro', indice: 70 });
    await registrarAprendizado(db.pool, { demanda: 'B', nivel: 4, aprendizado: 'segundo', indice: null });
    const lista = await listarAprendizado(db.pool);
    expect(lista.map((e) => e.demanda)).toEqual(['B', 'A']);
    expect(lista[0]).toMatchObject({ nivel: 4, indice: null });
    expect(lista[1]?.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('cria e le entregas, com status de promocao pendente por padrao', async () => {
    const e = await criarEntrega(db.pool, { demandaId, titulo: 'Painel', conteudo: '<h1>ola 📦</h1>' });
    expect(e).toMatchObject({ statusPromocao: 'pendente', artifactUrl: null, titulo: 'Painel' });
    expect((await obterEntrega(db.pool, e.id))?.conteudo).toBe('<h1>ola 📦</h1>');
    expect(await obterEntrega(db.pool, randomUUID())).toBeNull();
  });

  it('rejeita entregas acima de 2 MB', async () => {
    await expect(
      criarEntrega(db.pool, { demandaId, titulo: 'gigante', conteudo: 'a'.repeat(2_000_001) }),
    ).rejects.toThrow();
  });
});
