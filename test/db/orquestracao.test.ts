import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atualizarAgente } from '../../src/db/agentes.ts';
import { registrarPasso } from '../../src/db/operacao.ts';
import {
  AutorizacaoCustoSchema,
  autorizarCustoAdicional,
  bloquearPorCusto,
  cancelarReserva,
  criarEnvelope,
  fixarRotaLegado,
  liquidarReserva,
  obterEnvelope,
  reconhecerReserva,
  reservarCusto,
  reterReserva,
  reterReservasVencidas,
  situacaoDeCusto,
  type NovaReserva,
} from '../../src/db/orquestracao.ts';
import { comTransacao } from '../../src/db/tx.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import {
  contarPassos,
  demandaComEnvelope,
  esperar,
  novaDemanda,
  planoAtivoDeTeste,
  reivindicar,
  reivindicarEEnviar,
} from '../helpers/execucao.ts';

// Fase 3.2a: envelope da demanda, teto de custo, reservas e autorizações (migration 006, src/db/orquestracao.ts).
// Nada disso é chamado pelo fluxo real nesta entrega. Onde o ponto é o que o banco recusa, SQL direto.
describe('envelope, reservas e autorizacoes de custo (migration 006)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  const uso = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

  // Reserva sem tarefa (planejamento, auditoria...), pelo agente coordenador, com validade de 10 minutos.
  const reserva = (demandaId: string, valorReservadoUsd: string, extra: Partial<NovaReserva> = {}) =>
    reservarCusto(db.pool, {
      demandaId,
      operacao: 'planejamento',
      modelo: 'claude-sonnet-5',
      valorReservadoUsd,
      validadeSegundos: 600,
      agenteChave: 'frota:gestores',
      ...extra,
    });

  async function reservaAberta(demandaId: string, valor = '0.10', extra: Partial<NovaReserva> = {}): Promise<string> {
    const r = await reserva(demandaId, valor, extra);
    if (!r.reservada) throw new Error(`reserva de teste recusada: ${r.motivo}`);
    return r.reservaId;
  }

  const estadoDa = async (reservaId: string) =>
    (await db.pool.query<{ estado: string }>('SELECT estado FROM reservas_custo WHERE id = $1', [reservaId])).rows[0]!.estado;

  describe('envelope', () => {
    it('nasce na rota tarefas, sem bloqueio, com o teto base; criar de novo devolve o existente, com o teto de antes', async () => {
      const d = await novaDemanda(db.pool);
      const criado = await criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: '2' });
      expect(criado).toMatchObject({
        criado: true,
        envelope: { demandaId: d.demandaId, tetoBaseUsd: '2.00', rota: 'tarefas', motivoLegado: null, legadoFixadoEm: null, bloqueadaPorCusto: false, bloqueioCustoEm: null },
      });
      const deNovo = await criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: '5.00' });
      expect(deNovo).toEqual({ criado: false, envelope: criado.envelope });
      expect(await obterEnvelope(db.pool, randomUUID())).toBeNull();
    });

    it('o teto base vai de US$ 1,00 a 20,00 com ate 2 casas, no Zod e no banco', async () => {
      const d = await novaDemanda(db.pool);
      for (const teto of ['0.99', '20.01', '2.001', '-1', 'abc', '', '1e1']) {
        await expect(criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: teto }), teto).rejects.toThrow();
      }
      await expect(db.pool.query('INSERT INTO orquestracao_demandas (demanda_id, teto_base_usd) VALUES ($1, 0.50)', [d.demandaId])).rejects.toThrow(
        /orquestracao_demandas_teto_base_usd_check/,
      );
      expect((await criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: '20.00' })).envelope.tetoBaseUsd).toBe('20.00');
    });

    it('recusa nascer fora da rota tarefas ou bloqueado, mudar teto ou data e DELETE', async () => {
      const d = await novaDemanda(db.pool);
      const nasce = 'orquestracao_demandas: o envelope nasce com a rota tarefas e sem bloqueio';
      await expect(
        db.pool.query(
          "INSERT INTO orquestracao_demandas (demanda_id, teto_base_usd, rota, motivo_legado, legado_fixado_em) VALUES ($1, 2, 'legado_fixo', 'tarefa_falhou', now())",
          [d.demandaId],
        ),
      ).rejects.toThrow(nasce);
      await expect(
        db.pool.query('INSERT INTO orquestracao_demandas (demanda_id, teto_base_usd, bloqueada_por_custo, bloqueio_custo_em) VALUES ($1, 2, true, now())', [
          d.demandaId,
        ]),
      ).rejects.toThrow(nasce);

      await criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: '2.00' });
      const imutavel = 'orquestracao_demandas: demanda, teto base e data de criação são imutáveis';
      await expect(db.pool.query('UPDATE orquestracao_demandas SET teto_base_usd = 20 WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(imutavel);
      await expect(db.pool.query("UPDATE orquestracao_demandas SET criado_em = '2001-01-01' WHERE demanda_id = $1", [d.demandaId])).rejects.toThrow(
        imutavel,
      );
      await expect(db.pool.query('DELETE FROM orquestracao_demandas WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(
        'orquestracao_demandas: DELETE não é permitido',
      );
      // A demanda com envelope não pode ser apagada (RESTRICT).
      await expect(db.pool.query('DELETE FROM demandas WHERE id = $1', [d.demandaId])).rejects.toThrow(/orquestracao_demandas_demanda_id_fkey/);
    });

    it('a rota legado_fixo e fixada uma vez, com motivo e data do banco, e nunca volta', async () => {
      const d = await demandaComEnvelope(db.pool);
      expect(await fixarRotaLegado(db.pool, { demandaId: d.demandaId, motivo: 'plano_rejeitado' })).toBe(true);
      const envelope = await obterEnvelope(db.pool, d.demandaId);
      expect(envelope).toMatchObject({ rota: 'legado_fixo', motivoLegado: 'plano_rejeitado' });
      expect(envelope!.legadoFixadoEm).not.toBeNull();
      expect(await fixarRotaLegado(db.pool, { demandaId: d.demandaId, motivo: 'tarefa_falhou' })).toBe(false);

      const definitiva = 'orquestracao_demandas: a rota legado_fixo é definitiva';
      await expect(
        db.pool.query("UPDATE orquestracao_demandas SET rota = 'tarefas', motivo_legado = NULL WHERE demanda_id = $1", [d.demandaId]),
      ).rejects.toThrow(definitiva);
      await expect(db.pool.query("UPDATE orquestracao_demandas SET motivo_legado = 'tarefa_falhou' WHERE demanda_id = $1", [d.demandaId])).rejects.toThrow(
        definitiva,
      );
      const outra = await demandaComEnvelope(db.pool);
      await expect(db.pool.query("UPDATE orquestracao_demandas SET rota = 'legado_fixo' WHERE demanda_id = $1", [outra.demandaId])).rejects.toThrow(
        /orquestracao_demandas_legado_check/,
      );
    });

    it('o bloqueio por custo e marcado pelo banco e so sai com uma autorizacao da mesma transacao', async () => {
      const d = await demandaComEnvelope(db.pool);
      expect(await bloquearPorCusto(db.pool, d.demandaId)).toBe(true);
      expect(await bloquearPorCusto(db.pool, d.demandaId)).toBe(false);
      const bloqueado = await obterEnvelope(db.pool, d.demandaId);
      expect(bloqueado).toMatchObject({ bloqueadaPorCusto: true });
      expect(bloqueado!.bloqueioCustoEm).not.toBeNull();

      const semAutorizacao = 'orquestracao_demandas: o bloqueio por custo só sai com uma autorização na mesma transação';
      await expect(db.pool.query('UPDATE orquestracao_demandas SET bloqueada_por_custo = false WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(
        semAutorizacao,
      );
      // Uma autorização de outra transação não serve: a de agora destrava; depois de bloquear de novo, só outra autorização.
      await comTransacao(db.pool, (c) =>
        autorizarCustoAdicional(c, { demandaId: d.demandaId, valorUsd: '1.00', limiteEsperadoUsd: '2.00', autorizadoPor: 'admin' }),
      );
      await bloquearPorCusto(db.pool, d.demandaId);
      await expect(db.pool.query('UPDATE orquestracao_demandas SET bloqueada_por_custo = false WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(
        semAutorizacao,
      );
    });
  });

  describe('reservas_custo', () => {
    it('situacaoDeCusto: limite, comprometido e disponivel em texto decimal; nulo sem envelope', async () => {
      const d = await demandaComEnvelope(db.pool);
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toEqual({ limiteUsd: '2.00', comprometidoUsd: '0.000000', disponivelUsd: '2.000000' });
      await reservaAberta(d.demandaId, '0.25');
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toEqual({ limiteUsd: '2.00', comprometidoUsd: '0.250000', disponivelUsd: '1.750000' });
      expect(await situacaoDeCusto(db.pool, (await novaDemanda(db.pool)).demandaId)).toBeNull();
    });

    it('o comprometido conta o gasto inteiro da demanda, inclusive de antes do envelope, e a reserva so passa se couber', async () => {
      const d = await novaDemanda(db.pool);
      await registrarPasso(db.pool, {
        runId: d.runId,
        demandaId: d.demandaId,
        papel: 'frota:architect',
        modelo: 'claude-sonnet-5',
        tokensIn: 1,
        tokensOut: 1,
        cacheRead: 0,
        cacheWrite: 0,
        custoUsd: 0.5,
        duracaoMs: 10,
      });
      await criarEnvelope(db.pool, { demandaId: d.demandaId, tetoBaseUsd: '2.00' });
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '0.500000', disponivelUsd: '1.500000' });

      expect(await reserva(d.demandaId, '1.500001')).toEqual({
        reservada: false,
        motivo: 'custo_demanda_excedido',
        comprometidoUsd: '0.500000',
        limiteUsd: '2.00',
        reservaUsd: '1.500001',
      });
      // Exatamente no limite, passa.
      expect(await reserva(d.demandaId, '1.5')).toMatchObject({ reservada: true, valorReservadoUsd: '1.500000' });
      expect(await reserva(d.demandaId, '0.000001')).toMatchObject({ reservada: false, motivo: 'custo_demanda_excedido', comprometidoUsd: '2.000000' });
      // O banco repete a conta: nem SQL direto passa do limite.
      await expect(
        db.pool.query(
          "INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em) VALUES ($1, 'auditoria', 'claude-sonnet-5', 0.000001, now() + interval '1 hour')",
          [d.demandaId],
        ),
      ).rejects.toThrow('reservas_custo: a reserva passaria do limite da demanda');

      // Gasto anterior acima do teto: o disponível fica em zero, nunca negativo.
      const cara = await novaDemanda(db.pool);
      await registrarPasso(db.pool, {
        runId: cara.runId,
        demandaId: cara.demandaId,
        papel: 'frota:architect',
        modelo: 'claude-sonnet-5',
        tokensIn: 1,
        tokensOut: 1,
        cacheRead: 0,
        cacheWrite: 0,
        custoUsd: 2.5,
        duracaoMs: 10,
      });
      await criarEnvelope(db.pool, { demandaId: cara.demandaId, tetoBaseUsd: '2.00' });
      expect(await situacaoDeCusto(db.pool, cara.demandaId)).toEqual({ limiteUsd: '2.00', comprometidoUsd: '2.500000', disponivelUsd: '0.000000' });
    });

    it('recusa agente nao autorizado, demanda bloqueada ou sem envelope e parametros fora do formato', async () => {
      const d = await demandaComEnvelope(db.pool);
      expect(await reserva(d.demandaId, '0.10', { modelo: 'claude-opus-5' })).toEqual({ reservada: false, motivo: 'agente_nao_autorizado' });
      expect(await reservarCusto(db.pool, { demandaId: d.demandaId, operacao: 'auditoria', modelo: 'claude-sonnet-5', valorReservadoUsd: '0.10', validadeSegundos: 60, agenteChave: 'frota:inexistente' })).toEqual({
        reservada: false,
        motivo: 'agente_nao_autorizado',
      });
      await atualizarAgente(db.pool, 'frota:gestores', 'teste', { estado: 'suspenso' });
      try {
        expect(await reserva(d.demandaId, '0.10')).toEqual({ reservada: false, motivo: 'agente_nao_autorizado' });
      } finally {
        await atualizarAgente(db.pool, 'frota:gestores', 'teste', { estado: 'ativo' });
      }

      await expect(reserva(d.demandaId, '0.10', { operacao: 'integracao' })).rejects.toThrow('use reservarERegistrarEnvio');
      await expect(reserva((await novaDemanda(db.pool)).demandaId, '0.10')).rejects.toThrow('Demanda sem envelope de orquestração.');
      await expect(reserva(d.demandaId, '0')).rejects.toThrow('A reserva precisa ser maior que zero.');
      await expect(reserva(d.demandaId, '0.1234567')).rejects.toThrow();
      await expect(reserva(d.demandaId, '0.10', { modelo: 'Claude Sonnet' })).rejects.toThrow('Modelo fora do formato fechado.');
      await expect(reserva(d.demandaId, '0.10', { validadeSegundos: 0 })).rejects.toThrow('A validade da reserva precisa ser');
      await expect(reserva(d.demandaId, '0.10', { validadeSegundos: 1.5 })).rejects.toThrow('A validade da reserva precisa ser');

      await bloquearPorCusto(db.pool, d.demandaId);
      expect(await reserva(d.demandaId, '0.10')).toEqual({ reservada: false, motivo: 'demanda_bloqueada' });
      await expect(
        db.pool.query(
          "INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em) VALUES ($1, 'auditoria', 'claude-sonnet-5', 0.01, now() + interval '1 hour')",
          [d.demandaId],
        ),
      ).rejects.toThrow('reservas_custo: a demanda está bloqueada por custo');
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM reservas_custo WHERE demanda_id = $1', [d.demandaId]);
      expect(rows[0].n).toBe(0);
    });

    it('reservas concorrentes: so passa o que cabe no limite, pelo repositorio e por SQL direto', async () => {
      const d = await demandaComEnvelope(db.pool);
      const resultados = await Promise.all(Array.from({ length: 5 }, () => reserva(d.demandaId, '0.60')));
      expect(resultados.filter((r) => r.reservada)).toHaveLength(3);
      expect(resultados.filter((r) => !r.reservada && r.motivo === 'custo_demanda_excedido')).toHaveLength(2);
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '1.800000', disponivelUsd: '0.200000' });

      // Duas transações de SQL direto com 0,15 cada, quando só cabem 0,20: a segunda espera o lock do envelope e,
      // depois do COMMIT da primeira, recalcula e é recusada.
      const inserir = "INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em) VALUES ($1, 'auditoria', 'claude-sonnet-5', 0.15, now() + interval '1 hour')";
      const c1 = await db.pool.connect();
      const c2 = await db.pool.connect();
      try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        await c1.query(inserir, [d.demandaId]);
        const segunda = c2.query(inserir, [d.demandaId]).then(
          () => 'passou',
          (erro: Error) => erro.message,
        );
        await esperar(200);
        await c1.query('COMMIT');
        expect(await segunda).toBe('reservas_custo: a reserva passaria do limite da demanda');
        await c2.query('ROLLBACK');
      } finally {
        c1.release();
        c2.release();
      }
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '1.950000' });
    });

    it('transicoes: aberta → liquidada | cancelada | retida; retida → reconhecida; o resto e recusado', async () => {
      const d = await demandaComEnvelope(db.pool);
      const transicao = (id: string, estado: string) => db.pool.query('UPDATE reservas_custo SET estado = $2 WHERE id = $1', [id, estado]);

      const cancelada = await reservaAberta(d.demandaId);
      expect(await cancelarReserva(db.pool, cancelada)).toBe(true);
      expect(await cancelarReserva(db.pool, cancelada)).toBe(false);
      expect(await reterReserva(db.pool, cancelada)).toBe(false);
      await expect(transicao(cancelada, 'aberta')).rejects.toThrow('reservas_custo: transição cancelada → aberta não é permitida');

      const retida = await reservaAberta(d.demandaId);
      expect(await reterReserva(db.pool, retida)).toBe(true);
      expect(await reconhecerReserva(db.pool, { reservaId: retida, reconhecidaPor: 'admin' })).toEqual({
        reservaId: retida,
        demandaId: d.demandaId,
        tarefaId: null,
        operacao: 'planejamento',
        valorUsd: '0.100000',
      });
      expect(await reconhecerReserva(db.pool, { reservaId: retida, reconhecidaPor: 'admin' })).toBeNull();
      await expect(reconhecerReserva(db.pool, { reservaId: retida, reconhecidaPor: 'Admin Geral' })).rejects.toThrow('Login fora do formato fechado.');
      await expect(transicao(retida, 'retida')).rejects.toThrow('reservas_custo: transição reconhecida → retida não é permitida');

      const liquidada = await reservaAberta(d.demandaId);
      await liquidarReserva(db.pool, { reservaId: liquidada, passo: { runId: d.runId, papel: 'frota:gestores', uso: uso(1_000, 100), duracaoMs: 5 } });
      await expect(transicao(liquidada, 'cancelada')).rejects.toThrow('reservas_custo: transição liquidada → cancelada não é permitida');

      const aberta = await reservaAberta(d.demandaId);
      await expect(transicao(aberta, 'reconhecida')).rejects.toThrow('reservas_custo: transição aberta → reconhecida não é permitida');
      await expect(db.pool.query('UPDATE reservas_custo SET valor_reservado_usd = 0.01 WHERE id = $1', [aberta])).rejects.toThrow(
        'reservas_custo: a identidade da reserva é imutável',
      );
      await expect(db.pool.query("UPDATE reservas_custo SET expira_em = now() + interval '1 day' WHERE id = $1", [aberta])).rejects.toThrow(
        'reservas_custo: a identidade da reserva é imutável',
      );
      await expect(db.pool.query('DELETE FROM reservas_custo WHERE id = $1', [aberta])).rejects.toThrow('reservas_custo: DELETE não é permitido');

      const inserirCru = (colunas: string, valores: string) =>
        db.pool.query(
          `INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em${colunas})
           VALUES ($1, 'auditoria', 'claude-sonnet-5', 0.01, now() + interval '1 hour'${valores})`,
          [d.demandaId],
        );
      await expect(inserirCru(', estado, encerrada_em', ", 'retida', now()")).rejects.toThrow('reservas_custo: uma reserva nasce aberta');
      await expect(
        db.pool.query(
          "INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em) VALUES ($1, 'auditoria', 'claude-sonnet-5', 0.01, now())",
          [d.demandaId],
        ),
      ).rejects.toThrow('reservas_custo: expira_em precisa estar no futuro');
      // Integração só com tarefa; tarefa só em execução ou integração.
      await expect(
        db.pool.query(
          "INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em) VALUES ($1, 'integracao', 'claude-sonnet-5', 0.01, now() + interval '1 hour')",
          [d.demandaId],
        ),
      ).rejects.toThrow(/reservas_custo_operacao_tarefa_check/);
    });

    it('cancelada nao conta; aberta, retida e reconhecida contam o valor reservado; liquidada conta o custo real', async () => {
      const d = await demandaComEnvelope(db.pool);
      const comprometido = async () => (await situacaoDeCusto(db.pool, d.demandaId))!.comprometidoUsd;

      const r1 = await reservaAberta(d.demandaId, '0.30');
      expect(await comprometido()).toBe('0.300000');
      await cancelarReserva(db.pool, r1);
      expect(await comprometido()).toBe('0.000000');

      const r2 = await reservaAberta(d.demandaId, '0.30');
      await reterReserva(db.pool, r2);
      expect(await comprometido()).toBe('0.300000');
      await reconhecerReserva(db.pool, { reservaId: r2, reconhecidaPor: 'admin' });
      expect(await comprometido()).toBe('0.300000');

      const r3 = await reservaAberta(d.demandaId, '0.40');
      expect(await comprometido()).toBe('0.700000');
      // 10.000 × US$ 2 / 1e6 + 1.000 × US$ 10 / 1e6 = 0,03.
      const l = await liquidarReserva(db.pool, { reservaId: r3, passo: { runId: d.runId, papel: 'frota:gestores', uso: uso(10_000, 1_000), duracaoMs: 5 } });
      expect(l).toMatchObject({ liquidada: true, custoRealUsd: '0.030000', reservaUsd: '0.400000', acimaDaReserva: false });
      expect(await comprometido()).toBe('0.330000');
    });

    it('liquidarReserva: grava o agent_step com o custo real decimal e os dados da propria reserva, e liquida', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const { tarefa, reservaId } = await reivindicarEEnviar(db.pool, p.planoId, { valorReservadoUsd: '0.020000' });
      // 3.000 × US$ 2 / 1e6 + 2.000 × US$ 10 / 1e6 = 0,026: acima da reserva de 0,02.
      const l = await liquidarReserva(db.pool, { reservaId, passo: { runId: p.runId, papel: tarefa.agente.chave, uso: uso(3_000, 2_000), duracaoMs: 1234 } });
      expect(l).toMatchObject({ liquidada: true, custoRealUsd: '0.026000', reservaUsd: '0.020000', acimaDaReserva: true });

      const { rows: passo } = await db.pool.query(
        `SELECT run_id, demanda_id, papel, modelo, tokens_in, tokens_out, custo_usd::text AS custo, duracao_ms, plano_id, tarefa_id, operacao
           FROM agent_steps WHERE id = $1`,
        [l.agentStepId],
      );
      expect(passo[0]).toEqual({
        run_id: p.runId,
        demanda_id: p.demandaId,
        papel: 'frota:architect',
        modelo: 'claude-sonnet-5',
        tokens_in: 3_000,
        tokens_out: 2_000,
        custo: '0.026000',
        duracao_ms: 1234,
        plano_id: p.planoId,
        tarefa_id: tarefa.id,
        operacao: 'execucao',
      });
      const { rows: r } = await db.pool.query(
        'SELECT estado, custo_real_usd::text AS custo, agent_step_id, encerrada_em IS NOT NULL AS encerrada FROM reservas_custo WHERE id = $1',
        [reservaId],
      );
      expect(r[0]).toEqual({ estado: 'liquidada', custo: '0.026000', agent_step_id: l.agentStepId, encerrada: true });

      // Repetir a liquidação (a resposta do COMMIT se perdeu) devolve o mesmo passo e não conta o gasto de novo.
      const repetida = await liquidarReserva(db.pool, {
        reservaId,
        passo: { runId: p.runId, papel: tarefa.agente.chave, uso: uso(3_000, 2_000), duracaoMs: 1234 },
      });
      expect(repetida).toEqual(l);
      expect(await contarPassos(db.pool, p.demandaId)).toBe(1);
      expect(await situacaoDeCusto(db.pool, p.demandaId)).toMatchObject({ comprometidoUsd: '0.026000' });
      await expect(
        liquidarReserva(db.pool, { reservaId: randomUUID(), passo: { runId: null, papel: 'x', uso: uso(1, 1), duracaoMs: null } }),
      ).rejects.toThrow('Reserva inexistente.');
    });

    it('resposta que chega depois da reserva retida ou cancelada: grava o custo real e liga o passo tardio uma vez so', async () => {
      const d = await demandaComEnvelope(db.pool);
      const passo = { runId: d.runId, papel: 'frota:gestores', uso: uso(10_000, 1_000), duracaoMs: 5 };
      const id = await reservaAberta(d.demandaId, '0.10');
      await reterReserva(db.pool, id);
      const { rows: antes } = await db.pool.query('SELECT encerrada_em FROM reservas_custo WHERE id = $1', [id]);

      const l = await liquidarReserva(db.pool, { reservaId: id, passo });
      expect(l).toMatchObject({ liquidada: false, estadoReserva: 'retida', custoRealUsd: '0.030000', acimaDaReserva: false });
      const { rows: depois } = await db.pool.query('SELECT estado, agent_step_id, custo_real_usd, encerrada_em FROM reservas_custo WHERE id = $1', [id]);
      expect(depois[0]).toEqual({ estado: 'retida', agent_step_id: l.agentStepId, custo_real_usd: null, encerrada_em: antes[0].encerrada_em });
      // A reserva retida e o passo contam os dois, o lado seguro. Repetir a liquidação não conta o gasto de novo.
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '0.130000' });
      expect(await liquidarReserva(db.pool, { reservaId: id, passo })).toEqual(l);
      expect(await contarPassos(db.pool, d.demandaId)).toBe(1);

      // Reconhecido o gasto, o passo continua ligado, e liquidar de novo ainda devolve o mesmo passo.
      await reconhecerReserva(db.pool, { reservaId: id, reconhecidaPor: 'admin' });
      expect(await liquidarReserva(db.pool, { reservaId: id, passo })).toEqual({ ...l, estadoReserva: 'reconhecida' });

      // Cancelada: a reserva deixa de contar, e o passo tardio conta o gasto que aconteceu.
      const cancelada = await reservaAberta(d.demandaId, '0.10');
      await cancelarReserva(db.pool, cancelada);
      const lc = await liquidarReserva(db.pool, { reservaId: cancelada, passo });
      expect(lc).toMatchObject({ liquidada: false, estadoReserva: 'cancelada', custoRealUsd: '0.030000' });
      expect(await liquidarReserva(db.pool, { reservaId: cancelada, passo })).toEqual(lc);
      expect(await contarPassos(db.pool, d.demandaId)).toBe(2);
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '0.160000' });
    });

    it('liquidacao que espera o lock de outra que ligou o passo tardio devolve esse passo, com o custo dele', async () => {
      const d = await demandaComEnvelope(db.pool);
      const id = await reservaAberta(d.demandaId, '0.10');
      await reterReserva(db.pool, id);
      const c1 = await db.pool.connect();
      try {
        await c1.query('BEGIN');
        await c1.query('SELECT 1 FROM reservas_custo WHERE id = $1 FOR UPDATE', [id]);
        const segunda = liquidarReserva(db.pool, {
          reservaId: id,
          passo: { runId: d.runId, papel: 'frota:gestores', uso: uso(10_000, 1_000), duracaoMs: 5 },
        });
        await esperar(200);
        const { rows } = await c1.query<{ id: string }>(
          "INSERT INTO agent_steps (demanda_id, papel, modelo, custo_usd, operacao) VALUES ($1, 'frota:gestores', 'claude-sonnet-5', 0.03, 'planejamento') RETURNING id",
          [d.demandaId],
        );
        await c1.query('UPDATE reservas_custo SET agent_step_id = $2 WHERE id = $1', [id, rows[0]!.id]);
        await c1.query('COMMIT');
        expect(await segunda).toEqual({
          agentStepId: rows[0]!.id,
          custoRealUsd: '0.030000',
          reservaUsd: '0.100000',
          acimaDaReserva: false,
          liquidada: false,
          estadoReserva: 'retida',
        });
      } finally {
        c1.release();
      }
      expect(await contarPassos(db.pool, d.demandaId)).toBe(1);
    });

    it('o passo tardio: so numa reserva encerrada sem liquidacao, da mesma chamada, uma vez, e nunca muda', async () => {
      const d = await demandaComEnvelope(db.pool);
      const passo = async (operacao = 'planejamento') => {
        const { rows } = await db.pool.query<{ id: string }>(
          "INSERT INTO agent_steps (demanda_id, papel, modelo, custo_usd, operacao) VALUES ($1, 'frota:gestores', 'claude-sonnet-5', 0.01, $2) RETURNING id",
          [d.demandaId, operacao],
        );
        return rows[0]!.id;
      };
      const ligar = (reservaId: string, stepId: string, extra = '') =>
        db.pool.query(`UPDATE reservas_custo SET agent_step_id = $2${extra} WHERE id = $1`, [reservaId, stepId]);
      const soNaLiquidacao = 'reservas_custo: o passo só é ligado na liquidação ou, numa reserva já encerrada, como passo tardio';

      // Aberta: o passo só entra com a liquidação, e nunca junto com outra transição.
      const aberta = await reservaAberta(d.demandaId);
      await expect(ligar(aberta, await passo())).rejects.toThrow(soNaLiquidacao);
      await expect(ligar(aberta, await passo(), ", estado = 'retida'")).rejects.toThrow(soNaLiquidacao);

      const retida = await reservaAberta(d.demandaId);
      await reterReserva(db.pool, retida);
      await expect(ligar(retida, await passo('auditoria'))).rejects.toThrow('reservas_custo: o passo tardio precisa ser o agent_step da mesma chamada');
      await expect(ligar(retida, await passo(), ', custo_real_usd = 0.01')).rejects.toThrow(/reservas_custo_liquidada_check/);
      await expect(ligar(retida, await passo(), ", estado = 'reconhecida', reconhecida_por = 'admin'")).rejects.toThrow(soNaLiquidacao);
      const certo = await passo();
      await ligar(retida, certo, ", encerrada_em = now() + interval '1 day', reconhecida_por = 'admin'");
      const { rows } = await db.pool.query(
        'SELECT estado, agent_step_id, reconhecida_por, encerrada_em < now() + interval \'1 hour\' AS encerrada_antes FROM reservas_custo WHERE id = $1',
        [retida],
      );
      expect(rows[0]).toEqual({ estado: 'retida', agent_step_id: certo, reconhecida_por: null, encerrada_antes: true });
      await expect(ligar(retida, await passo())).rejects.toThrow('reservas_custo: o passo ligado à reserva é imutável');
      await expect(db.pool.query('UPDATE reservas_custo SET agent_step_id = NULL WHERE id = $1', [retida])).rejects.toThrow(
        'reservas_custo: o passo ligado à reserva é imutável',
      );

      // Um passo fica ligado a uma reserva só.
      const outra = await reservaAberta(d.demandaId);
      await cancelarReserva(db.pool, outra);
      await expect(ligar(outra, certo)).rejects.toThrow(/reservas_custo_agent_step_id_key/);
      // Uma reserva liquidada não troca de passo.
      const liquidada = await reservaAberta(d.demandaId);
      const l = await liquidarReserva(db.pool, { reservaId: liquidada, passo: { runId: d.runId, papel: 'frota:gestores', uso: uso(1_000, 100), duracaoMs: 5 } });
      await expect(ligar(liquidada, await passo())).rejects.toThrow('reservas_custo: o passo ligado à reserva é imutável');
      expect(l.liquidada).toBe(true);
    });

    it('o banco recusa gravar reserva em REPEATABLE READ ou sem envelope; READ COMMITTED e SERIALIZABLE gravam', async () => {
      const d = await demandaComEnvelope(db.pool);
      const inserir =
        "INSERT INTO reservas_custo (demanda_id, operacao, modelo, valor_reservado_usd, expira_em) VALUES ($1, 'auditoria', 'claude-sonnet-5', 0.01, now() + interval '1 hour')";
      const noNivel = async (nivel: string, demandaId = d.demandaId) => {
        const c = await db.pool.connect();
        try {
          await c.query(`BEGIN ISOLATION LEVEL ${nivel}`);
          await c.query(inserir, [demandaId]);
          await c.query('COMMIT');
        } catch (erro) {
          await c.query('ROLLBACK');
          throw erro;
        } finally {
          c.release();
        }
      };
      await expect(noNivel('REPEATABLE READ')).rejects.toThrow(
        'reservas_custo: a reserva não é gravada em REPEATABLE READ (use READ COMMITTED ou SERIALIZABLE)',
      );
      await noNivel('READ COMMITTED');
      await noNivel('SERIALIZABLE');
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '0.020000' });
      await expect(noNivel('READ COMMITTED', (await novaDemanda(db.pool)).demandaId)).rejects.toThrow(
        'reservas_custo: a demanda não tem envelope de orquestração',
      );
    });

    it('agent_step_id e FK e UNIQUE: a liquidacao exige o passo da mesma chamada, e um passo liquida uma reserva so', async () => {
      const { rows: restricoes } = await db.pool.query<{ conname: string; contype: string; alvo: string | null }>(
        `SELECT conname, contype, confrelid::regclass::text AS alvo FROM pg_constraint
          WHERE conrelid = 'reservas_custo'::regclass AND conkey = ARRAY[(
            SELECT attnum FROM pg_attribute WHERE attrelid = 'reservas_custo'::regclass AND attname = 'agent_step_id'
          )]::int2[]
          ORDER BY contype`,
      );
      expect(restricoes).toEqual([
        { conname: 'reservas_custo_agent_step_id_fkey', contype: 'f', alvo: 'agent_steps' },
        { conname: 'reservas_custo_agent_step_id_key', contype: 'u', alvo: '-' },
      ]);

      const d = await demandaComEnvelope(db.pool);
      const outra = await demandaComEnvelope(db.pool);
      const passo = async (demandaId: string, custo: number, modelo = 'claude-sonnet-5', operacao: string | null = 'planejamento') => {
        const { rows } = await db.pool.query<{ id: string }>(
          `INSERT INTO agent_steps (demanda_id, papel, modelo, custo_usd, operacao) VALUES ($1, 'frota:gestores', $2, $3, $4) RETURNING id`,
          [demandaId, modelo, custo, operacao],
        );
        return rows[0]!.id;
      };
      const liquidarCru = (reservaId: string, stepId: string, custo: number) =>
        db.pool.query("UPDATE reservas_custo SET estado = 'liquidada', agent_step_id = $2, custo_real_usd = $3 WHERE id = $1", [reservaId, stepId, custo]);
      const exige = 'reservas_custo: a liquidação exige o agent_step da mesma chamada, com o custo real';

      const r1 = await reservaAberta(d.demandaId);
      await expect(liquidarCru(r1, randomUUID(), 0.01)).rejects.toThrow(exige);
      await expect(liquidarCru(r1, await passo(d.demandaId, 0.02), 0.01)).rejects.toThrow(exige);
      await expect(liquidarCru(r1, await passo(outra.demandaId, 0.01), 0.01)).rejects.toThrow(exige);
      await expect(liquidarCru(r1, await passo(d.demandaId, 0.01, 'claude-opus-5'), 0.01)).rejects.toThrow(exige);
      await expect(liquidarCru(r1, await passo(d.demandaId, 0.01, 'claude-sonnet-5', 'auditoria'), 0.01)).rejects.toThrow(exige);
      await expect(liquidarCru(r1, await passo(d.demandaId, 0.01, 'claude-sonnet-5', null), 0.01)).rejects.toThrow(exige);

      const certo = await passo(d.demandaId, 0.01);
      await liquidarCru(r1, certo, 0.01);
      const r2 = await reservaAberta(d.demandaId);
      await expect(liquidarCru(r2, certo, 0.01)).rejects.toThrow(/reservas_custo_agent_step_id_key/);
    });

    it('cancelar e reter nunca criam agent_step', async () => {
      const d = await demandaComEnvelope(db.pool);
      await cancelarReserva(db.pool, await reservaAberta(d.demandaId));
      await reterReserva(db.pool, await reservaAberta(d.demandaId));
      expect(await contarPassos(db.pool, d.demandaId)).toBe(0);
    });

    it('reterReservasVencidas: a reserva aberta depois da validade vira retida e continua contando', async () => {
      const d = await demandaComEnvelope(db.pool);
      const curta = await reservaAberta(d.demandaId, '0.10', { validadeSegundos: 1 });
      const longa = await reservaAberta(d.demandaId, '0.20');
      await esperar(1_200);
      const retidas = (await reterReservasVencidas(db.pool)).filter((r) => r.demandaId === d.demandaId);
      expect(retidas).toEqual([{ reservaId: curta, demandaId: d.demandaId, tarefaId: null, operacao: 'planejamento', valorUsd: '0.100000' }]);
      expect(await estadoDa(curta)).toBe('retida');
      expect(await estadoDa(longa)).toBe('aberta');
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ comprometidoUsd: '0.300000' });
      expect((await reterReservasVencidas(db.pool)).filter((r) => r.demandaId === d.demandaId)).toEqual([]);
    });

    it('a reserva de uma tarefa segue o snapshot do claim: modelo, operacao e uma so por claim', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const t = await reivindicar(db.pool, p.planoId);
      const reservaCrua = (modelo: string, operacao: string) =>
        db.pool.query(
          `INSERT INTO reservas_custo (demanda_id, plano_id, tarefa_id, claim_id, operacao, modelo, valor_reservado_usd, expira_em)
           VALUES ($1, $2, $3, $4, $5, $6, 0.01, now() + interval '1 hour')`,
          [p.demandaId, p.planoId, t.id, t.claimId, operacao, modelo],
        );
      const snapshot = 'reservas_custo: modelo e operação precisam ser os do snapshot da tarefa';
      await expect(reservaCrua('claude-opus-5', 'execucao')).rejects.toThrow(snapshot);
      await expect(reservaCrua('claude-sonnet-5', 'integracao')).rejects.toThrow(snapshot);
      await expect(reservaCrua('claude-sonnet-5', 'auditoria')).rejects.toThrow(snapshot);
      await reservaCrua('claude-sonnet-5', 'execucao');
      await expect(reservaCrua('claude-sonnet-5', 'execucao')).rejects.toThrow(/reservas_custo_claim_idx/);
      // Tarefa e plano sempre juntos (FK composta), e o plano da mesma demanda.
      const outro = await planoAtivoDeTeste(db.pool);
      await expect(
        db.pool.query(
          `INSERT INTO reservas_custo (demanda_id, plano_id, operacao, modelo, valor_reservado_usd, expira_em)
           VALUES ($1, $2, 'planejamento', 'claude-sonnet-5', 0.01, now() + interval '1 hour')`,
          [p.demandaId, outro.planoId],
        ),
      ).rejects.toThrow('reservas_custo: o plano precisa ser da mesma demanda');
    });
  });

  describe('autorizacoes_custo', () => {
    const autorizar = (demandaId: string, valorUsd: string, limiteEsperadoUsd: string, autorizadoPor = 'admin') =>
      comTransacao(db.pool, (c) => autorizarCustoAdicional(c, { demandaId, valorUsd, limiteEsperadoUsd, autorizadoPor }));

    it('o valor vai de US$ 0,50 a 5,00 com ate 2 casas, e o login tem formato fechado', () => {
      const base = { demandaId: randomUUID(), limiteEsperadoUsd: '2.00', autorizadoPor: 'admin' };
      for (const valorUsd of ['0.50', '5', '5.00', '1.5']) {
        expect(AutorizacaoCustoSchema.safeParse({ ...base, valorUsd }).success, valorUsd).toBe(true);
      }
      for (const valorUsd of ['0.49', '5.01', '1.234', 'abc', '-1', '']) {
        expect(AutorizacaoCustoSchema.safeParse({ ...base, valorUsd }).success, valorUsd).toBe(false);
      }
      for (const autorizadoPor of ['Admin', 'admin geral', '', '-admin', 'a'.repeat(101)]) {
        expect(AutorizacaoCustoSchema.safeParse({ ...base, valorUsd: '1.00', autorizadoPor }).success, autorizadoPor).toBe(false);
      }
      expect(AutorizacaoCustoSchema.safeParse({ ...base, valorUsd: '1.00', extra: 1 }).success).toBe(false);
    });

    it('so autoriza demanda bloqueada, com o limite que o administrador viu; grava, soma ao limite e destrava', async () => {
      const semEnvelope = await novaDemanda(db.pool);
      expect(await autorizar(semEnvelope.demandaId, '1.00', '2.00')).toEqual({ autorizada: false, motivo: 'sem_envelope' });
      const d = await demandaComEnvelope(db.pool);
      expect(await autorizar(d.demandaId, '1.00', '2.00')).toEqual({ autorizada: false, motivo: 'nao_bloqueada' });

      await bloquearPorCusto(db.pool, d.demandaId);
      const r = await autorizar(d.demandaId, '1.5', '2.00');
      expect(r).toMatchObject({ autorizada: true, valorUsd: '1.50', limiteAnteriorUsd: '2.00', limiteNovoUsd: '3.50' });
      expect(await obterEnvelope(db.pool, d.demandaId)).toMatchObject({ bloqueadaPorCusto: false, bloqueioCustoEm: null });
      expect(await situacaoDeCusto(db.pool, d.demandaId)).toMatchObject({ limiteUsd: '3.50' });

      await bloquearPorCusto(db.pool, d.demandaId);
      expect(await autorizar(d.demandaId, '1.00', '2.00')).toEqual({ autorizada: false, motivo: 'limite_divergente', limiteAtualUsd: '3.50' });
      expect(await autorizar(d.demandaId, '1.00', '3.5')).toMatchObject({ autorizada: true, limiteNovoUsd: '4.50' });

      const { rows } = await db.pool.query(
        'SELECT valor_usd::text AS valor, limite_anterior_usd::text AS anterior, limite_novo_usd::text AS novo, autorizado_por FROM autorizacoes_custo WHERE demanda_id = $1 ORDER BY id',
        [d.demandaId],
      );
      expect(rows).toEqual([
        { valor: '1.50', anterior: '2.00', novo: '3.50', autorizado_por: 'admin' },
        { valor: '1.00', anterior: '3.50', novo: '4.50', autorizado_por: 'admin' },
      ]);
    });

    it('o banco confere tudo de novo, grava a transacao e nao aceita UPDATE nem DELETE', async () => {
      const d = await demandaComEnvelope(db.pool);
      const inserirCru = (c: pg.PoolClient, valor: string, anterior: string, novo: string, extra = '') =>
        c.query(
          `INSERT INTO autorizacoes_custo (demanda_id, valor_usd, limite_anterior_usd, limite_novo_usd, autorizado_por${extra ? ', transacao' : ''})
           VALUES ($1, $2, $3, $4, 'admin'${extra})`,
          [d.demandaId, valor, anterior, novo],
        );
      await expect(comTransacao(db.pool, (c) => inserirCru(c, '1.00', '2.00', '3.00'))).rejects.toThrow(
        'autorizacoes_custo: só uma demanda bloqueada por custo recebe autorização',
      );
      await bloquearPorCusto(db.pool, d.demandaId);
      await expect(comTransacao(db.pool, (c) => inserirCru(c, '1.00', '1.00', '2.00'))).rejects.toThrow(
        'autorizacoes_custo: limite_anterior_usd diverge do limite atual',
      );
      await expect(comTransacao(db.pool, (c) => inserirCru(c, '1.00', '2.00', '4.00'))).rejects.toThrow(
        'autorizacoes_custo: limite_novo_usd precisa ser o anterior mais o valor',
      );
      await expect(comTransacao(db.pool, (c) => inserirCru(c, '0.49', '2.00', '2.49'))).rejects.toThrow(/autorizacoes_custo_valor_usd_check/);
      await expect(comTransacao(db.pool, (c) => inserirCru(c, '5.01', '2.00', '7.01'))).rejects.toThrow(/autorizacoes_custo_valor_usd_check/);
      // Uma autorização que não destrava a demanda na mesma transação é recusada no COMMIT.
      await expect(comTransacao(db.pool, (c) => inserirCru(c, '1.00', '2.00', '3.00'))).rejects.toThrow(
        'autorizacoes_custo: a autorização precisa liberar o bloqueio na mesma transação',
      );

      // A transação gravada é sempre a do banco, nunca a de quem chama.
      const transacao = await comTransacao(db.pool, async (c) => {
        await inserirCru(c, '1.00', '2.00', '3.00', ', 42');
        await c.query('UPDATE orquestracao_demandas SET bloqueada_por_custo = false WHERE demanda_id = $1', [d.demandaId]);
        const { rows } = await c.query<{ gravada: string; atual: string }>(
          'SELECT a.transacao::text AS gravada, txid_current()::text AS atual FROM autorizacoes_custo a WHERE a.demanda_id = $1',
          [d.demandaId],
        );
        return rows[0]!;
      });
      expect(transacao.gravada).toBe(transacao.atual);
      expect(transacao.gravada).not.toBe('42');

      await expect(db.pool.query('UPDATE autorizacoes_custo SET valor_usd = 5 WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(
        'autorizacoes_custo é append-only: UPDATE não é permitido',
      );
      await expect(db.pool.query('DELETE FROM autorizacoes_custo WHERE demanda_id = $1', [d.demandaId])).rejects.toThrow(
        'autorizacoes_custo é append-only: DELETE não é permitido',
      );
    });

    it('duas autorizacoes concorrentes nunca passam juntas', async () => {
      const d = await demandaComEnvelope(db.pool);
      await bloquearPorCusto(db.pool, d.demandaId);
      const resultados = await Promise.all([autorizar(d.demandaId, '1.00', '2.00', 'admin-a'), autorizar(d.demandaId, '2.00', '2.00', 'admin-b')]);
      expect(resultados.filter((r) => r.autorizada)).toHaveLength(1);
      expect(resultados.filter((r) => !r.autorizada)).toEqual([{ autorizada: false, motivo: 'nao_bloqueada' }]);
      const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM autorizacoes_custo WHERE demanda_id = $1', [d.demandaId]);
      expect(rows[0].n).toBe(1);
    });
  });
});
