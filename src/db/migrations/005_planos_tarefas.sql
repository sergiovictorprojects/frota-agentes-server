-- Fase 3 — Entrega 3.1 (Orquestração Real por Tarefas, modo "planejar"). Aditiva: nenhuma tabela existente
-- perde coluna nem muda de significado. Nesta entrega o plano é só GRAVADO e VALIDADO (modo "shadow"): a
-- demanda continua sendo executada inteira pelo fluxo legado, e nenhuma tarefa é executada. Ver
-- docs/adr/0006-orquestracao-por-tarefas.md.
--
-- Nenhuma coluna guarda texto livre do modelo ou da demanda: uma tarefa é só uma chave curta (slug), uma
-- capacidade de domínio fechado e as dependências. Prompt, instrução, raciocínio e resposta bruta nunca
-- entram aqui.

-- Um plano por (demanda, versão). criado_pela_run_id é a run que CRIOU o plano e nunca muda: não representa
-- a execução atual (quem executa uma tarefa, a partir da 3.2, fica registrado na própria tarefa).
CREATE TABLE planos_demanda (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE RESTRICT,
  versao integer NOT NULL CHECK (versao > 0),
  criado_pela_run_id uuid REFERENCES runs(id) ON DELETE RESTRICT,
  -- shadow: plano gravado em ORQUESTRACAO_TAREFAS=planejar, que nunca executa.
  modo text NOT NULL CHECK (modo IN ('shadow','execucao')),
  estado text NOT NULL CHECK (estado IN ('registrado','ativo','concluido','abandonado','rejeitado')),
  -- Código fechado de por que a validação determinística recusou o plano; nunca texto do modelo.
  motivo_rejeicao text CHECK (motivo_rejeicao IN (
    'sem_tarefas','limite_tarefas','chave_duplicada','chave_reservada','dependencia_inexistente','autodependencia','ciclo'
  )),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (demanda_id, versao),
  UNIQUE (id, demanda_id),
  CHECK ((estado = 'rejeitado') = (motivo_rejeicao IS NOT NULL)),
  -- Um plano shadow é só registro: nunca vira ativo nem concluído.
  CHECK (NOT (modo = 'shadow' AND estado IN ('ativo','concluido')))
);
-- No máximo um plano ativo por demanda. Planos shadow ficam "registrado" e não disputam este índice.
CREATE UNIQUE INDEX planos_demanda_um_ativo_idx ON planos_demanda (demanda_id) WHERE estado = 'ativo';

-- Nasce registrado ou rejeitado; depois só as transições registrado → ativo | abandonado e
-- ativo → concluido | abandonado. Identidade (demanda, versão, run de criação, modo) é imutável, e um
-- plano nunca é apagado: é histórico.
CREATE FUNCTION planos_demanda_controlar() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planos_demanda é histórico: DELETE não é permitido';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado NOT IN ('registrado','rejeitado') THEN
      RAISE EXCEPTION 'plano nasce registrado ou rejeitado, não %', NEW.estado;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.demanda_id <> OLD.demanda_id OR NEW.versao <> OLD.versao
     OR NEW.criado_pela_run_id IS DISTINCT FROM OLD.criado_pela_run_id OR NEW.modo <> OLD.modo
     OR NEW.motivo_rejeicao IS DISTINCT FROM OLD.motivo_rejeicao OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'identidade do plano é imutável';
  END IF;
  IF NEW.estado <> OLD.estado AND NOT (
       (OLD.estado = 'registrado' AND NEW.estado IN ('ativo','abandonado'))
    OR (OLD.estado = 'ativo' AND NEW.estado IN ('concluido','abandonado'))
  ) THEN
    RAISE EXCEPTION 'transição de plano não permitida: % → %', OLD.estado, NEW.estado;
  END IF;
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planos_demanda_controla
  BEFORE INSERT OR UPDATE OR DELETE ON planos_demanda
  FOR EACH ROW EXECUTE FUNCTION planos_demanda_controlar();

-- Sem demanda_id: a demanda é derivável pelo plano, então não há como divergir. Os campos de execução
-- (lease, tentativas, prazos, entrega) já existem para a 3.2, mas nesta entrega toda tarefa fica "pendente".
CREATE TABLE tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plano_id uuid NOT NULL REFERENCES planos_demanda(id) ON DELETE RESTRICT,
  chave text NOT NULL CHECK (chave ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  tipo text NOT NULL CHECK (tipo IN ('especialista','integracao')),
  capacidade text NOT NULL CHECK (capacidade IN (
    'gestores','d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11','d12','d13','d14','d15','d16','d17','d18'
  )),
  agente_chave text CHECK (agente_chave IS NULL OR agente_chave ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
  estado text NOT NULL DEFAULT 'pendente' CHECK (estado IN (
    'pendente','pronta','aguardando_agente','em_execucao','concluida','falhou','cancelada'
  )),
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  max_tentativas integer NOT NULL DEFAULT 2 CHECK (max_tentativas BETWEEN 1 AND 5),
  prazo_segundos integer NOT NULL DEFAULT 600 CHECK (prazo_segundos BETWEEN 30 AND 3600),
  lease_token uuid,
  lease_expira_em timestamptz,
  aguardando_agente_desde timestamptz,
  iniciada_em timestamptz,
  concluida_em timestamptz,
  codigo_erro text CHECK (codigo_erro IS NULL OR codigo_erro ~ '^[a-z_]{1,40}$'),
  entrega_id uuid REFERENCES entregas(id) ON DELETE RESTRICT,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plano_id, chave),
  CHECK ((lease_token IS NULL) = (lease_expira_em IS NULL)),
  CHECK (entrega_id IS NULL OR tipo = 'integracao')
);
-- Uma única tarefa de integração por plano: é ela que cria a entrega final (a partir da 3.2).
CREATE UNIQUE INDEX tarefas_uma_integracao_idx ON tarefas (plano_id) WHERE tipo = 'integracao';

-- A identidade da tarefa (plano, chave, tipo, capacidade) é imutável e uma tarefa nunca é apagada. Os campos
-- de execução mudam a partir da 3.2.
CREATE FUNCTION tarefas_controlar() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tarefas é histórico: DELETE não é permitido';
  END IF;
  IF NEW.id <> OLD.id OR NEW.plano_id <> OLD.plano_id OR NEW.chave <> OLD.chave OR NEW.tipo <> OLD.tipo
     OR NEW.capacidade <> OLD.capacidade OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'identidade da tarefa é imutável';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tarefas_controla
  BEFORE UPDATE OR DELETE ON tarefas
  FOR EACH ROW EXECUTE FUNCTION tarefas_controlar();

-- Arestas do grafo. As duas pontas precisam ser do MESMO plano (garantido pelo gatilho); a ausência de
-- ciclos é validada na aplicação antes da transação que grava o plano. Append-only.
CREATE TABLE tarefas_dependencias (
  tarefa_id uuid NOT NULL REFERENCES tarefas(id) ON DELETE RESTRICT,
  depende_de_id uuid NOT NULL REFERENCES tarefas(id) ON DELETE RESTRICT,
  PRIMARY KEY (tarefa_id, depende_de_id),
  CHECK (tarefa_id <> depende_de_id)
);
CREATE INDEX tarefas_dependencias_depende_idx ON tarefas_dependencias (depende_de_id);

CREATE FUNCTION tarefas_dependencias_controlar() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tarefas_dependencias é append-only: % não é permitido', TG_OP;
  END IF;
  IF (SELECT plano_id FROM tarefas WHERE id = NEW.tarefa_id)
     IS DISTINCT FROM (SELECT plano_id FROM tarefas WHERE id = NEW.depende_de_id) THEN
    RAISE EXCEPTION 'dependência entre tarefas de planos diferentes não é permitida';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tarefas_dependencias_controla
  BEFORE INSERT OR UPDATE OR DELETE ON tarefas_dependencias
  FOR EACH ROW EXECUTE FUNCTION tarefas_dependencias_controlar();

-- Policy Engine: o vocabulário fechado de "operacao" ganha "planejamento" (a chamada do coordenador que
-- propõe o plano, já nesta entrega) e "integracao" (a partir da 3.2). Só ACRESCENTA valores: toda condição
-- e todo contexto já gravados continuam válidos. Mesma regra do Zod em src/db/politicas.ts
-- (OPERACOES_AVALIADAS); test/db/politicas.test.ts confere as duas listas por SQL direto.
CREATE OR REPLACE FUNCTION politica_condicao_valida(c jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN c IS NULL OR jsonb_typeof(c) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_each(c) AS e(chave, valor)
       WHERE jsonb_typeof(e.valor) <> 'string'
          OR NOT CASE e.chave
               WHEN 'agente' THEN (e.valor #>> '{}') ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'
               WHEN 'modelo' THEN (e.valor #>> '{}') ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'
               WHEN 'papel' THEN (e.valor #>> '{}') IN ('coordenador','executor','avaliador','auditor')
               WHEN 'categoria' THEN (e.valor #>> '{}') IN (
                 'gestores','d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11','d12','d13','d14','d15','d16','d17','d18'
               )
               WHEN 'estado' THEN (e.valor #>> '{}') IN ('ativo','suspenso','sob_demanda','desconhecido')
               WHEN 'operacao' THEN (e.valor #>> '{}') IN ('execucao','auditoria','planejamento','integracao')
               WHEN 'prioridade' THEN (e.valor #>> '{}') IN ('CRITICAL','HIGH','MEDIUM','LOW')
               ELSE false
             END
    )
  END
$$;
