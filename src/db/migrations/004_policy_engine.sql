-- Policy Engine determinístico em modo shadow (Fase 2 — Entrega 2). Aditiva: nenhuma tabela existente é
-- alterada. Somente observacional nesta entrega: registra decisões, nunca bloqueia, pausa ou exige
-- aprovação de verdade no fluxo de produção (ver docs/adr/0004-policy-engine-shadow.md).
CREATE TABLE politicas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave text NOT NULL UNIQUE CHECK (char_length(chave) BETWEEN 1 AND 100),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 200),
  descricao text NOT NULL CHECK (char_length(descricao) BETWEEN 1 AND 500),
  estado text NOT NULL DEFAULT 'ativa' CHECK (estado IN ('ativa','inativa')),
  versao integer NOT NULL DEFAULT 1 CHECK (versao > 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX politicas_estado_idx ON politicas (estado);

-- Trilha append-only de mudanças de política — mesmo padrão comprovado em agentes/agentes_historico
-- (migration 003). id, chave, nome e descricao são imutáveis (sem rota de administração nesta entrega);
-- estado pode mudar. A garantia de trilha é do PRÓPRIO GATILHO, não de uma permissão de sessão: qualquer
-- UPDATE que mude estado é capturado, sempre, não importa o caminho (atualizarPolitica() ou SQL direto).
CREATE TABLE politicas_historico (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  politica_id uuid NOT NULL REFERENCES politicas(id) ON DELETE RESTRICT,
  ator text NOT NULL CHECK (ator ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  campos_alterados jsonb NOT NULL,
  versao_anterior integer NOT NULL CHECK (versao_anterior > 0),
  versao_nova integer NOT NULL CHECK (versao_nova > versao_anterior),
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX politicas_historico_politica_idx ON politicas_historico (politica_id, id);

CREATE FUNCTION politicas_historico_bloquear_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'politicas_historico é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER politicas_historico_impede_update
  BEFORE UPDATE ON politicas_historico
  FOR EACH ROW EXECUTE FUNCTION politicas_historico_bloquear_alteracao();

CREATE TRIGGER politicas_historico_impede_delete
  BEFORE DELETE ON politicas_historico
  FOR EACH ROW EXECUTE FUNCTION politicas_historico_bloquear_alteracao();

CREATE FUNCTION politicas_controlar_mudancas() RETURNS trigger AS $$
DECLARE
  campos jsonb;
  ator_da_mudanca text;
BEGIN
  IF NEW.id <> OLD.id OR NEW.chave <> OLD.chave OR NEW.nome <> OLD.nome OR NEW.descricao <> OLD.descricao THEN
    RAISE EXCEPTION 'politicas: id, chave, nome e descricao são imutáveis nesta entrega';
  END IF;

  IF NEW.estado = OLD.estado THEN
    -- Nada mudou de fato: nunca aceita versao/atualizado_em vindos de fora sem uma mudança real por trás.
    NEW.versao := OLD.versao;
    NEW.atualizado_em := OLD.atualizado_em;
    RETURN NEW;
  END IF;

  campos := jsonb_build_object('estado', jsonb_build_object('de', OLD.estado, 'para', NEW.estado));
  ator_da_mudanca := coalesce(nullif(current_setting('frota.ator_da_alteracao', true), ''), 'sistema:sql_direto');

  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := now();

  INSERT INTO politicas_historico (politica_id, ator, campos_alterados, versao_anterior, versao_nova)
  VALUES (OLD.id, ator_da_mudanca, campos, OLD.versao, NEW.versao);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER politicas_controla_mudancas
  BEFORE UPDATE ON politicas
  FOR EACH ROW EXECUTE FUNCTION politicas_controlar_mudancas();

-- Regras: totalmente append-only, sem nenhum campo mutável — mudar uma condição ou decisão é criar uma
-- regra nova (novo id/chave), nunca editar uma existente. Ativar/desativar acontece no nível da política
-- inteira (politicas.estado), não por regra.
CREATE TABLE regras_politica (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  politica_id uuid NOT NULL REFERENCES politicas(id) ON DELETE RESTRICT,
  chave text NOT NULL UNIQUE CHECK (char_length(chave) BETWEEN 1 AND 100),
  estagio text NOT NULL CHECK (estagio IN ('pre','during','post')),
  decisao text NOT NULL CHECK (decisao IN ('allow','warn','require_approval','deny')),
  -- Allowlist estruturada, validada por schema Zod na aplicação (src/db/politicas.ts): só os campos
  -- agente, papel, categoria, estado, modelo, operacao e prioridade, com os mesmos domínios fechados já
  -- usados em agentes/demandas — nunca uma expressão livre, nunca código, nunca LLM.
  condicao jsonb NOT NULL,
  versao integer NOT NULL DEFAULT 1 CHECK (versao > 0),
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX regras_politica_estagio_idx ON regras_politica (estagio, politica_id);

CREATE FUNCTION regras_politica_bloquear_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'regras_politica é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER regras_politica_impede_update
  BEFORE UPDATE ON regras_politica
  FOR EACH ROW EXECUTE FUNCTION regras_politica_bloquear_alteracao();

CREATE TRIGGER regras_politica_impede_delete
  BEFORE DELETE ON regras_politica
  FOR EACH ROW EXECUTE FUNCTION regras_politica_bloquear_alteracao();

-- Avaliações: o log append-only de cada decisão do motor, em modo shadow — nunca altera o status da
-- demanda, nunca bloqueia. Cursor global (id) no mesmo padrão de agent_events (migration 002).
CREATE TABLE avaliacoes_politica (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  regra_id uuid REFERENCES regras_politica(id) ON DELETE RESTRICT,
  politica_id uuid REFERENCES politicas(id) ON DELETE RESTRICT,
  -- regra_id e politica_id são nulos juntos: significa que nenhuma regra ativa casou com o contexto, e a
  -- decisão implícita (allow) foi registrada mesmo assim, para completude observacional.
  CHECK ((regra_id IS NULL) = (politica_id IS NULL)),
  estagio text NOT NULL CHECK (estagio IN ('pre','during','post')),
  decisao text NOT NULL CHECK (decisao IN ('allow','warn','require_approval','deny')),
  -- Snapshot do contexto avaliado — os mesmos campos fechados da condição, nunca texto livre da demanda.
  contexto jsonb NOT NULL,
  versao_regra integer,
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX avaliacoes_politica_demanda_idx ON avaliacoes_politica (demanda_id, id);
CREATE INDEX avaliacoes_politica_run_idx ON avaliacoes_politica (run_id, id);

CREATE FUNCTION avaliacoes_politica_bloquear_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'avaliacoes_politica é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER avaliacoes_politica_impede_update
  BEFORE UPDATE ON avaliacoes_politica
  FOR EACH ROW EXECUTE FUNCTION avaliacoes_politica_bloquear_alteracao();

CREATE TRIGGER avaliacoes_politica_impede_delete
  BEFORE DELETE ON avaliacoes_politica
  FOR EACH ROW EXECUTE FUNCTION avaliacoes_politica_bloquear_alteracao();
