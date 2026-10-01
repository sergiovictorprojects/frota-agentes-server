import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarDemanda, obterDemanda, reabrirDemanda } from '../../src/db/demandas.ts';
import { listarEventosDaDemanda } from '../../src/db/eventos.ts';
import { iniciarRun, pausarFrota } from '../../src/db/operacao.ts';
import { LlmError } from '../../src/llm/llm.ts';
import { OrcamentoExcedidoError } from '../../src/llm/orcamento.ts';
import { processarFila, type DependenciasFila } from '../../src/orchestrator/processar-fila.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { LlmFalso, NotificadorMemoria, USO_PADRAO } from '../helpers/fakes.ts';

const PAPEL_AUDITOR = 'frota:agent-evaluator';
const SEGREDO = 'CONTEUDO_INTEGRAL_DA_ENTREGA_NAO_PODE_VAZAR_NO_LEDGER';

const execucao = {
  plano: `Plano com um segredo: ${SEGREDO}`,
  nivelComplexidade: 2,
  setoresEnvolvidos: ['d1'],
  acaoHumana: null,
  insumoCritico: null,
  entrega: { tipo: 'texto', titulo: 'Análise', conteudo: `Conteúdo com um segredo: ${SEGREDO}` },
  resumo: 'Feito',
  fontesUtilizadas: 'briefing',
  autoavaliacao: 80,
  ganhos: 'g',
  perdas: 'p',
  aprendizado: 'a',
  ponderacoes: [],
};
const auditoriaLimpa = { violacoes: [], observacoes: '' };
const respostaNormal = (p: { papel: string }) => (p.papel === PAPEL_AUDITOR ? auditoriaLimpa : execucao);

describe('ledger de eventos no fluxo real (processarFila)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE demandas, runs CASCADE');
  });

  function montar(responder: ConstructorParameters<typeof LlmFalso>[0] = respostaNormal, max = 3): DependenciasFila {
    return {
      pool: db.pool,
      llm: new LlmFalso(responder, USO_PADRAO),
      modeloTrabalho: 'claude-sonnet-5',
      modeloAuditoria: 'claude-sonnet-5',
      urlBase: 'https://frota.minhaempresa.com.br',
      notificador: new NotificadorMemoria(),
      maxDemandasPorRun: max,
      minutosAbandono: 60,
    };
  }

  it('demanda concluida grava a sequencia completa de eventos, na ordem certa, numa unica tentativa', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Simples', categoria: 'd1' });
    await processarFila(montar());

    const eventos = await listarEventosDaDemanda(db.pool, d.id);

    expect(eventos.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'entrega_criada',
      'politica_avaliada',
      'auditoria_concluida',
      'demanda_concluida',
      'politica_avaliada',
    ]);
    expect(eventos.map((e) => e.sequenciaDemanda)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // demanda_reivindicada não prova execução: tentativa é null. Os demais, sim: tentativa 1.
    expect(eventos[0]!.tentativa).toBeNull();
    expect(eventos.slice(1).every((e) => e.tentativa === 1)).toBe(true);
    expect(eventos.every((e) => e.demandaId === d.id)).toBe(true);
    expect(new Set(eventos.map((e) => e.runId)).size).toBe(1);
  });

  it('nunca grava titulo, plano, conteudo de entrega nem texto bruto do modelo no ledger', async () => {
    const d = await criarDemanda(db.pool, { titulo: `Com segredo ${SEGREDO}`, categoria: 'd1' });
    await processarFila(montar());

    const eventos = await listarEventosDaDemanda(db.pool, d.id);
    const serializado = JSON.stringify(eventos);
    expect(serializado).not.toContain(SEGREDO);
  });

  it('nunca grava motivo/descricao de pendencia nem mensagem bruta de erro no ledger', async () => {
    const dPendencia = await criarDemanda(db.pool, { titulo: 'Precisa de humano', categoria: 'd1' });
    const motivoSegredo = `Exige pagamento — ${SEGREDO}`;
    await processarFila(
      montar((p) =>
        p.papel === PAPEL_AUDITOR
          ? auditoriaLimpa
          : { ...execucao, plano: 'plano normal', acaoHumana: { motivo: motivoSegredo, acoesNecessarias: ['aprovar'] }, entrega: null },
      ),
    );

    const dErro = await criarDemanda(db.pool, { titulo: 'Falha com mensagem sensivel', categoria: 'd1' });
    await processarFila(montar(() => new LlmError('invalido', `Resposta inválida — ${SEGREDO}`, USO_PADRAO)));

    const eventosPendencia = await listarEventosDaDemanda(db.pool, dPendencia.id);
    const eventosErro = await listarEventosDaDemanda(db.pool, dErro.id);
    expect(JSON.stringify(eventosPendencia)).not.toContain(SEGREDO);
    expect(JSON.stringify(eventosErro)).not.toContain(SEGREDO);
  });

  it('retry entre execucoes: cada tentativa fica com seu proprio numero, sem colisao de idempotencia', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Falha e tenta de novo', categoria: 'd1' });
    const deps = montar(() => new LlmError('invalido', 'A resposta do modelo fugiu do esquema esperado.', USO_PADRAO));

    await processarFila(deps); // tentativa 1: falha, volta para Nova
    await processarFila(deps); // tentativa 2: falha, volta para Nova
    await processarFila(deps); // tentativa 3: falha, MAX_TENTATIVAS atingido -> Falhou

    const eventos = await listarEventosDaDemanda(db.pool, d.id);
    const porTentativa = new Map<number | null, string[]>();
    for (const e of eventos) porTentativa.set(e.tentativa, [...(porTentativa.get(e.tentativa) ?? []), e.tipoEvento]);

    // demanda_reivindicada (tentativa null) das 3 rodadas se acumula sob a mesma chave: 3 delas.
    expect(porTentativa.get(null)).toEqual(['demanda_reivindicada', 'demanda_reivindicada', 'demanda_reivindicada']);
    expect(porTentativa.get(1)).toEqual([
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_falhou',
      'demanda_devolvida_para_fila',
    ]);
    expect(porTentativa.get(2)).toEqual([
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_falhou',
      'demanda_devolvida_para_fila',
    ]);
    expect(porTentativa.get(3)).toEqual(['processamento_iniciado', 'roteamento_validado', 'politica_avaliada', 'chamada_trabalho_falhou', 'demanda_falhou']);
    // 3 reivindicações + 15 eventos com tentativa, nenhum descartado como "duplicata" de outra tentativa.
    expect(eventos).toHaveLength(18);
  });

  it('pendencia humana registra o evento certo e para antes de entrega/auditoria', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Precisa de humano', categoria: 'd1' });
    const deps = montar((p) =>
      p.papel === PAPEL_AUDITOR ? auditoriaLimpa : { ...execucao, acaoHumana: { motivo: 'Exige pagamento', acoesNecessarias: ['aprovar'] }, entrega: null },
    );

    await processarFila(deps);

    const tipos = (await listarEventosDaDemanda(db.pool, d.id)).map((e) => e.tipoEvento);
    expect(tipos).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'pendencia_humana_registrada',
      'politica_avaliada',
    ]);
  });

  it('auditoria interrompida por orcamento: registra o trabalho pago e a interrupcao, sem perder o evento de conclusao', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Orcamento estoura na auditoria', categoria: 'd1' });
    const deps = montar((p) => (p.papel === PAPEL_AUDITOR ? new OrcamentoExcedidoError(10, 10) : execucao));

    await processarFila(deps);

    const eventos = await listarEventosDaDemanda(db.pool, d.id);
    expect(eventos.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'entrega_criada',
      'politica_avaliada',
      'auditoria_interrompida',
      'demanda_concluida',
      'politica_avaliada',
    ]);
    const interrompida = eventos.find((e) => e.tipoEvento === 'auditoria_interrompida')!;
    expect(interrompida.metadata).toEqual({ codigoErro: 'orcamento_excedido' });
  });

  it('demanda reaberta apos alternativa B (pedido de insumo): a segunda tentativa reusa o numero 1, mas nao colide com a primeira', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Falta insumo', categoria: 'd1' });
    const semInsumo = montar((p) => (p.papel === PAPEL_AUDITOR ? auditoriaLimpa : { ...execucao, insumoCritico: { descricao: 'falta a imagem', alternativa: 'B' }, entrega: null }));
    await processarFila(semInsumo);

    const primeiraLeva = await listarEventosDaDemanda(db.pool, d.id);
    expect(primeiraLeva.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'pendencia_insumo_registrada',
      'politica_avaliada',
    ]);
    expect(primeiraLeva.slice(1).every((e) => e.tentativa === 1)).toBe(true);

    // "Aguardando insumo" so volta para a fila quando o solicitante responde (reabrirDemanda), como a
    // rota HTTP /responder faz. reabrirDemanda zera tentativas, entao a proxima execucao TAMBEM e
    // tentativa 1 — o mesmo numero da primeira leva, em runs diferentes.
    await reabrirDemanda(db.pool, d.id);
    await processarFila(montar());

    const todos = await listarEventosDaDemanda(db.pool, d.id);
    expect(todos).toHaveLength(7 + 10); // nada da primeira leva foi perdido nem sobrescrito
    const segundaLeva = todos.slice(7);
    expect(segundaLeva.slice(1).every((e) => e.tentativa === 1)).toBe(true);
    expect(segundaLeva.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'entrega_criada',
      'politica_avaliada',
      'auditoria_concluida',
      'demanda_concluida',
      'politica_avaliada',
    ]);
    // mesma tentativa (1) nas duas levas, mas runId (correlacaoId) diferente — é isso que impede a colisão.
    expect(primeiraLeva[0]!.runId).not.toBe(segundaLeva[0]!.runId);
  });

  it('interrupcao sistemica seguida de reprocessamento: tentativas pode coincidir entre runs, sem apagar eventos', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Orcamento estoura na execucao', categoria: 'd1' });
    // Falha sistemica na PRÓPRIA chamada de execução (não na auditoria): propaga para processar-fila.ts,
    // que chama devolverParaFila(..., true) e DECREMENTA tentativas de 1 para 0.
    const falhaNaExecucao = montar(() => new OrcamentoExcedidoError(10, 10));
    await processarFila(falhaNaExecucao);

    const primeiraLeva = await listarEventosDaDemanda(db.pool, d.id);
    expect(primeiraLeva.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_falhou',
      'demanda_devolvida_para_fila',
    ]);
    expect(primeiraLeva.slice(1).every((e) => e.tentativa === 1)).toBe(true);

    // tentativas voltou a 0 (devolverParaFila com desfazerTentativa=true): a proxima execução também
    // começa como tentativa 1 — mesmo número da leva anterior, mas numa run nova.
    await processarFila(montar());

    const todos = await listarEventosDaDemanda(db.pool, d.id);
    expect(todos).toHaveLength(6 + 10);
    const segundaLeva = todos.slice(6);
    expect(segundaLeva.slice(1).every((e) => e.tentativa === 1)).toBe(true);
    expect(segundaLeva.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'entrega_criada',
      'politica_avaliada',
      'auditoria_concluida',
      'demanda_concluida',
      'politica_avaliada',
    ]);
    expect(primeiraLeva[0]!.runId).not.toBe(segundaLeva[0]!.runId);
    expect(todos.filter((e) => e.tipoEvento === 'demanda_concluida')).toHaveLength(1);
  });

  it('primeira demanda interrompe a run; a segunda e devolvida a fila sem nunca ter iniciado (tentativa null)', async () => {
    // Duas demandas no mesmo lote: a primeira sofre parada sistêmica DURANTE a execução (chama
    // processarDemanda, que já rodou registrarTentativa); a segunda nunca chega a ser processada —
    // processarLote vê resumo.interrompidaPor setado e devolve sem chamar processarDemanda.
    const primeira = await criarDemanda(db.pool, { titulo: 'Interrompe a run', categoria: 'd1' });
    const segunda = await criarDemanda(db.pool, { titulo: 'Nunca comeca', categoria: 'd1' });
    // reivindicarDemandas ordena por criado_em: garante que "primeira" é processada antes de "segunda".

    const deps = montar(() => new OrcamentoExcedidoError(10, 10), 2);
    await processarFila(deps);

    const eventosPrimeira = await listarEventosDaDemanda(db.pool, primeira.id);
    expect(eventosPrimeira.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_falhou',
      'demanda_devolvida_para_fila',
    ]);
    // A primeira chegou a começar: registrarTentativa já rodou antes da falha.
    expect(eventosPrimeira.slice(1).every((e) => e.tentativa === 1)).toBe(true);

    const eventosSegunda = await listarEventosDaDemanda(db.pool, segunda.id);
    expect(eventosSegunda.map((e) => e.tipoEvento)).toEqual(['demanda_reivindicada', 'demanda_devolvida_para_fila']);
    // A segunda nunca chegou a começar: todo evento seu tem tentativa null, nunca um número.
    expect(eventosSegunda.every((e) => e.tentativa === null)).toBe(true);
    const devolucaoSegunda = eventosSegunda.find((e) => e.tipoEvento === 'demanda_devolvida_para_fila')!;
    expect(devolucaoSegunda.metadata).toMatchObject({ motivoDevolucao: 'nunca_iniciada' });
  });

  it('auditoria esgota as tentativas por LlmError (nao sistemico): registra auditoria_interrompida, sem vazar a mensagem do erro, e a demanda ainda conclui', async () => {
    const d = await criarDemanda(db.pool, { titulo: 'Auditor sempre erra', categoria: 'd1' });
    const mensagemSensivel = `A resposta do auditor fugiu do esquema — ${SEGREDO}`;
    const deps = montar((p) =>
      p.papel === PAPEL_AUDITOR ? new LlmError('invalido', mensagemSensivel, USO_PADRAO) : execucao,
    );

    await processarFila(deps);

    const eventos = await listarEventosDaDemanda(db.pool, d.id);
    expect(eventos.map((e) => e.tipoEvento)).toEqual([
      'demanda_reivindicada',
      'processamento_iniciado',
      'roteamento_validado',
      'politica_avaliada',
      'chamada_trabalho_concluida',
      'entrega_criada',
      'politica_avaliada',
      'auditoria_interrompida',
      'demanda_concluida',
      'politica_avaliada',
    ]);
    const interrompida = eventos.find((e) => e.tipoEvento === 'auditoria_interrompida')!;
    expect(interrompida.metadata).toEqual({ codigoErro: 'llm_invalido' });
    expect(JSON.stringify(eventos)).not.toContain(SEGREDO);

    const demandaFinal = await obterDemanda(db.pool, d.id);
    // não interrompeu a run: a demanda concluiu de verdade, só com métricas nulas.
    expect(demandaFinal?.status).toBe('Concluída');
  });

  it('watchdog (recuperarAbandonadas) registra evento real com codigoErro claim_expirado, sem texto bruto', async () => {
    const voltaParaFila = await criarDemanda(db.pool, { titulo: 'Presa, ainda pode tentar de novo', categoria: 'd1' });
    const vaiFalhar = await criarDemanda(db.pool, { titulo: 'Presa, ja no limite de tentativas', categoria: 'd1' });

    // Simula os dois casos que liberarDemandasAbandonadas trata: uma "Em andamento" presa há muito tempo
    // com tentativas abaixo do limite (volta para Nova) e outra já no limite (vai para Falhou).
    const runIdAntiga = await iniciarRun(db.pool);
    await db.pool.query(
      `UPDATE demandas SET status = 'Em andamento', claimed_by_run = $2, claimed_at = now() - interval '200 minutes',
                            tentativas = 1
        WHERE id = $1`,
      [voltaParaFila.id, runIdAntiga],
    );
    await db.pool.query(
      `UPDATE demandas SET status = 'Em andamento', claimed_by_run = $2, claimed_at = now() - interval '200 minutes',
                            tentativas = 3
        WHERE id = $1`,
      [vaiFalhar.id, runIdAntiga],
    );

    // Pausa a frota: o watchdog roda (recuperarAbandonadas é a primeira coisa que processarFila faz),
    // mas a run para logo depois, antes de reivindicar e processar a demanda que acabou de voltar para
    // "Nova" — senão ela seria processada de verdade nesta mesma run, o que não é o que este teste mede.
    await pausarFrota(db.pool, 'teste');
    await processarFila(montar());

    const eventosVolta = await listarEventosDaDemanda(db.pool, voltaParaFila.id);
    expect(eventosVolta.map((e) => e.tipoEvento)).toEqual(['demanda_devolvida_para_fila']);
    expect(eventosVolta[0]!.ator).toBe('sistema');
    expect(eventosVolta[0]!.tentativa).toBe(1);
    expect(eventosVolta[0]!.metadata).toEqual({ motivoDevolucao: 'watchdog', codigoErro: 'claim_expirado' });

    const eventosFalha = await listarEventosDaDemanda(db.pool, vaiFalhar.id);
    expect(eventosFalha.map((e) => e.tipoEvento)).toEqual(['demanda_falhou']);
    expect(eventosFalha[0]!.tentativa).toBe(3);
    expect(eventosFalha[0]!.metadata).toEqual({ codigoErro: 'claim_expirado' });

    expect(await obterDemanda(db.pool, voltaParaFila.id)).toMatchObject({ status: 'Nova' });
    expect(await obterDemanda(db.pool, vaiFalhar.id)).toMatchObject({ status: 'Falhou' });
  });
});