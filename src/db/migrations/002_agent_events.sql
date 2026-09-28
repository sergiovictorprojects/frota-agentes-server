-- Ledger operacional append-only (Fase 1 — Entrega 1). Aditiva: nenhuma tabela existente é alterada.
CREATE TABLE agent_events (
  -- Cursor global: cresce sempre, nunca reordena. É a chave de leitura "em ordem real de escrita"
  -- e a ordenação oficial de qualquer consulta — nunca ordenar por sequencia_demanda ou tentativa.
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- RESTRICT, não CASCADE: um ledger append-only não pode desaparecer porque a demanda foi apagada.
  -- Hoje nada no código apaga uma demanda de verdade (só "Arquivar", que é um UPDATE de status), então
  -- isso nunca deveria disparar em operação normal — e se algo tentar, o histórico vence, não a exclusão.
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  -- Identidade imutável da execução que gerou o evento: o run_id quando existe uma run (o caso normal
  -- da fila), ou um UUID gerado uma única vez no início de uma ação de interface (criar/reabrir por
  -- HTTP, sem run). NUNCA usar demandas.tentativas para isso — esse contador pode diminuir
  -- (devolverParaFila desfaz a tentativa de quem já tinha começado) ou zerar (reabrirDemanda), então
  -- duas execuções diferentes podem legitimamente ter o mesmo número de tentativa.
  correlacao_id uuid NOT NULL,
  -- Puramente informativo (para leitura humana: "isto foi a tentativa 3"). Nunca faz parte da chave de
  -- idempotência nem de qualquer UNIQUE — só correlacao_id garante isso. Anulável de propósito: eventos
  -- que não provam que o processamento chegou a começar (demanda_reivindicada, ou uma devolução para a
  -- fila antes de qualquer trabalho) gravam NULL aqui — um número seria uma tentativa que nunca
  -- aconteceu de verdade. O valor planejado, quando existe, fica em metadata.tentativaPlanejada.
  tentativa integer CHECK (tentativa >= 0),
  -- Sequência própria por demanda (1, 2, 3...), útil para "página 2 da timeline desta demanda"
  -- sem depender do cursor global, que é compartilhado por todas as demandas.
  sequencia_demanda bigint NOT NULL CHECK (sequencia_demanda > 0),
  tipo_evento text NOT NULL,
  schema_versao integer NOT NULL DEFAULT 1 CHECK (schema_versao > 0),
  -- Quem gerou o evento: "sistema", o papel do setor (frota:architect) ou "solicitante".
  ator text NOT NULL,
  -- Texto FIXO por tipo_evento (ver RESUMOS_POR_TIPO em src/db/eventos.ts) — nunca texto vindo da
  -- demanda, do modelo ou de uma mensagem de erro. O limite de tamanho é só uma rede de segurança.
  resumo text NOT NULL CHECK (char_length(resumo) BETWEEN 1 AND 2000),
  -- Validada por um schema por tipo_evento (METADATA_SCHEMAS em src/db/eventos.ts): só aceita o formato
  -- exato de cada tipo — ids, enums, contagens, flags, setor, status e códigos de erro classificados.
  -- Nunca texto livre. Um campo fora do schema, ou de tipo errado, é rejeitado antes do INSERT.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Impede duplicidade em retries: reenviar o mesmo evento é uma operação segura (idempotente).
  chave_idempotencia text NOT NULL CHECK (char_length(chave_idempotencia) BETWEEN 1 AND 300),
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (demanda_id, chave_idempotencia),
  UNIQUE (demanda_id, sequencia_demanda)
);

-- Não há índice separado para (demanda_id, sequencia_demanda): a constraint UNIQUE já cria esse índice
-- sozinha. O índice que listarEventosDaDemanda realmente usa (WHERE demanda_id = $1 ORDER BY id) é este:
CREATE INDEX agent_events_demanda_id_idx ON agent_events (demanda_id, id);
CREATE INDEX agent_events_run_idx ON agent_events (run_id, id);
CREATE INDEX agent_events_correlacao_idx ON agent_events (correlacao_id);
CREATE INDEX agent_events_tipo_idx ON agent_events (tipo_evento, ocorrido_em);

-- Append-only de verdade: bloqueado no banco, não só por convenção no código. Isto é sobre UPDATE/DELETE
-- de linhas de agent_events em si; a proteção contra apagar a demanda-mãe é o ON DELETE RESTRICT acima.
-- TRUNCATE ... CASCADE (usado na limpeza dos testes) continua funcionando porque TRUNCATE segue o grafo
-- de FKs de forma estrutural — ignora tanto o ON DELETE RESTRICT quanto estes gatilhos de linha, que só
-- disparam para UPDATE/DELETE. Um DELETE de verdade numa demanda com eventos, ou qualquer UPDATE/DELETE
-- direto em agent_events, é que ficam bloqueados.
CREATE FUNCTION agent_events_bloquear_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agent_events é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_events_impede_update
  BEFORE UPDATE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION agent_events_bloquear_alteracao();

CREATE TRIGGER agent_events_impede_delete
  BEFORE DELETE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION agent_events_bloquear_alteracao();
