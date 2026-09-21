import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { criarDemanda, obterDemanda } from '../../src/db/demandas.ts';
import { listarMensagens } from '../../src/db/mensagens.ts';
import { pausarFrota, ultimaRun } from '../../src/db/operacao.ts';
import { listarRelatorios } from '../../src/db/relatorios.ts';
import { LlmError } from '../../src/llm/llm.ts';
import { OrcamentoExcedidoError } from '../../src/llm/orcamento.ts';
import { processarFila, type DependenciasFila } from '../../src/orchestrator/processar-fila.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, NotificadorMemoria, USO_PADRAO } from '../helpers/fakes.ts';

const PAPEL_AUDITOR = 'frota:agent-evaluator';

const execucao = {
  plano: 'Entregar análise',
  nivelComplexidade: 2,
  setoresEnvolvidos: ['d1'],
  acaoHumana: null,
  insumoCritico: null,
  entrega: { tipo: 'texto', titulo: 'Análise', conteudo: 'Conteúdo' },
  resumo: 'Feito',
  fontesUtilizadas: 'briefing',
  autoavaliacao: 80,
  ganhos: 'g',
  perdas: 'p',
  aprendizado: 'a',
  ponderacoes: [],
};
const auditoria = { violacoes: [], observacoes: '' };
const respostaNormal = (p: { papel: string }) => (p.papel === PAPEL_AUDITOR ? auditoria : execucao);

describe('processarFila', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs, aprendizado_evolucao CASCADE');
    await db.pool.query("UPDATE system_flags SET pausado = false, pausado_motivo = NULL, alertas_enviados = '{}'");
  });

  function montar(responder: ConstructorParameters<typeof LlmFalso>[0] = respostaNormal, max = 3) {
    const llm = new LlmFalso(responder, USO_PADRAO);
    const notificador = new NotificadorMemoria();
    const deps: DependenciasFila = {
      pool: db.pool,
      llm,
      modeloTrabalho: 'claude-sonnet-5',
      modeloAuditoria: 'claude-sonnet-5',
      urlBase: 'https://frota.exemplo.com',
      notificador,
      maxDemandasPorRun: max,
      minutosAbandono: 60,
    };
    return { deps, llm, notificador };
  }
  async function criarComIdade(titulo: string, minutosAtras: number): Promise<string> {
    const d = await criarDemanda(db.pool, { titulo, categoria: 'd1' });
    await db.pool.query('UPDATE demandas SET criado_em = now() - make_interval(mins => $2::int) WHERE id = $1', [
      d.id,
      minutosAtras,
    ]);
    return d.id;
  }

  it('fila vazia: registra a run, nao chama o modelo e nao notifica', async () => {
    const { deps, llm, notificador } = montar();

    const resumo = await processarFila(deps);

    expect(resumo).toMatchObject({ status: 'ok', processadas: [], falhas: [] });
    expect(llm.pedidos).toHaveLength(0);
    expect(notificador.enviadas).toEqual([]);
    expect(await ultimaRun(db.pool)).toMatchObject({ status: 'ok', demandasProcessadas: 0, gatilho: 'cron' });
  });

  it('processa as mais antigas ate o limite por run e notifica o resumo', async () => {
    const ids = [
      await criarComIdade('quarta', 10),
      await criarComIdade('primeira', 50),
      await criarComIdade('quinta', 5),
      await criarComIdade('segunda', 40),
      await criarComIdade('terceira', 30),
    ];
    const { deps, notificador } = montar(respostaNormal, 3);

    const resumo = await processarFila(deps);

    expect(resumo.processadas.map((r) => r.titulo)).toEqual(['primeira', 'segunda', 'terceira']);
    const estados = await Promise.all(ids.map((id) => obterDemanda(db.pool, id)));
    expect(estados.filter((d) => d?.status === 'Concluída')).toHaveLength(3);
    expect(estados.filter((d) => d?.status === 'Nova')).toHaveLength(2);
    expect(await ultimaRun(db.pool)).toMatchObject({ status: 'ok', demandasProcessadas: 3 });
    expect(notificador.enviadas).toHaveLength(1);
    expect(notificador.enviadas[0]).toMatchObject({ nivel: 'info', titulo: 'Frota: 3 demanda(s) processada(s)' });
    for (const titulo of ['primeira', 'segunda', 'terceira']) expect(notificador.enviadas[0]?.corpo).toContain(titulo);
    expect(notificador.enviadas[0]?.corpo).toContain('https://frota.exemplo.com/entregas/');
  });

  it('frota pausada: nao chama o modelo e deixa as demandas na fila', async () => {
    await criarComIdade('espera', 5);
    await pausarFrota(db.pool, 'manutencao');
    const { deps, llm } = montar();

    const resumo = await processarFila(deps);

    expect(resumo.status).toBe('pausada');
    expect(llm.pedidos).toHaveLength(0);
    expect(await ultimaRun(db.pool)).toMatchObject({ status: 'pausada' });
    const { rows } = await db.pool.query("SELECT status FROM demandas WHERE titulo = 'espera'");
    expect(rows[0]).toEqual({ status: 'Nova' });
  });

  it('orcamento estoura no meio da run: conclui o que deu, devolve o resto sem penalizar e avisa', async () => {
    const primeira = await criarComIdade('primeira', 30);
    const segunda = await criarComIdade('segunda', 20);
    const terceira = await criarComIdade('terceira', 10);
    // chamadas 0 e 1: execucao e auditoria da primeira; chamada 2: execucao da segunda
    const { deps, notificador } = montar((p, i) => (i === 2 ? new OrcamentoExcedidoError(10, 10) : respostaNormal(p)));

    const resumo = await processarFila(deps);

    expect(resumo.status).toBe('pausada');
    expect(resumo.processadas).toHaveLength(1);
    expect(resumo.interrompidaPor).toContain('Orçamento mensal esgotado');
    expect((await obterDemanda(db.pool, primeira))?.status).toBe('Concluída');
    expect(await obterDemanda(db.pool, segunda)).toMatchObject({ status: 'Nova', tentativas: 0, claimedByRun: null });
    expect(await obterDemanda(db.pool, terceira)).toMatchObject({ status: 'Nova', tentativas: 0 });
    expect(notificador.enviadas[0]).toMatchObject({ nivel: 'aviso' });
    expect(notificador.enviadas[0]?.titulo).toContain('execução interrompida');
  });

  it('falha de API (529): devolve a demanda sem penalizar e interrompe a run', async () => {
    const primeira = await criarComIdade('primeira', 20);
    const segunda = await criarComIdade('segunda', 10);
    const { deps } = montar(() => new LlmError('api', 'sobrecarregado', null, 529));

    const resumo = await processarFila(deps);

    expect(resumo).toMatchObject({ status: 'erro', processadas: [], falhas: [] });
    expect(await obterDemanda(db.pool, primeira)).toMatchObject({ status: 'Nova', tentativas: 0 });
    expect(await obterDemanda(db.pool, segunda)).toMatchObject({ status: 'Nova', tentativas: 0 });
    expect(await ultimaRun(db.pool)).toMatchObject({ status: 'erro' });
  });

  it('resposta invalida da execucao: registra a falha, volta para a fila e vira Falhou na terceira tentativa', async () => {
    const id = await criarComIdade('problematica', 10);
    const { deps, notificador } = montar(() => new LlmError('invalido', 'A resposta do modelo fugiu do esquema esperado.', USO_PADRAO));

    await processarFila(deps);
    expect(await obterDemanda(db.pool, id)).toMatchObject({ status: 'Nova', tentativas: 1 });
    await processarFila(deps);
    expect(await obterDemanda(db.pool, id)).toMatchObject({ status: 'Nova', tentativas: 2 });
    const ultimo = await processarFila(deps);

    expect(await obterDemanda(db.pool, id)).toMatchObject({ status: 'Falhou', tentativas: 3 });
    expect(ultimo.falhas).toEqual([
      { titulo: 'problematica', motivo: 'A resposta do modelo fugiu do esquema esperado.', statusFinal: 'Falhou' },
    ]);
    const textos = (await listarMensagens(db.pool, id)).map((m) => m.texto);
    expect(textos.some((t) => t.includes('Falha ao processar (tentativa 1 de 3)'))).toBe(true);
    expect(textos.some((t) => t.includes('Limite de tentativas atingido.'))).toBe(true);
    expect(notificador.enviadas.at(-1)?.corpo).toContain('sem novas tentativas');

    // uma quarta run nao processa mais a demanda que falhou
    const { llm } = montar();
    await processarFila({ ...deps, llm });
    expect(llm.pedidos).toHaveLength(0);
  });

  it('erro inesperado nao vaza detalhes internos para a mensagem da demanda', async () => {
    const id = await criarComIdade('x', 10);
    const { deps } = montar(() => new Error('senha do banco: hunter2'));

    const resumo = await processarFila(deps);

    expect(resumo.falhas[0]?.motivo).toBe('Falha inesperada no processamento.');
    const textos = (await listarMensagens(db.pool, id)).map((m) => m.texto).join('\n');
    expect(textos).not.toContain('hunter2');
  });

  it('recupera uma demanda abandonada por uma run que morreu e a processa', async () => {
    const id = await criarComIdade('abandonada', 200);
    await db.pool.query(
      "UPDATE demandas SET status = 'Em andamento', claimed_at = now() - interval '2 hours', tentativas = 1 WHERE id = $1",
      [id],
    );
    const { deps } = montar();

    const resumo = await processarFila(deps);

    expect(resumo.processadas.map((r) => r.titulo)).toEqual(['abandonada']);
    expect((await obterDemanda(db.pool, id))?.status).toBe('Concluída');
  });

  it('duas runs simultaneas nunca processam a mesma demanda', async () => {
    for (let i = 0; i < 4; i++) await criarComIdade(`d${i}`, 40 - i);
    const { deps, llm } = montar(respostaNormal, 3);

    await Promise.all([processarFila(deps), processarFila(deps)]);

    const execucoes = llm.pedidos.filter((p) => p.papel !== PAPEL_AUDITOR);
    expect(execucoes).toHaveLength(4);
    expect(new Set(execucoes.map((p) => p.contexto?.demandaId)).size).toBe(4);
    expect(await listarRelatorios(db.pool)).toHaveLength(4);
  });

  it('registra o gatilho manual', async () => {
    const { deps } = montar();
    await processarFila(deps, 'manual');
    expect(await ultimaRun(db.pool)).toMatchObject({ gatilho: 'manual' });
  });

  it('uma falha ao notificar nao derruba a run nem desfaz o trabalho', async () => {
    const id = await criarComIdade('y', 10);
    const { deps } = montar();
    const notificar = vi.fn(async () => Promise.reject(new Error('sem rede')));

    const resumo = await processarFila({ ...deps, notificador: { notificar } });

    expect(notificar).toHaveBeenCalledTimes(1);
    expect(resumo.processadas).toHaveLength(1);
    expect((await obterDemanda(db.pool, id))?.status).toBe('Concluída');
    expect(await ultimaRun(db.pool)).toMatchObject({ status: 'ok' });
  });

  it('erro 400 da API e culpa da demanda: penaliza so ela e segue com as demais, sem travar a fila', async () => {
    const problematica = await criarComIdade('problematica', 30);
    const saudavel = await criarComIdade('saudavel', 10);
    const { deps } = montar((p, i) => (i === 0 ? new LlmError('api', 'Falha na API (400): prompt inválido', null, 400) : respostaNormal(p)));

    const resumo = await processarFila(deps);

    expect(resumo.status).toBe('ok');
    expect(resumo.falhas).toHaveLength(1);
    expect(resumo.processadas.map((r) => r.titulo)).toEqual(['saudavel']);
    expect(await obterDemanda(db.pool, problematica)).toMatchObject({ status: 'Nova', tentativas: 1 });
    expect((await obterDemanda(db.pool, saudavel))?.status).toBe('Concluída');
  });

  it('orcamento esgotado na auditoria: registra a demanda concluida, para a run e devolve as demais sem tocar nelas', async () => {
    const primeira = await criarComIdade('primeira', 30);
    const segunda = await criarComIdade('segunda', 20);
    // chamada 0: execucao da primeira; chamada 1: auditoria da primeira
    const { deps, llm, notificador } = montar((p, i) => (i === 1 ? new OrcamentoExcedidoError(10, 10) : respostaNormal(p)));

    const resumo = await processarFila(deps);

    expect(resumo.status).toBe('pausada');
    expect(resumo.processadas.map((r) => r.statusFinal)).toEqual(['Concluída']);
    expect(await obterDemanda(db.pool, primeira)).toMatchObject({ status: 'Concluída', tentativas: 1 });
    expect(await obterDemanda(db.pool, segunda)).toMatchObject({ status: 'Nova', tentativas: 0 });
    expect(llm.pedidos.filter((p) => p.papel !== PAPEL_AUDITOR)).toHaveLength(1);
    expect(notificador.enviadas[0]?.titulo).toContain('execução interrompida');
  });

  it('explica na linha do tempo a demanda recuperada pelo vigia, inclusive quando ela vira Falhou', async () => {
    const recuperavel = await criarComIdade('recuperavel', 200);
    const semChance = await criarComIdade('sem-chance', 200);
    await db.pool.query(
      "UPDATE demandas SET status = 'Em andamento', claimed_at = now() - interval '5 hours', tentativas = 1 WHERE id = $1",
      [recuperavel],
    );
    await db.pool.query(
      "UPDATE demandas SET status = 'Em andamento', claimed_at = now() - interval '5 hours', tentativas = 3 WHERE id = $1",
      [semChance],
    );
    await pausarFrota(db.pool, 'so recuperar');
    const { deps } = montar();

    await processarFila(deps);

    const textos = async (id: string) => (await listarMensagens(db.pool, id)).map((m) => m.texto).join('\n');
    expect(await textos(recuperavel)).toContain('voltou para a fila');
    expect(await textos(semChance)).toContain('marcada como Falhou');
  });
});
