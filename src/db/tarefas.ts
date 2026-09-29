import type pg from 'pg';
import { inserirArtefato, type ArtefatoValidado } from './artefatos.ts';
import type { CodigoErroTarefa } from './eventos.ts';
import { fixarRotaLegado, reservarCustoNaTransacao, type MotivoLegado } from './orquestracao.ts';
import type { EstadoTarefa, MotivoAbandono } from './planos.ts';
import { criarEntrega } from './relatorios.ts';
import { comTransacao, type Db } from './tx.ts';

// Fase 3.2a: ciclo de vida de um plano em execução e das suas tarefas (seções 4.4, 5.2 a 5.4 e 5.9 do plano e
// ADR 0007). Nada aqui é chamado pelo fluxo real nesta entrega: a PR 3.2b liga. O gatilho tarefas_controla
// (migration 006) é a garantia: estas funções só escolhem a transição, e o banco recusa qualquer outra.
//
// Sigilo: lease_token só autoriza persistir (condição de WHERE) e só sai daqui para o processo que fez o
// claim. Nunca vai para evento, log ou interface. claim_id pode ir: identifica o claim, não autoriza nada.
// objetivo é texto do modelo: só listarTarefasParaPrompt o devolve, para a serialização canônica.
//
// Ordem de locks, a mesma de src/db/orquestracao.ts: plano, tarefa, agente e envelope.

// Folga do lease além do timeout da chamada. Maior que a margem de persistência de 2 minutos (seção 5.1): o
// lease sempre dura mais que a chamada mais a gravação do resultado.
export const MARGEM_LEASE_SEGUNDOS = 180;

export type TipoTarefa = 'especialista' | 'integracao';

export interface SnapshotAgente {
  chave: string;
  versao: number;
  papel: 'coordenador' | 'executor';
  modelo: string;
}

export interface TarefaReivindicada {
  id: string;
  planoId: string;
  demandaId: string;
  chave: string;
  tipo: TipoTarefa;
  capacidade: string;
  claimId: string;
  leaseToken: string;
  leaseExpiraEm: string;
  tentativas: number;
  maxTentativas: number;
  timeoutSegundos: number;
  agente: SnapshotAgente;
}

export type ResultadoClaim =
  | { reivindicada: true; tarefa: TarefaReivindicada }
  | { reivindicada: false; motivo: 'sem_tarefa_pronta' }
  | { reivindicada: false; motivo: 'agente_indisponivel'; tarefaId: string };

// Ativa um plano registrado em modo execução e libera as tarefas sem dependência, numa transação. O banco
// confere a forma do plano (uma integração, de 1 a 3 especialistas com objetivo, aresta da integração para cada
// especialista) e o envelope na rota tarefas. Devolve ativado false se o plano não estava registrado.
export async function ativarPlano(
  pool: pg.Pool,
  planoId: string,
): Promise<{ ativado: true; versao: number; totalTarefas: number; tarefasProntas: number } | { ativado: false }> {
  return comTransacao(pool, async (cliente) => {
    const { rows } = await cliente.query<{ versao: number }>(
      "UPDATE planos_demanda SET estado = 'ativo' WHERE id = $1 AND estado = 'registrado' AND modo = 'execucao' RETURNING versao",
      [planoId],
    );
    if (!rows[0]) return { ativado: false };
    const { rows: total } = await cliente.query<{ n: number }>('SELECT count(*)::int AS n FROM tarefas WHERE plano_id = $1', [planoId]);
    const tarefasProntas = await promoverTarefasProntas(cliente, planoId);
    return { ativado: true, versao: rows[0].versao, totalTarefas: total[0]!.n, tarefasProntas };
  });
}

// pendente → pronta para toda tarefa cujas dependências estão concluídas. Roda na transação de quem ativa o
// plano ou conclui uma tarefa. Devolve quantas ficaram prontas.
export async function promoverTarefasProntas(db: Db, planoId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE tarefas t SET estado = 'pronta'
      WHERE t.plano_id = $1 AND t.estado = 'pendente'
        AND NOT EXISTS (
          SELECT 1 FROM tarefas_dependencias td JOIN tarefas d ON d.id = td.depende_de_id
           WHERE td.tarefa_id = t.id AND d.estado <> 'concluida'
        )`,
    [planoId],
  );
  return rowCount ?? 0;
}

// Claim numa transação curta (seção 5.2, passo 3): trava a primeira tarefa pronta por chave (collation "C"),
// escolhe no catálogo, com FOR SHARE, o agente ativo da capacidade e grava o snapshot e o lease. O banco gera
// claim_id e lease_token e confere o agente de novo. A tentativa ainda não conta. Sem agente elegível, nada é
// gravado e o motivo volta para quem chama (que abandona o plano com agente_indisponivel).
export async function reivindicarProximaTarefa(
  pool: pg.Pool,
  planoId: string,
  opcoes: { margemLeaseSegundos?: number } = {},
): Promise<ResultadoClaim> {
  const margem = opcoes.margemLeaseSegundos ?? MARGEM_LEASE_SEGUNDOS;
  return comTransacao(pool, async (cliente) => {
    const { rows: prontas } = await cliente.query<{ id: string; capacidade: string }>(
      `SELECT t.id, t.capacidade
         FROM tarefas t JOIN planos_demanda p ON p.id = t.plano_id
        WHERE t.plano_id = $1 AND t.estado = 'pronta' AND p.estado = 'ativo'
        ORDER BY t.chave COLLATE "C"
        LIMIT 1
        FOR UPDATE OF t SKIP LOCKED`,
      [planoId],
    );
    const pronta = prontas[0];
    if (!pronta) return { reivindicada: false, motivo: 'sem_tarefa_pronta' };

    const { rows: agentes } = await cliente.query<{ chave: string; versao: number; papel: SnapshotAgente['papel']; modelo_permitido: string }>(
      `SELECT chave, versao, papel, modelo_permitido FROM agentes
        WHERE categoria = $1 AND estado = 'ativo' AND papel IN ('coordenador','executor')
        ORDER BY chave COLLATE "C"
        LIMIT 1
        FOR SHARE`,
      [pronta.capacidade],
    );
    const agente = agentes[0];
    if (!agente) return { reivindicada: false, motivo: 'agente_indisponivel', tarefaId: pronta.id };

    const { rows } = await cliente.query<{
      id: string;
      plano_id: string;
      chave: string;
      tipo: TipoTarefa;
      capacidade: string;
      claim_id: string;
      lease_token: string;
      lease_expira_em: Date;
      tentativas: number;
      max_tentativas: number;
      timeout_segundos: number;
    }>(
      `UPDATE tarefas
          SET estado = 'em_execucao', agente_chave = $2, agente_versao = $3, agente_papel = $4, modelo = $5,
              lease_expira_em = now() + make_interval(secs => timeout_segundos + $6)
        WHERE id = $1
        RETURNING id, plano_id, chave, tipo, capacidade, claim_id, lease_token, lease_expira_em, tentativas, max_tentativas,
                  timeout_segundos`,
      [pronta.id, agente.chave, agente.versao, agente.papel, agente.modelo_permitido, margem],
    );
    const t = rows[0]!;
    const { rows: plano } = await cliente.query<{ demanda_id: string }>('SELECT demanda_id FROM planos_demanda WHERE id = $1', [
      t.plano_id,
    ]);
    return {
      reivindicada: true,
      tarefa: {
        id: t.id,
        planoId: t.plano_id,
        demandaId: plano[0]!.demanda_id,
        chave: t.chave,
        tipo: t.tipo,
        capacidade: t.capacidade,
        claimId: t.claim_id,
        leaseToken: t.lease_token,
        leaseExpiraEm: t.lease_expira_em.toISOString(),
        tentativas: t.tentativas,
        maxTentativas: t.max_tentativas,
        timeoutSegundos: t.timeout_segundos,
        agente: { chave: agente.chave, versao: agente.versao, papel: agente.papel, modelo: agente.modelo_permitido },
      },
    };
  });
}

export type ResultadoEnvio =
  | { registrado: true; claimId: string; reservaId: string; valorReservadoUsd: string; tentativa: number; leaseExpiraEm: string }
  | { registrado: false; motivo: 'lease_perdido' | 'agente_nao_autorizado' | 'agente_alterado' | 'demanda_bloqueada' }
  | { registrado: false; motivo: 'custo_demanda_excedido'; comprometidoUsd: string; limiteUsd: string; reservaUsd: string };

// Imediatamente antes do envio (seção 5.2, passo 5), numa transação atômica condicional ao token:
//   1. a tarefa continua deste claim, sem envio e com o lease valendo;
//   2. autorização final do agente do snapshot (FOR SHARE): ativo, com o modelo e a versão do claim;
//   3. reserva de custo, com o envelope travado e o comprometido recalculado;
//   4. registro de envio: a tentativa sobe exatamente 1 e o lease é renovado.
// Qualquer recusa volta sem gravar nada; quem chama devolve a tarefa (devolverTarefa) quando for o caso.
export async function reservarERegistrarEnvio(
  pool: pg.Pool,
  p: { tarefaId: string; leaseToken: string; valorReservadoUsd: string; margemLeaseSegundos?: number },
): Promise<ResultadoEnvio> {
  const margem = p.margemLeaseSegundos ?? MARGEM_LEASE_SEGUNDOS;
  return comTransacao(pool, async (cliente) => {
    const { rows: tarefas } = await cliente.query<{
      plano_id: string;
      demanda_id: string;
      tipo: TipoTarefa;
      claim_id: string;
      agente_chave: string;
      agente_versao: number;
      modelo: string;
      timeout_segundos: number;
    }>(
      `SELECT t.plano_id, p.demanda_id, t.tipo, t.claim_id, t.agente_chave, t.agente_versao, t.modelo, t.timeout_segundos
         FROM tarefas t JOIN planos_demanda p ON p.id = t.plano_id
        WHERE t.id = $1 AND t.lease_token = $2 AND t.estado = 'em_execucao' AND t.enviada_em IS NULL
          AND t.lease_expira_em > now()
        FOR UPDATE OF t`,
      [p.tarefaId, p.leaseToken],
    );
    const t = tarefas[0];
    if (!t) return { registrado: false, motivo: 'lease_perdido' };

    const { rows: agentes } = await cliente.query<{ estado: string; versao: number; modelo_permitido: string }>(
      'SELECT estado, versao, modelo_permitido FROM agentes WHERE chave = $1 FOR SHARE',
      [t.agente_chave],
    );
    const agente = agentes[0];
    if (!agente || agente.estado !== 'ativo' || agente.modelo_permitido !== t.modelo) {
      return { registrado: false, motivo: 'agente_nao_autorizado' };
    }
    if (agente.versao !== t.agente_versao) return { registrado: false, motivo: 'agente_alterado' };

    const reserva = await reservarCustoNaTransacao(cliente, {
      demandaId: t.demanda_id,
      planoId: t.plano_id,
      tarefaId: p.tarefaId,
      claimId: t.claim_id,
      operacao: t.tipo === 'especialista' ? 'execucao' : 'integracao',
      modelo: t.modelo,
      valorReservadoUsd: p.valorReservadoUsd,
      validadeSegundos: t.timeout_segundos + margem,
    });
    if (!reserva.reservada) {
      return reserva.motivo === 'custo_demanda_excedido'
        ? {
            registrado: false,
            motivo: reserva.motivo,
            comprometidoUsd: reserva.comprometidoUsd,
            limiteUsd: reserva.limiteUsd,
            reservaUsd: reserva.reservaUsd,
          }
        : { registrado: false, motivo: reserva.motivo };
    }

    const { rows } = await cliente.query<{ tentativas: number; lease_expira_em: Date }>(
      `UPDATE tarefas SET tentativas = tentativas + 1, lease_expira_em = now() + make_interval(secs => timeout_segundos + $3)
        WHERE id = $1 AND lease_token = $2
        RETURNING tentativas, lease_expira_em`,
      [p.tarefaId, p.leaseToken, margem],
    );
    return {
      registrado: true,
      claimId: t.claim_id,
      reservaId: reserva.reservaId,
      valorReservadoUsd: reserva.valorReservadoUsd,
      tentativa: rows[0]!.tentativas,
      leaseExpiraEm: rows[0]!.lease_expira_em.toISOString(),
    };
  });
}

// Parada antes do envio (prazo, pausa, orçamento, teto de custo, autorização final): em_execucao → pronta sem
// consumir tentativa. Condicional ao token e só antes do envio. Devolve o claimId do claim desfeito (o banco o
// limpa na transição) para o evento tarefa_devolvida.
export async function devolverTarefa(
  db: Db,
  p: { tarefaId: string; leaseToken: string },
): Promise<{ devolvida: true; claimId: string } | { devolvida: false }> {
  const { rows } = await db.query<{ claim_id: string }>(
    `WITH antes AS (
       SELECT id, claim_id FROM tarefas
        WHERE id = $1 AND lease_token = $2 AND estado = 'em_execucao' AND enviada_em IS NULL
        FOR UPDATE
     )
     UPDATE tarefas t SET estado = 'pronta' FROM antes WHERE t.id = antes.id
     RETURNING antes.claim_id`,
    [p.tarefaId, p.leaseToken],
  );
  return rows[0] ? { devolvida: true, claimId: rows[0].claim_id } : { devolvida: false };
}

export type ResultadoFalhaTentativa =
  | { registrada: true; claimId: string; tentativa: number; destino: 'pronta' | 'falhou'; definitiva: boolean }
  | { registrada: false };

// Falha depois do envio (a tentativa já contou): volta para pronta se ainda houver tentativa; senão, falhou
// com o código. Condicional ao token. Uma falha definitiva de verdade leva ao abandono do plano, que quem chama
// faz na mesma transação (abandonarPlano). contexto_excedido nunca passa por aqui: é antes do claim
// (falharPorContextoExcedido).
export async function falharTentativa(
  db: Db,
  p: { tarefaId: string; leaseToken: string; codigoErro: Exclude<CodigoErroTarefa, 'contexto_excedido'> },
): Promise<ResultadoFalhaTentativa> {
  if ((p.codigoErro as CodigoErroTarefa) === 'contexto_excedido') {
    throw new Error('contexto_excedido é detectado antes do claim: use falharPorContextoExcedido.');
  }
  const { rows } = await db.query<{ claim_id: string; tentativas: number; estado: EstadoTarefa }>(
    `WITH antes AS (
       SELECT id, claim_id, tentativas, max_tentativas FROM tarefas
        WHERE id = $1 AND lease_token = $2 AND estado = 'em_execucao' AND enviada_em IS NOT NULL
        FOR UPDATE
     )
     UPDATE tarefas t
        SET estado = CASE WHEN antes.tentativas < antes.max_tentativas THEN 'pronta' ELSE 'falhou' END,
            codigo_erro = CASE WHEN antes.tentativas < antes.max_tentativas THEN NULL ELSE $3 END
       FROM antes
      WHERE t.id = antes.id
     RETURNING antes.claim_id, antes.tentativas, t.estado`,
    [p.tarefaId, p.leaseToken, p.codigoErro],
  );
  const l = rows[0];
  if (!l) return { registrada: false };
  const destino = l.estado === 'pronta' ? 'pronta' : 'falhou';
  return { registrada: true, claimId: l.claim_id, tentativa: l.tentativas, destino, definitiva: destino === 'falhou' };
}

export type ResultadoConclusao =
  | {
      persistido: true;
      claimId: string;
      tentativa: number;
      artefatoId: string;
      bytes: number;
      totalReferencias: number;
      tarefasLiberadas: number;
      entregaId: string | null;
    }
  | { persistido: false; motivoDescarte: 'lease_perdido' | 'tarefa_encerrada' };

interface TarefaDoClaim {
  plano_id: string;
  demanda_id: string;
  tipo: TipoTarefa;
  claim_id: string;
  tentativas: number;
}

// Trava a tarefa do claim, com envio registrado. Sem ela, diz por que o resultado é descartado.
async function travarTarefaDoClaim(
  cliente: pg.PoolClient,
  tarefaId: string,
  leaseToken: string,
): Promise<TarefaDoClaim | { motivoDescarte: 'lease_perdido' | 'tarefa_encerrada' }> {
  const { rows } = await cliente.query<TarefaDoClaim>(
    `SELECT t.plano_id, p.demanda_id, t.tipo, t.claim_id, t.tentativas
       FROM tarefas t JOIN planos_demanda p ON p.id = t.plano_id
      WHERE t.id = $1 AND t.lease_token = $2 AND t.estado = 'em_execucao' AND t.enviada_em IS NOT NULL
      FOR UPDATE OF t`,
    [tarefaId, leaseToken],
  );
  if (rows[0]) return rows[0];
  const { rows: atual } = await cliente.query<{ estado: EstadoTarefa }>('SELECT estado FROM tarefas WHERE id = $1', [tarefaId]);
  const encerrada = atual[0] && ['concluida', 'falhou', 'cancelada'].includes(atual[0].estado);
  return { motivoDescarte: encerrada ? 'tarefa_encerrada' : 'lease_perdido' };
}

// Persistência condicional ao token (seção 5.2, passo 8) de uma especialista: artefato, conclusão e liberação
// das tarefas que dependiam dela, numa transação. Com token velho, nada é gravado.
export async function concluirTarefaEspecialista(
  pool: pg.Pool,
  p: { tarefaId: string; leaseToken: string; artefato: ArtefatoValidado },
): Promise<ResultadoConclusao> {
  return comTransacao(pool, async (cliente) => {
    const t = await travarTarefaDoClaim(cliente, p.tarefaId, p.leaseToken);
    if ('motivoDescarte' in t) return { persistido: false, motivoDescarte: t.motivoDescarte };
    if (t.tipo !== 'especialista') throw new Error('concluirTarefaEspecialista recebeu a integração.');
    const artefato = await inserirArtefato(cliente, { tarefaId: p.tarefaId, artefato: p.artefato });
    await cliente.query("UPDATE tarefas SET estado = 'concluida' WHERE id = $1", [p.tarefaId]);
    const tarefasLiberadas = await promoverTarefasProntas(cliente, t.plano_id);
    return {
      persistido: true,
      claimId: t.claim_id,
      tentativa: t.tentativas,
      artefatoId: artefato.id,
      bytes: artefato.bytes,
      totalReferencias: p.artefato.referencias.length,
      tarefasLiberadas,
      entregaId: null,
    };
  });
}

// Integração e entrega única (seção 5.7): numa só transação condicional ao token, grava o artefato, cria a
// entrega, grava o entrega_id e conclui a tarefa. O banco recusa entrega de outra demanda e entrega repetida.
// O conteúdo da entrega já vem pronto para hospedar (o mesmo tratamento de hospedarEntrega).
export async function concluirIntegracao(
  pool: pg.Pool,
  p: { tarefaId: string; leaseToken: string; artefato: ArtefatoValidado; entrega: { titulo: string; conteudo: string } },
): Promise<ResultadoConclusao> {
  return comTransacao(pool, async (cliente) => {
    const t = await travarTarefaDoClaim(cliente, p.tarefaId, p.leaseToken);
    if ('motivoDescarte' in t) return { persistido: false, motivoDescarte: t.motivoDescarte };
    if (t.tipo !== 'integracao') throw new Error('concluirIntegracao recebeu uma especialista.');
    const artefato = await inserirArtefato(cliente, { tarefaId: p.tarefaId, artefato: p.artefato });
    const entrega = await criarEntrega(cliente, { demandaId: t.demanda_id, titulo: p.entrega.titulo, conteudo: p.entrega.conteudo });
    await cliente.query("UPDATE tarefas SET estado = 'concluida', entrega_id = $2 WHERE id = $1", [p.tarefaId, entrega.id]);
    return {
      persistido: true,
      claimId: t.claim_id,
      tentativa: t.tentativas,
      artefatoId: artefato.id,
      bytes: artefato.bytes,
      totalReferencias: p.artefato.referencias.length,
      tarefasLiberadas: 0,
      entregaId: entrega.id,
    };
  });
}

// ativo → concluido. O banco exige a integração concluída e com entrega. Roda na transação do relatório (PR
// 3.2b). Devolve false se o plano não estava ativo.
export async function concluirPlano(db: Db, planoId: string): Promise<boolean> {
  const { rowCount } = await db.query("UPDATE planos_demanda SET estado = 'concluido' WHERE id = $1 AND estado = 'ativo'", [planoId]);
  return rowCount === 1;
}

export type ResultadoAbandono =
  | { abandonado: true; demandaId: string; versao: number; tarefasCanceladas: number; rotaFixada: boolean }
  | { abandonado: false };

// Motivos de abandono que fixam a rota legado_fixo, com o mesmo motivo (seção 5.9).
const ABANDONO_FIXA_ROTA: ReadonlySet<MotivoAbandono> = new Set(['tarefa_falhou', 'agente_indisponivel']);

async function marcarAbandono(
  cliente: pg.PoolClient,
  planoId: string,
  motivo: MotivoAbandono,
): Promise<{ demanda_id: string; versao: number } | undefined> {
  const { rows } = await cliente.query<{ demanda_id: string; versao: number }>(
    "UPDATE planos_demanda SET estado = 'abandonado', motivo_abandono = $2 WHERE id = $1 AND estado = 'ativo' RETURNING demanda_id, versao",
    [planoId, motivo],
  );
  return rows[0];
}

async function cancelarTarefasAbertas(cliente: pg.PoolClient, planoId: string): Promise<number> {
  const { rowCount } = await cliente.query(
    "UPDATE tarefas SET estado = 'cancelada' WHERE plano_id = $1 AND estado IN ('pendente','pronta','em_execucao')",
    [planoId],
  );
  return rowCount ?? 0;
}

// Abandona o plano ativo, cancela as tarefas abertas e, para tarefa_falhou e agente_indisponivel, fixa a rota
// legado_fixo. Roda na transação de quem chama, que pode juntar a falha da tarefa ou a pendência humana. O
// gatilho adiado recusa o COMMIT se sobrar tarefa aberta ou rota sem fixar.
export async function abandonarPlano(
  cliente: pg.PoolClient,
  p: { planoId: string; motivo: MotivoAbandono },
): Promise<ResultadoAbandono> {
  const plano = await marcarAbandono(cliente, p.planoId, p.motivo);
  if (!plano) return { abandonado: false };
  const tarefasCanceladas = await cancelarTarefasAbertas(cliente, p.planoId);
  const rotaFixada = ABANDONO_FIXA_ROTA.has(p.motivo)
    ? await fixarRotaLegado(cliente, { demandaId: plano.demanda_id, motivo: p.motivo as MotivoLegado })
    : false;
  return { abandonado: true, demandaId: plano.demanda_id, versao: plano.versao, tarefasCanceladas, rotaFixada };
}

export type ResultadoContextoExcedido =
  | { registrada: true; planoId: string; demandaId: string; versao: number; tipo: TipoTarefa; tentativa: number; tarefasCanceladas: number }
  | { registrada: false };

// contexto_excedido (seção 5.5): erro determinístico medido antes do claim. Numa única transação, a tarefa
// vai de pronta para falhou (sem claim, sem reserva e sem consumir tentativa), o plano é abandonado por
// tarefa_falhou, as demais tarefas abertas são canceladas e a rota fica legado_fixo. Nada se repete sozinho.
export async function falharPorContextoExcedido(pool: pg.Pool, tarefaId: string): Promise<ResultadoContextoExcedido> {
  return comTransacao(pool, async (cliente) => {
    const { rows } = await cliente.query<{ plano_id: string; demanda_id: string; tipo: TipoTarefa; tentativas: number }>(
      `SELECT t.plano_id, p.demanda_id, t.tipo, t.tentativas
         FROM tarefas t JOIN planos_demanda p ON p.id = t.plano_id
        WHERE t.id = $1 AND t.estado = 'pronta' AND p.estado = 'ativo'
        FOR UPDATE OF t`,
      [tarefaId],
    );
    const t = rows[0];
    if (!t) return { registrada: false };
    const plano = (await marcarAbandono(cliente, t.plano_id, 'tarefa_falhou'))!;
    await cliente.query("UPDATE tarefas SET estado = 'falhou', codigo_erro = 'contexto_excedido' WHERE id = $1", [tarefaId]);
    const tarefasCanceladas = await cancelarTarefasAbertas(cliente, t.plano_id);
    await fixarRotaLegado(cliente, { demandaId: t.demanda_id, motivo: 'tarefa_falhou' });
    return {
      registrada: true,
      planoId: t.plano_id,
      demandaId: t.demanda_id,
      versao: plano.versao,
      tipo: t.tipo,
      tentativa: t.tentativas,
      tarefasCanceladas,
    };
  });
}

export interface LeaseRecuperado {
  tarefaId: string;
  claimId: string;
  tentativa: number;
  enviada: boolean;
  destino: 'pronta' | 'falhou';
}

// Retomada (seção 5.3): tarefa em execução com lease vencido. Sem envio registrado, nada foi enviado e ela volta
// para pronta. Com envio, a tentativa já contou: volta para pronta se ainda houver tentativa; senão, falhou com
// lease_expirado. Devolve o claim de cada uma para o evento tarefa_lease_expirado. Um lease ainda válido não é
// tocado.
export async function recuperarLeasesVencidos(db: Db, planoId: string): Promise<LeaseRecuperado[]> {
  const { rows } = await db.query<{ id: string; claim_id: string; tentativas: number; enviada: boolean; estado: EstadoTarefa }>(
    `WITH vencidas AS (
       SELECT id, claim_id, tentativas, max_tentativas, enviada_em IS NOT NULL AS enviada
         FROM tarefas
        WHERE plano_id = $1 AND estado = 'em_execucao' AND lease_expira_em < now()
        FOR UPDATE SKIP LOCKED
     )
     UPDATE tarefas t
        SET estado = CASE WHEN NOT v.enviada OR v.tentativas < v.max_tentativas THEN 'pronta' ELSE 'falhou' END,
            codigo_erro = CASE WHEN NOT v.enviada OR v.tentativas < v.max_tentativas THEN NULL ELSE 'lease_expirado' END
       FROM vencidas v
      WHERE t.id = v.id
     RETURNING t.id, v.claim_id, v.tentativas, v.enviada, t.estado`,
    [planoId],
  );
  return rows
    .map((l) => ({
      tarefaId: l.id,
      claimId: l.claim_id,
      tentativa: l.tentativas,
      enviada: l.enviada,
      destino: l.estado === 'pronta' ? ('pronta' as const) : ('falhou' as const),
    }))
    .sort((a, b) => (a.tarefaId < b.tarefaId ? -1 : a.tarefaId > b.tarefaId ? 1 : 0));
}

export interface TarefaResumo {
  id: string;
  chave: string;
  tipo: TipoTarefa;
  capacidade: string;
  estado: EstadoTarefa;
  tentativas: number;
  maxTentativas: number;
  claimId: string | null;
  agente: SnapshotAgente | null;
  leaseExpiraEm: string | null;
  enviadaEm: string | null;
  iniciadaEm: string | null;
  concluidaEm: string | null;
  codigoErro: CodigoErroTarefa | null;
  entregaId: string | null;
}

// Leitura das tarefas de um plano, em ordem de execução (especialistas por chave, integração por último).
// Nunca devolve objetivo nem lease_token.
export async function listarTarefasDoPlano(db: Db, planoId: string): Promise<TarefaResumo[]> {
  const { rows } = await db.query<{
    id: string;
    chave: string;
    tipo: TipoTarefa;
    capacidade: string;
    estado: EstadoTarefa;
    tentativas: number;
    max_tentativas: number;
    claim_id: string | null;
    agente_chave: string | null;
    agente_versao: number | null;
    agente_papel: SnapshotAgente['papel'] | null;
    modelo: string | null;
    lease_expira_em: Date | null;
    enviada_em: Date | null;
    iniciada_em: Date | null;
    concluida_em: Date | null;
    codigo_erro: CodigoErroTarefa | null;
    entrega_id: string | null;
  }>(
    `SELECT id, chave, tipo, capacidade, estado, tentativas, max_tentativas, claim_id, agente_chave, agente_versao,
            agente_papel, modelo, lease_expira_em, enviada_em, iniciada_em, concluida_em, codigo_erro, entrega_id
       FROM tarefas WHERE plano_id = $1
      ORDER BY tipo = 'integracao', chave COLLATE "C"`,
    [planoId],
  );
  const data = (d: Date | null) => (d ? d.toISOString() : null);
  return rows.map((l) => ({
    id: l.id,
    chave: l.chave,
    tipo: l.tipo,
    capacidade: l.capacidade,
    estado: l.estado,
    tentativas: l.tentativas,
    maxTentativas: l.max_tentativas,
    claimId: l.claim_id,
    agente:
      l.agente_chave !== null
        ? { chave: l.agente_chave, versao: l.agente_versao!, papel: l.agente_papel!, modelo: l.modelo! }
        : null,
    leaseExpiraEm: data(l.lease_expira_em),
    enviadaEm: data(l.enviada_em),
    iniciadaEm: data(l.iniciada_em),
    concluidaEm: data(l.concluida_em),
    codigoErro: l.codigo_erro,
    entregaId: l.entrega_id,
  }));
}

// Uso interno, só para montar o prompt (PR 3.2b): chave e objetivo das tarefas do plano, em ordem de chave. O
// objetivo é texto do modelo e só entra no prompt pela serialização canônica (src/orchestrator/serializacao.ts).
export async function listarTarefasParaPrompt(
  db: Db,
  planoId: string,
): Promise<{ id: string; chave: string; tipo: TipoTarefa; objetivo: string | null }[]> {
  const { rows } = await db.query<{ id: string; chave: string; tipo: TipoTarefa; objetivo: string | null }>(
    `SELECT id, chave, tipo, objetivo FROM tarefas WHERE plano_id = $1 ORDER BY tipo = 'integracao', chave COLLATE "C"`,
    [planoId],
  );
  return rows;
}
