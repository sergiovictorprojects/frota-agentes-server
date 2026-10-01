import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDemanda } from '../../src/db/demandas.ts';
import {
  ATOR_SISTEMA,
  listarEventosDaDemanda,
  listarEventosDaRun,
  montarChaveIdempotencia,
  registrarEvento,
  TIPOS_EVENTO,
  type NovoEvento,
  type TipoEvento,
} from '../../src/db/eventos.ts';
import { listarMigracoesDisponiveis } from '../../src/db/migrate.ts';
import { iniciarRun } from '../../src/db/operacao.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { planoAtivoDeTeste, reivindicar, type PlanoDeTeste } from '../helpers/execucao.ts';

describe('migration 002_agent_events', () => {
  it('esta registrada e aplicada junto com as demais migrations', async () => {
    expect(await listarMigracoesDisponiveis()).toEqual([
      '001_init.sql',
      '002_agent_events.sql',
      '003_agentes.sql',
      '004_policy_engine.sql',
      '005_planos_tarefas.sql',
      '006_execucao_tarefas.sql',
      '007_artefatos_entregaveis.sql',
      '008_demanda_especificacao_extensa.sql',
      '009_resultado_esperado_demanda.sql',
    ]);
  });
});

describe('agent_events', () => {
  let db: TestDb;
  let demandaId: string;
  let runId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs CASCADE');
    demandaId = (await criarDemanda(db.pool, { titulo: 'Demanda de teste', categoria: 'd1' })).id;
    runId = await iniciarRun(db.pool);
  });

  // processamento_iniciado tem metadata vazia: é o tipo mais simples para os testes que não são sobre
  // o conteúdo da metadata em si.
  function evento(sobrescrever: Partial<Parameters<typeof registrarEvento>[1]> = {}) {
    return {
      demandaId,
      correlacaoId: runId,
      runId,
      tentativa: 1,
      tipoEvento: 'processamento_iniciado' as const,
      ator: 'frota:architect',
      chaveIdempotencia: montarChaveIdempotencia(runId, 'processamento_iniciado'),
      metadata: {},
      ...sobrescrever,
    };
  }

  describe('estrutura da tabela', () => {
    it('cria a tabela com as colunas esperadas', async () => {
      const { rows } = await db.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_events' ORDER BY column_name",
      );
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        [
          'id',
          'demanda_id',
          'correlacao_id',
          'run_id',
          'tentativa',
          'sequencia_demanda',
          'tipo_evento',
          'schema_versao',
          'ator',
          'resumo',
          'metadata',
          'chave_idempotencia',
          'ocorrido_em',
          // Fase 3.2a (migration 006): anulável, com FK para tarefas.
          'tarefa_id',
        ].sort(),
      );
    });

    it('rejeita resumo vazio ou maior que 2000 caracteres, mesmo por SQL direto', async () => {
      const base =
        "INSERT INTO agent_events (demanda_id, correlacao_id, tentativa, sequencia_demanda, tipo_evento, ator, resumo, chave_idempotencia) VALUES ($1, $3, 1, 1, 't', 'sistema', $2, 'k')";
      await expect(db.pool.query(base, [demandaId, '', randomUUID()])).rejects.toThrow();
      await expect(db.pool.query(base, [demandaId, 'x'.repeat(2001), randomUUID()])).rejects.toThrow();
    });

    it('rejeita run_id que nao existe (chave estrangeira)', async () => {
      await expect(registrarEvento(db.pool, evento({ runId: randomUUID() }))).rejects.toThrow();
    });

    it('rejeita demanda_id que nao existe', async () => {
      await expect(registrarEvento(db.pool, evento({ demandaId: randomUUID() }))).rejects.toThrow();
    });

    it('rejeita tipo_evento fora da lista permitida, mesmo contornando o tipo do TypeScript', async () => {
      await expect(
        registrarEvento(db.pool, evento({ tipoEvento: 'tipo_inventado' as never })),
      ).rejects.toThrow(/não permitido/);
    });

    it('aceita tentativa nula: o evento nao prova que o processamento comecou', async () => {
      const e = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'demanda_reivindicada', tentativa: null, metadata: { tentativaPlanejada: 1 } }),
      );
      expect(e.tentativa).toBeNull();
    });
  });

  describe('append-only: UPDATE e DELETE bloqueados', () => {
    it('recusa UPDATE com a mensagem do gatilho', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query("UPDATE agent_events SET resumo = 'alterado'")).rejects.toThrow(/append-only/);
    });

    it('recusa DELETE com a mensagem do gatilho', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query('DELETE FROM agent_events')).rejects.toThrow(/append-only/);
    });

    it('TRUNCATE ... CASCADE (usado pela limpeza dos testes) continua funcionando', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query('TRUNCATE demandas CASCADE')).resolves.toBeDefined();
    });
  });

  describe('apagar a demanda-mae: RESTRICT, nao CASCADE', () => {
    it('bloqueia a remocao fisica de uma demanda que tem eventos', async () => {
      await registrarEvento(db.pool, evento());
      await expect(db.pool.query('DELETE FROM demandas WHERE id = $1', [demandaId])).rejects.toThrow();
      // a demanda continua existindo, porque o DELETE foi rejeitado
      const { rowCount } = await db.pool.query('SELECT 1 FROM demandas WHERE id = $1', [demandaId]);
      expect(rowCount).toBe(1);
    });

    it('permite apagar uma demanda que nunca teve eventos', async () => {
      const semEventos = (await criarDemanda(db.pool, { titulo: 'Sem eventos', categoria: 'd1' })).id;
      await expect(db.pool.query('DELETE FROM demandas WHERE id = $1', [semEventos])).resolves.toBeDefined();
    });
  });

  describe('ordenacao (cursor global id)', () => {
    it('atribui sequencia_demanda crescente comecando em 1, por demanda', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd2' })).id;

      const e1 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'a' }));
      const e2 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));
      const eOutra = await registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: 'a' }));

      expect(e1.sequenciaDemanda).toBe(1);
      expect(e2.sequenciaDemanda).toBe(2);
      expect(eOutra.sequenciaDemanda).toBe(1);
    });

    it('cursor global (id) cresce entre demandas diferentes, sem reiniciar', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd2' })).id;
      const e1 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'a' }));
      const e2 = await registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: 'a' }));
      const e3 = await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));

      expect(BigInt(e2.id)).toBeGreaterThan(BigInt(e1.id));
      expect(BigInt(e3.id)).toBeGreaterThan(BigInt(e2.id));
    });

    it('listarEventosDaDemanda ordena por id (cursor global), nao por sequencia_demanda ou tentativa', async () => {
      await registrarEvento(db.pool, evento({ tipoEvento: 'demanda_criada', chaveIdempotencia: 'a', metadata: { categoria: 'd1', prioridade: 'MEDIUM' } }));
      await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));
      await registrarEvento(db.pool, evento({ tipoEvento: 'demanda_reaberta', chaveIdempotencia: 'c', metadata: { origem: 'manual' } }));

      const lista = await listarEventosDaDemanda(db.pool, demandaId);
      expect(lista.map((e) => e.tipoEvento)).toEqual(['demanda_criada', 'processamento_iniciado', 'demanda_reaberta']);
      // id crescente e estritamente ordenado — é a garantia de estabilidade, não sequencia_demanda.
      for (let i = 1; i < lista.length; i++) expect(BigInt(lista[i]!.id)).toBeGreaterThan(BigInt(lista[i - 1]!.id));
    });

    it('listarEventosDaRun devolve os eventos de varias demandas na mesma run, em ordem de id', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd2' })).id;
      await registrarEvento(db.pool, evento({ chaveIdempotencia: 'a' }));
      await registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: 'a' }));
      await registrarEvento(db.pool, evento({ chaveIdempotencia: 'b' }));

      const lista = await listarEventosDaRun(db.pool, runId);
      expect(lista).toHaveLength(3);
      expect(lista.map((e) => e.demandaId)).toEqual([demandaId, outraDemandaId, demandaId]);
      for (let i = 1; i < lista.length; i++) expect(BigInt(lista[i]!.id)).toBeGreaterThan(BigInt(lista[i - 1]!.id));
    });

    it('duas demandas processadas em paralelo nao embaralham suas sequencias', async () => {
      const outraDemandaId = (await criarDemanda(db.pool, { titulo: 'Paralela', categoria: 'd2' })).id;

      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) => registrarEvento(db.pool, evento({ chaveIdempotencia: `d1-${i}` }))),
        ...Array.from({ length: 5 }, (_, i) =>
          registrarEvento(db.pool, evento({ demandaId: outraDemandaId, chaveIdempotencia: `d2-${i}` })),
        ),
      ]);

      const seqDemanda1 = (await listarEventosDaDemanda(db.pool, demandaId)).map((e) => e.sequenciaDemanda);
      const seqDemanda2 = (await listarEventosDaDemanda(db.pool, outraDemandaId)).map((e) => e.sequenciaDemanda);
      expect(seqDemanda1.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      expect(seqDemanda2.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('idempotencia e retry', () => {
    it('a mesma chave para a mesma demanda nunca duplica: devolve o evento original', async () => {
      const primeiro = await registrarEvento(db.pool, evento());
      const segundo = await registrarEvento(db.pool, evento());

      expect(segundo.id).toBe(primeiro.id);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(1);
    });

    it('chamadas concorrentes com a mesma chave produzem um unico evento (retry seguro)', async () => {
      const resultados = await Promise.all(Array.from({ length: 8 }, () => registrarEvento(db.pool, evento())));
      const idsUnicos = new Set(resultados.map((r) => r.id));
      expect(idsUnicos.size).toBe(1);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(1);
    });

    it('duas execucoes distintas (correlacaoId diferente) nunca colidem, mesmo com o mesmo numero de tentativa', async () => {
      // Este é exatamente o cenário que a tentativa sozinha não conseguia distinguir: run A e run B
      // processam a MESMA demanda na tentativa 1 (ex.: run A sofreu parada sistêmica e devolveu sem
      // penalizar, ou a demanda foi reaberta e zerou tentativas) — o correlacaoId (run_id) é que garante
      // que os eventos de uma não apagam os da outra.
      const runA = runId;
      const runB = await iniciarRun(db.pool);

      const eA = await registrarEvento(
        db.pool,
        evento({ runId: runA, correlacaoId: runA, tentativa: 1, chaveIdempotencia: montarChaveIdempotencia(runA, 'processamento_iniciado') }),
      );
      const eB = await registrarEvento(
        db.pool,
        evento({ runId: runB, correlacaoId: runB, tentativa: 1, chaveIdempotencia: montarChaveIdempotencia(runB, 'processamento_iniciado') }),
      );

      expect(eB.id).not.toBe(eA.id);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(2);
    });

    it('interrupcao sistemica seguida de reprocessamento e reabertura: cada execucao fica com seus proprios eventos', async () => {
      // run 1: começa, sofre parada sistêmica (orçamento/pausa/API fora do ar) e devolve sem penalizar
      // a tentativa (desfazerTentativa = true em devolverParaFila, fora do escopo deste teste unitário).
      const run1 = runId;
      await registrarEvento(
        db.pool,
        evento({
          runId: run1,
          correlacaoId: run1,
          tentativa: 1,
          chaveIdempotencia: montarChaveIdempotencia(run1, 'processamento_iniciado'),
        }),
      );
      await registrarEvento(
        db.pool,
        evento({
          runId: run1,
          correlacaoId: run1,
          tentativa: 1,
          tipoEvento: 'demanda_devolvida_para_fila',
          chaveIdempotencia: montarChaveIdempotencia(run1, 'demanda_devolvida_para_fila'),
          metadata: { motivoDevolucao: 'parada_sistemica', codigoErro: 'orcamento_excedido' },
        }),
      );

      // run 2: reprocessa a mesma demanda, ainda na "tentativa 1" (a run 1 não consumiu a tentativa) —
      // é exatamente o caso que tentativa sozinha não distingue, mas correlacaoId (run2 !== run1) sim.
      const run2 = await iniciarRun(db.pool);
      const e2 = await registrarEvento(
        db.pool,
        evento({
          runId: run2,
          correlacaoId: run2,
          tentativa: 1,
          chaveIdempotencia: montarChaveIdempotencia(run2, 'processamento_iniciado'),
        }),
      );

      // depois, a demanda é reaberta pela interface (reabrirDemanda zera tentativas): outra correlação
      // imutável (um UUID de ação de interface, sem run), sem tentativa provada (null).
      const correlacaoReabertura = randomUUID();
      const e3 = await registrarEvento(
        db.pool,
        evento({
          runId: null,
          correlacaoId: correlacaoReabertura,
          tentativa: null,
          tipoEvento: 'demanda_reaberta',
          chaveIdempotencia: montarChaveIdempotencia(correlacaoReabertura, 'demanda_reaberta'),
          metadata: { origem: 'manual' },
        }),
      );

      const linha = await listarEventosDaDemanda(db.pool, demandaId);
      expect(linha).toHaveLength(4);
      expect(new Set(linha.map((e) => e.correlacaoId)).size).toBe(3);
      expect(e2.tentativa).toBe(1);
      expect(e3.tentativa).toBeNull();
    });

    it('a mesma run com tipos de evento diferentes gera eventos distintos', async () => {
      const t1 = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'demanda_falhou', chaveIdempotencia: montarChaveIdempotencia(runId, 'demanda_falhou'), metadata: { codigoErro: 'falha_inesperada' } }),
      );
      const t2 = await registrarEvento(
        db.pool,
        evento({
          tipoEvento: 'demanda_devolvida_para_fila',
          chaveIdempotencia: montarChaveIdempotencia(runId, 'demanda_devolvida_para_fila'),
          metadata: { motivoDevolucao: 'falha_da_demanda', codigoErro: 'falha_inesperada' },
        }),
      );

      expect(t2.id).not.toBe(t1.id);
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(2);
    });
  });

  describe('conteudo seguro: resumo fixo e metadata restrita por schema', () => {
    it('resumo e sempre o texto fixo do tipo, nunca o que foi passado em metadata', async () => {
      const e = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'entrega_criada', metadata: { entregaId: randomUUID(), tipo: 'html', publicadaComoHtml: true } }),
      );
      expect(e.resumo).toBe('Entrega criada.');
    });

    it('metadata guarda so o que o schema do tipo permite, sem campos extras', async () => {
      const e = await registrarEvento(
        db.pool,
        evento({ tipoEvento: 'auditoria_concluida', metadata: { antipadroesCount: 2, regrasCumpridasPercent: 50 } }),
      );
      expect(e.metadata).toEqual({ antipadroesCount: 2, regrasCumpridasPercent: 50 });
    });

    it('rejeita metadata com campo fora do schema do tipo', async () => {
      await expect(
        registrarEvento(db.pool, evento({ tipoEvento: 'auditoria_concluida', metadata: { antipadroesCount: 2, regrasCumpridasPercent: 50, extra: 'x' } })),
      ).rejects.toThrow();
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(0);
    });

    it('rejeita metadata com texto livre onde o schema exige enum ou numero', async () => {
      await expect(
        registrarEvento(db.pool, evento({ tipoEvento: 'chamada_trabalho_falhou', metadata: { codigoErro: 'um erro qualquer em texto livre' } })),
      ).rejects.toThrow();
    });

    it('rejeita campos classicamente perigosos, porque eles simplesmente nao existem em nenhum schema', async () => {
      for (const campo of ['prompt', 'chain_of_thought', 'raciocinio', 'resposta_bruta', 'api_key', 'authorization']) {
        await expect(registrarEvento(db.pool, evento({ metadata: { [campo]: 'x' } }))).rejects.toThrow();
      }
      expect(await listarEventosDaDemanda(db.pool, demandaId)).toHaveLength(0);
    });

    it('um segredo colocado em titulo, plano, motivo, descricao ou mensagem de erro nunca aparece em agent_events', async () => {
      const segredo = 'RACIOCINIO_INTERNO_BRUTO_NAO_DEVE_VAZAR_AQUI';
      const demandaComSegredo = await criarDemanda(db.pool, { titulo: `Demanda ${segredo}`, categoria: 'd1' });

      // Simula os pontos reais do fluxo: cada um usa só o resumo fixo e a metadata do schema do tipo —
      // nunca o texto que, na aplicação real, viria do título, do plano do modelo, do motivo de uma
      // pendência, da descrição de um insumo faltante ou da mensagem de um erro lançado.
      await registrarEvento(db.pool, {
        demandaId: demandaComSegredo.id,
        correlacaoId: runId,
        runId,
        tentativa: null,
        tipoEvento: 'demanda_criada',
        ator: 'solicitante',
        chaveIdempotencia: montarChaveIdempotencia(runId, 'demanda_criada'),
        // metadata do schema real de demanda_criada: categoria e prioridade, nunca o título.
        metadata: { categoria: 'd1', prioridade: 'MEDIUM' },
      });
      await registrarEvento(db.pool, {
        demandaId: demandaComSegredo.id,
        correlacaoId: runId,
        runId,
        tentativa: 1,
        tipoEvento: 'pendencia_humana_registrada',
        ator: 'frota:architect',
        chaveIdempotencia: montarChaveIdempotencia(runId, 'pendencia_humana_registrada'),
        // motivo real (`segredo`) nunca entra: só a contagem de ações.
        metadata: { totalAcoes: 2 },
      });
      await registrarEvento(db.pool, {
        demandaId: demandaComSegredo.id,
        correlacaoId: runId,
        runId,
        tentativa: 1,
        tipoEvento: 'chamada_trabalho_falhou',
        ator: 'frota:architect',
        chaveIdempotencia: montarChaveIdempotencia(runId, 'chamada_trabalho_falhou'),
        // mensagem real do erro (poderia conter `segredo`) nunca entra: só o código classificado.
        metadata: { codigoErro: 'llm_invalido' },
      });

      const eventos = await listarEventosDaDemanda(db.pool, demandaComSegredo.id);
      expect(eventos.length).toBeGreaterThan(0);
      expect(JSON.stringify(eventos)).not.toContain(segredo);
    });
  });
});

// Fase 3.2a: os schemas dos eventos novos e as regras que cruzam a metadata com as colunas (tarefa_id e ator).
// Quem emite esses eventos é a PR 3.2b; aqui só se prova o que o ledger aceita e recusa. Banco próprio, com um
// plano ativo e um claim de verdade, para a tarefa passar pelo gatilho agent_events_confere_tarefa.
describe('agent_events da Fase 3.2 (execucao por tarefas)', () => {
  let db: TestDb;
  let p: PlanoDeTeste;
  let tarefaId: string;
  let claimId: string;
  let leaseToken: string;
  let n = 0;
  const ENTREGA_ID = randomUUID();
  const ARTEFATO_ID = randomUUID();

  beforeAll(async () => {
    db = await createTestDb();
    p = await planoAtivoDeTeste(db.pool);
    const t = await reivindicar(db.pool, p.planoId);
    tarefaId = t.id;
    claimId = t.claimId;
    leaseToken = t.leaseToken;
  });
  afterAll(async () => {
    await db.drop();
  });

  // Chave nova a cada chamada: cada teste grava de verdade, sem cair na idempotência de um teste anterior.
  function novo(tipoEvento: TipoEvento, metadata: Record<string, unknown>, extra: Partial<NovoEvento> = {}): NovoEvento {
    n += 1;
    return {
      demandaId: p.demandaId,
      correlacaoId: p.runId,
      runId: p.runId,
      tentativa: null,
      tipoEvento,
      ator: ATOR_SISTEMA,
      chaveIdempotencia: montarChaveIdempotencia(p.runId, tipoEvento, n),
      metadata,
      ...extra,
    };
  }

  async function totalDeEventos(): Promise<number> {
    return (await listarEventosDaDemanda(db.pool, p.demandaId)).length;
  }

  interface Caso {
    tipo: TipoEvento;
    resumo: string;
    // A tarefa vai na coluna tarefa_id: obrigatória nesses tipos.
    comTarefa: boolean;
    ator?: string;
    metadata: () => Record<string, unknown>;
  }

  // Um caso válido por tipo novo, na ordem de TIPOS_EVENTO.
  const CASOS: Caso[] = [
    {
      tipo: 'rota_definida',
      resumo: 'Rota do processamento definida.',
      comTarefa: false,
      metadata: () => ({ rota: 'tarefas', motivoRota: 'categoria_ligada' }),
    },
    {
      tipo: 'plano_ativado',
      resumo: 'Plano de tarefas ativado para execução.',
      comTarefa: false,
      metadata: () => ({ planoId: p.planoId, versao: 1, totalTarefas: 2 }),
    },
    {
      tipo: 'plano_retomado',
      resumo: 'Plano de tarefas retomado.',
      comTarefa: false,
      metadata: () => ({ planoId: p.planoId, versao: 1, tarefasConcluidas: 1, tarefasRestantes: 1 }),
    },
    {
      tipo: 'plano_abandonado',
      resumo: 'Plano de tarefas abandonado.',
      comTarefa: false,
      metadata: () => ({ planoId: p.planoId, versao: 1, motivoAbandono: 'pendencia_humana', tarefasCanceladas: 2 }),
    },
    {
      tipo: 'plano_concluido',
      resumo: 'Plano de tarefas concluído.',
      comTarefa: false,
      metadata: () => ({ planoId: p.planoId, versao: 1, entregaId: ENTREGA_ID }),
    },
    {
      tipo: 'fallback_legado',
      resumo: 'Demanda desviada para o fluxo legado.',
      comTarefa: false,
      metadata: () => ({ planoId: null, motivoFallback: 'planejamento_falhou', codigoErro: 'llm_api' }),
    },
    {
      tipo: 'agente_selecionado',
      resumo: 'Agente selecionado para a tarefa.',
      comTarefa: true,
      metadata: () => ({ claimId, agente: 'frota:architect', versaoAgente: 1, capacidade: 'd1' }),
    },
    {
      tipo: 'tarefa_iniciada',
      resumo: 'Tarefa iniciada: envio registrado.',
      comTarefa: true,
      metadata: () => ({
        claimId,
        tipo: 'especialista',
        tentativa: 1,
        maxTentativas: 2,
        artefatosIntegrais: 0,
        artefatosSoResumo: 0,
        conversaOmitida: 0,
      }),
    },
    {
      tipo: 'tarefa_concluida',
      resumo: 'Tarefa concluída.',
      comTarefa: true,
      metadata: () => ({
        claimId,
        tipo: 'especialista',
        tentativa: 1,
        artefatoId: ARTEFATO_ID,
        bytes: 20,
        totalReferencias: 1,
        referenciasDescartadas: 0,
        duracaoMs: 1500,
      }),
    },
    {
      tipo: 'tarefa_falhou',
      resumo: 'Tarefa falhou.',
      comTarefa: true,
      // Fora de contexto_excedido o ator é o agente do claim, nunca "sistema".
      ator: 'frota:architect',
      metadata: () => ({ claimId, tipo: 'especialista', tentativa: 1, codigoErro: 'llm_timeout', definitiva: false }),
    },
    {
      tipo: 'tarefa_devolvida',
      resumo: 'Tarefa devolvida antes do envio, sem consumir tentativa.',
      comTarefa: true,
      metadata: () => ({ claimId, codigoErro: 'custo_demanda_excedido' }),
    },
    {
      tipo: 'tarefa_lease_expirado',
      resumo: 'Lease da tarefa expirado.',
      comTarefa: true,
      metadata: () => ({ claimId, tentativa: 1, enviada: true, destino: 'pronta' }),
    },
    {
      tipo: 'tarefa_resultado_descartado',
      resumo: 'Resultado da tarefa descartado.',
      comTarefa: true,
      metadata: () => ({ claimId, tentativa: 1, motivoDescarte: 'lease_perdido' }),
    },
    {
      tipo: 'custo_demanda_excedido',
      resumo: 'Teto de custo da demanda atingido: a chamada não foi feita.',
      comTarefa: false,
      metadata: () => ({ comprometidoUsd: 1.95, reservaUsd: 0.1, limiteUsd: 2, operacao: 'execucao' }),
    },
    {
      tipo: 'custo_acima_da_reserva',
      resumo: 'Custo real acima do valor reservado.',
      comTarefa: false,
      metadata: () => ({ operacao: 'execucao', reservaUsd: 0.02, custoRealUsd: 0.026 }),
    },
    {
      tipo: 'custo_adicional_autorizado',
      resumo: 'Custo adicional autorizado.',
      comTarefa: false,
      metadata: () => ({ valorUsd: 1.5, limiteAnteriorUsd: 2, limiteNovoUsd: 3.5 }),
    },
    {
      tipo: 'gasto_retido_reconhecido',
      resumo: 'Gasto retido reconhecido.',
      comTarefa: false,
      metadata: () => ({ valorUsd: 0.05, operacao: 'execucao' }),
    },
  ];

  function caso(tipo: TipoEvento): Caso {
    const c = CASOS.find((x) => x.tipo === tipo);
    if (!c) throw new Error(`sem caso para ${tipo}`);
    return c;
  }

  // O evento válido do caso, com a tarefa e o ator que ele pede, mais o que o teste sobrescrever.
  function doCaso(c: Caso, metadataExtra: Record<string, unknown> = {}, extra: Partial<NovoEvento> = {}): NovoEvento {
    return novo(c.tipo, { ...c.metadata(), ...metadataExtra }, {
      ...(c.comTarefa ? { tarefaId } : {}),
      ...(c.ator ? { ator: c.ator } : {}),
      ...extra,
    });
  }

  it('cobre todos os tipos novos da Fase 3.2', () => {
    expect(CASOS.map((c) => c.tipo)).toEqual(TIPOS_EVENTO.slice(TIPOS_EVENTO.indexOf('rota_definida')));
  });

  it('roteamento_validado grava somente a decisão determinística classificada', async () => {
    const e = await registrarEvento(
      db.pool,
      novo('roteamento_validado', {
        resultadoEsperado: 'interface',
        categoria: 'gestores',
        categoriaSugerida: 'd11',
        decisao: 'aguardar_humano',
        motivo: 'categoria_incompativel',
      }),
    );
    expect(e).toMatchObject({ tipoEvento: 'roteamento_validado', resumo: 'Roteamento da demanda validado por regras.' });
    expect(e.metadata).toEqual({
      resultadoEsperado: 'interface',
      categoria: 'gestores',
      categoriaSugerida: 'd11',
      decisao: 'aguardar_humano',
      motivo: 'categoria_incompativel',
    });
  });

  it.each(CASOS)('$tipo: grava exatamente a metadata do schema, com o resumo fixo', async (c) => {
    const metadata = c.metadata();
    const e = await registrarEvento(db.pool, doCaso(c));
    expect(e).toMatchObject({ tipoEvento: c.tipo, resumo: c.resumo, schemaVersao: 1, tarefaId: c.comTarefa ? tarefaId : null });
    expect(e.metadata).toEqual(metadata);
  });

  describe('coluna tarefa_id', () => {
    it.each(CASOS.filter((c) => c.comTarefa))('$tipo sem tarefaId é recusado antes de qualquer escrita', async (c) => {
      const antes = await totalDeEventos();
      await expect(registrarEvento(db.pool, doCaso(c, {}, { tarefaId: null }))).rejects.toThrow(`O evento ${c.tipo} exige tarefaId.`);
      expect(await totalDeEventos()).toBe(antes);
    });

    it.each([
      'rota_definida',
      'plano_ativado',
      'plano_retomado',
      'plano_abandonado',
      'plano_concluido',
      'fallback_legado',
      'custo_adicional_autorizado',
    ] as const)('%s não leva tarefaId', async (tipo) => {
      await expect(registrarEvento(db.pool, doCaso(caso(tipo), {}, { tarefaId }))).rejects.toThrow(`O evento ${tipo} não leva tarefaId.`);
    });

    it('os tipos anteriores à Fase 3.2 continuam sem tarefa', async () => {
      await expect(registrarEvento(db.pool, novo('processamento_iniciado', {}, { tarefaId }))).rejects.toThrow(
        'O evento processamento_iniciado não leva tarefaId.',
      );
      const plano = { planoId: p.planoId, versao: 1, modo: 'execucao', totalTarefas: 2, totalDependencias: 1 };
      await expect(registrarEvento(db.pool, novo('plano_registrado', plano, { tarefaId }))).rejects.toThrow(
        'O evento plano_registrado não leva tarefaId.',
      );
    });

    it('custo e entrega aceitam a tarefa como opcional', async () => {
      for (const tipo of ['custo_demanda_excedido', 'custo_acima_da_reserva', 'gasto_retido_reconhecido'] as const) {
        expect(await registrarEvento(db.pool, doCaso(caso(tipo), {}, { tarefaId }))).toMatchObject({ tipoEvento: tipo, tarefaId });
      }
      const entrega = { entregaId: ENTREGA_ID, tipo: 'html', publicadaComoHtml: true };
      expect(await registrarEvento(db.pool, novo('entrega_criada', entrega, { tarefaId }))).toMatchObject({ tarefaId, resumo: 'Entrega criada.' });
      expect(await registrarEvento(db.pool, novo('entrega_criada', entrega))).toMatchObject({ tarefaId: null });
    });

    it('tarefaId precisa ser o uuid de uma tarefa da mesma demanda', async () => {
      const antes = await totalDeEventos();
      const selecao = caso('agente_selecionado');
      await expect(registrarEvento(db.pool, doCaso(selecao, {}, { tarefaId: 'analise' }))).rejects.toThrow('tarefaId precisa ser um uuid.');
      await expect(registrarEvento(db.pool, doCaso(selecao, {}, { tarefaId: randomUUID() }))).rejects.toThrow(
        'agent_events: a tarefa precisa ser da mesma demanda do evento',
      );
      expect(await totalDeEventos()).toBe(antes);
    });
  });

  describe('tarefa_falhou', () => {
    const falha = (m: Record<string, unknown>): Record<string, unknown> => ({
      claimId,
      tipo: 'especialista',
      tentativa: 1,
      codigoErro: 'llm_api',
      definitiva: false,
      ...m,
    });

    it('contexto_excedido: anterior ao claim, com claimId nulo, tentativa 0, ator sistema e sempre definitiva', async () => {
      const e = await registrarEvento(
        db.pool,
        novo('tarefa_falhou', falha({ claimId: null, tentativa: 0, codigoErro: 'contexto_excedido', definitiva: true }), { tarefaId }),
      );
      expect(e).toMatchObject({ ator: ATOR_SISTEMA, tarefaId, metadata: { claimId: null, tentativa: 0, codigoErro: 'contexto_excedido' } });
    });

    it('recusa as combinações incoerentes sem gravar nada', async () => {
      const antes = await totalDeEventos();
      const recusa = (m: Record<string, unknown>, ator: string, erro: RegExp | string) =>
        expect(registrarEvento(db.pool, novo('tarefa_falhou', falha(m), { tarefaId, ator }))).rejects.toThrow(erro);
      // claimId é nulo exatamente em contexto_excedido.
      await recusa({ codigoErro: 'contexto_excedido', definitiva: true }, ATOR_SISTEMA, /claimId é nulo exatamente em contexto_excedido/);
      await recusa({ claimId: null }, 'frota:architect', /claimId é nulo exatamente em contexto_excedido/);
      // contexto_excedido é sempre definitiva.
      await recusa(
        { claimId: null, tentativa: 0, codigoErro: 'contexto_excedido', definitiva: false },
        ATOR_SISTEMA,
        /contexto_excedido é sempre definitiva/,
      );
      // O ator é "sistema" exatamente em contexto_excedido.
      const ator = 'tarefa_falhou: o ator é "sistema" exatamente em contexto_excedido.';
      await recusa({ claimId: null, tentativa: 0, codigoErro: 'contexto_excedido', definitiva: true }, 'frota:architect', ator);
      await recusa({}, ATOR_SISTEMA, ator);
      // Só os códigos com que uma tarefa falha (os mesmos do CHECK tarefas_codigo_erro_check).
      await recusa({ codigoErro: 'frota_pausada' }, 'frota:architect', /codigoErro/);
      await recusa({ codigoErro: 'custo_demanda_excedido' }, 'frota:architect', /codigoErro/);
      expect(await totalDeEventos()).toBe(antes);
    });
  });

  it('politica_avaliada: claimId vem junto com tarefaId, e só com ele', async () => {
    const avaliacao = { estagio: 'pre', decisao: 'allow', politicaId: null, regraId: null, versaoRegra: null, operacao: 'execucao' };
    const e = await registrarEvento(db.pool, novo('politica_avaliada', { ...avaliacao, claimId }, { tarefaId }));
    expect(e).toMatchObject({ tarefaId, metadata: { claimId, operacao: 'execucao' } });

    const erro = 'politica_avaliada: claimId vem junto com tarefaId, e só com ele.';
    await expect(registrarEvento(db.pool, novo('politica_avaliada', avaliacao, { tarefaId }))).rejects.toThrow(erro);
    await expect(registrarEvento(db.pool, novo('politica_avaliada', { ...avaliacao, claimId }))).rejects.toThrow(erro);
    // A operação do evento não inclui auditoria: a avaliação por tarefa é de execução ou de integração.
    await expect(registrarEvento(db.pool, novo('politica_avaliada', { ...avaliacao, operacao: 'auditoria' }))).rejects.toThrow();

    // A avaliação legada (sem operação e sem tarefa) continua igual.
    const legada = { estagio: 'post', decisao: 'warn', politicaId: randomUUID(), regraId: randomUUID(), versaoRegra: 1 };
    expect(await registrarEvento(db.pool, novo('politica_avaliada', legada))).toMatchObject({ tarefaId: null, metadata: legada });
  });

  it('dólar é número com até 6 casas, não negativo e até 1 milhão', async () => {
    const autorizacao = (valorUsd: unknown) => novo('custo_adicional_autorizado', { valorUsd, limiteAnteriorUsd: 2, limiteNovoUsd: 3.5 });
    const antes = await totalDeEventos();
    await expect(registrarEvento(db.pool, autorizacao(0.1 + 0.2))).rejects.toThrow(/mais de 6 casas decimais/);
    for (const valor of [-0.5, '1.50', 1_000_000.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      await expect(registrarEvento(db.pool, autorizacao(valor))).rejects.toThrow();
    }
    expect(await totalDeEventos()).toBe(antes);
    expect((await registrarEvento(db.pool, autorizacao(0.123456))).metadata).toMatchObject({ valorUsd: 0.123456 });
    expect((await registrarEvento(db.pool, autorizacao(1_000_000))).metadata).toMatchObject({ valorUsd: 1_000_000 });
    expect((await registrarEvento(db.pool, autorizacao(0))).metadata).toMatchObject({ valorUsd: 0 });
  });

  it('recusa campos fora do schema: lease, chave e objetivo da tarefa, resumo do artefato, texto de erro', async () => {
    const antes = await totalDeEventos();
    await expect(registrarEvento(db.pool, doCaso(caso('tarefa_iniciada'), { leaseToken }))).rejects.toThrow();
    await expect(registrarEvento(db.pool, doCaso(caso('agente_selecionado'), { chave: 'analise' }))).rejects.toThrow();
    await expect(registrarEvento(db.pool, doCaso(caso('plano_ativado'), { objetivo: 'Objetivo da tarefa analise' }))).rejects.toThrow();
    await expect(registrarEvento(db.pool, doCaso(caso('tarefa_concluida'), { resumo: 'Resumo do resultado.' }))).rejects.toThrow();
    await expect(registrarEvento(db.pool, doCaso(caso('tarefa_falhou'), { mensagem: 'erro do modelo' }))).rejects.toThrow();
    await expect(registrarEvento(db.pool, doCaso(caso('custo_acima_da_reserva'), { prompt: 'texto' }))).rejects.toThrow();
    expect(await totalDeEventos()).toBe(antes);
  });

  it('plano_registrado tem um resumo fixo por modo', async () => {
    const plano = (modo: string) => ({ planoId: p.planoId, versao: 1, modo, totalTarefas: 2, totalDependencias: 1 });
    expect((await registrarEvento(db.pool, novo('plano_registrado', plano('execucao')))).resumo).toBe(
      'Plano de tarefas registrado para execução.',
    );
    expect((await registrarEvento(db.pool, novo('plano_registrado', plano('shadow')))).resumo).toBe(
      'Plano de tarefas registrado (modo planejar — não executa).',
    );
    await expect(registrarEvento(db.pool, novo('plano_registrado', plano('executar')))).rejects.toThrow();
  });

  it('os vocabulários são fechados, e os valores novos entram nos antigos', async () => {
    const antes = await totalDeEventos();
    const recusado = (tipo: TipoEvento, metadata: Record<string, unknown>, extra: Partial<NovoEvento> = {}) =>
      expect(registrarEvento(db.pool, novo(tipo, metadata, extra))).rejects.toThrow();
    await recusado('rota_definida', { rota: 'outra', motivoRota: 'categoria_ligada' });
    await recusado('rota_definida', { rota: 'tarefas', motivoRota: 'porque_sim' });
    await recusado('fallback_legado', { planoId: null, motivoFallback: 'orquestracao_desligada', codigoErro: null });
    await recusado('plano_abandonado', { planoId: p.planoId, versao: 1, motivoAbandono: 'ciclo', tarefasCanceladas: 0 });
    await recusado('tarefa_devolvida', { claimId, codigoErro: 'llm_api' }, { tarefaId });
    await recusado('tarefa_resultado_descartado', { claimId, tentativa: 1, motivoDescarte: 'duplicado' }, { tarefaId });
    await recusado('tarefa_lease_expirado', { claimId, tentativa: 1, enviada: true, destino: 'cancelada' }, { tarefaId });
    // O auditor (d17) não é capacidade de tarefa; a chave do agente tem formato fechado.
    await recusado('agente_selecionado', { claimId, agente: 'frota:agent-evaluator', versaoAgente: 1, capacidade: 'd17' }, { tarefaId });
    await recusado('agente_selecionado', { claimId, agente: 'Frota Architect', versaoAgente: 1, capacidade: 'd1' }, { tarefaId });
    const inicio = { claimId, tipo: 'especialista', tentativa: 1, maxTentativas: 2, artefatosIntegrais: 0, artefatosSoResumo: 0, conversaOmitida: 0 };
    await recusado('tarefa_iniciada', { ...inicio, tentativa: 0 }, { tarefaId });
    await recusado('tarefa_iniciada', { ...inicio, maxTentativas: 4 }, { tarefaId });
    await recusado('tarefa_iniciada', { ...inicio, tipo: 'coordenacao' }, { tarefaId });
    await recusado('gasto_retido_reconhecido', { valorUsd: 0.05, operacao: 'outra' });
    expect(await totalDeEventos()).toBe(antes);

    const aceito = async (tipo: TipoEvento, metadata: Record<string, unknown>) =>
      expect((await registrarEvento(db.pool, novo(tipo, metadata))).metadata).toEqual(metadata);
    await aceito('plano_rejeitado', { planoId: p.planoId, versao: 2, motivoRejeicao: 'objetivo_invalido' });
    await aceito('plano_abandonado', { planoId: p.planoId, versao: 1, motivoAbandono: 'orquestracao_desligada', tarefasCanceladas: 0 });
    await aceito('demanda_devolvida_para_fila', { motivoDevolucao: 'prazo_da_run', codigoErro: 'prazo_da_run' });
    await aceito('chamada_trabalho_falhou', { codigoErro: 'llm_timeout' });
    await aceito('rota_definida', { rota: 'legado_fixo', motivoRota: 'rota_fixada' });
  });

  // Por último: depois de todos os casos acima, nada do que é texto ou segredo da tarefa chegou ao ledger.
  it('o ledger não guarda objetivo, chave ou lease_token da tarefa', async () => {
    const eventos = JSON.stringify(await listarEventosDaDemanda(db.pool, p.demandaId));
    expect(eventos).toContain(claimId);
    expect(eventos).not.toContain(leaseToken);
    expect(eventos).not.toContain('Objetivo da tarefa');
    expect(eventos).not.toContain('analise');
  });
});