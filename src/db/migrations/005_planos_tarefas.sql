-- Fase 3 — Entrega 3.1 (Orquestração Real por Tarefas, modo "planejar"). Aditiva: nenhuma tabela existente
-- perde coluna nem muda de significado. Esta migration representa SÓ o plano em shadow: o plano é gravado e
-- validado, a demanda continua sendo executada inteira pelo fluxo legado, e nenhuma tarefa é executada.
-- Campos e estados de execução (agente escolhido, tentativas, lease, prazos, código de erro, entrega, plano
-- ativo, transições) NÃO existem aqui: entram na migration 006, junto com a máquina de estados da 3.2. Ver
-- docs/adr/0006-orquestracao-por-tarefas.md.
--
-- Nenhuma coluna guarda texto livre do modelo ou da demanda: uma tarefa é só uma chave curta (slug), uma
-- capacidade de domínio fechado e as dependências. Prompt, instrução, raciocínio e resposta bruta nunca
-- entram aqui.

-- Um plano por (demanda, versão). criado_pela_run_id é a run que CRIOU o plano. Nesta entrega todo plano é
-- shadow e nasce já no estado final: registrado (válido) ou rejeitado (com motivo). Por isso é imutável.
CREATE TABLE planos_demanda (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE RESTRICT,
  versao integer NOT NULL CHECK (versao > 0),
  criado_pela_run_id uuid REFERENCES runs(id) ON DELETE RESTRICT,
  modo text NOT NULL CHECK (modo = 'shadow'),
  estado text NOT NULL CHECK (estado IN ('registrado','rejeitado')),
  -- Código fechado de por que a validação determinística recusou o plano; nunca texto do modelo.
  motivo_rejeicao text CHECK (motivo_rejeicao IN (
    'sem_tarefas','limite_tarefas','chave_duplicada','chave_reservada','capacidade_nao_executora',
    'dependencia_inexistente','autodependencia','ciclo'
  )),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (demanda_id, versao),
  CHECK ((estado = 'rejeitado') = (motivo_rejeicao IS NOT NULL))
);

-- Histórico imutável: nem UPDATE nem DELETE.
CREATE FUNCTION planos_demanda_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'planos_demanda é imutável nesta fase: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planos_demanda_imutavel
  BEFORE UPDATE OR DELETE ON planos_demanda
  FOR EACH ROW EXECUTE FUNCTION planos_demanda_imutavel();

-- Sem demanda_id: a demanda é derivável pelo plano, então não há como divergir. Só a representação do
-- plano: identidade, plano, chave, tipo, capacidade e estado, que é sempre "pendente" (shadow não executa).
-- d17 é o auditor (frota:agent-evaluator) e nunca é capacidade de tarefa; "gestores" é só da integração.
CREATE TABLE tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plano_id uuid NOT NULL REFERENCES planos_demanda(id) ON DELETE RESTRICT,
  chave text NOT NULL CHECK (chave ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  tipo text NOT NULL CHECK (tipo IN ('especialista','integracao')),
  capacidade text NOT NULL CHECK (capacidade IN (
    'gestores','d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11','d12','d13','d14','d15','d16','d18'
  )),
  estado text NOT NULL DEFAULT 'pendente' CHECK (estado = 'pendente'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plano_id, chave),
  CHECK ((tipo = 'integracao') = (capacidade = 'gestores'))
);
-- Uma única tarefa de integração por plano.
CREATE UNIQUE INDEX tarefas_uma_integracao_idx ON tarefas (plano_id) WHERE tipo = 'integracao';

-- Só um plano registrado recebe tarefas (um rejeitado fica sem nenhuma); depois disso a tarefa é imutável.
CREATE FUNCTION tarefas_controlar() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tarefas é imutável nesta fase: % não é permitido', TG_OP;
  END IF;
  IF (SELECT estado FROM planos_demanda WHERE id = NEW.plano_id) IS DISTINCT FROM 'registrado' THEN
    RAISE EXCEPTION 'só um plano registrado recebe tarefas';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tarefas_controla
  BEFORE INSERT OR UPDATE OR DELETE ON tarefas
  FOR EACH ROW EXECUTE FUNCTION tarefas_controlar();

-- Arestas do grafo. Append-only; as duas pontas no MESMO plano; e sem ciclo, garantido também no banco
-- (a aplicação já valida antes, em validarPlano): cada aresta nova é recusada se a tarefa de destino já
-- alcança a de origem pelas arestas existentes. A linha do plano é travada (FOR UPDATE, que não dispara o
-- gatilho de UPDATE) para serializar inserções concorrentes de arestas no mesmo plano.
CREATE TABLE tarefas_dependencias (
  tarefa_id uuid NOT NULL REFERENCES tarefas(id) ON DELETE RESTRICT,
  depende_de_id uuid NOT NULL REFERENCES tarefas(id) ON DELETE RESTRICT,
  PRIMARY KEY (tarefa_id, depende_de_id),
  CHECK (tarefa_id <> depende_de_id)
);
CREATE INDEX tarefas_dependencias_depende_idx ON tarefas_dependencias (depende_de_id);

CREATE FUNCTION tarefas_dependencias_controlar() RETURNS trigger AS $$
DECLARE
  plano_origem uuid;
  plano_destino uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tarefas_dependencias é append-only: % não é permitido', TG_OP;
  END IF;
  SELECT plano_id INTO plano_origem FROM tarefas WHERE id = NEW.tarefa_id;
  SELECT plano_id INTO plano_destino FROM tarefas WHERE id = NEW.depende_de_id;
  IF plano_origem IS DISTINCT FROM plano_destino THEN
    RAISE EXCEPTION 'dependência entre tarefas de planos diferentes não é permitida';
  END IF;
  PERFORM 1 FROM planos_demanda WHERE id = plano_origem FOR UPDATE;
  -- NEW = (tarefa_id depende de depende_de_id). Há ciclo se depende_de_id já depende, direta ou
  -- indiretamente, de tarefa_id.
  IF EXISTS (
    WITH RECURSIVE alcancaveis(id) AS (
      SELECT td.depende_de_id FROM tarefas_dependencias td WHERE td.tarefa_id = NEW.depende_de_id
      UNION
      SELECT td.depende_de_id FROM tarefas_dependencias td JOIN alcancaveis a ON td.tarefa_id = a.id
    )
    SELECT 1 FROM alcancaveis WHERE id = NEW.tarefa_id
  ) THEN
    RAISE EXCEPTION 'dependência criaria um ciclo entre tarefas';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tarefas_dependencias_controla
  BEFORE INSERT OR UPDATE OR DELETE ON tarefas_dependencias
  FOR EACH ROW EXECUTE FUNCTION tarefas_dependencias_controlar();

-- Policy Engine: o vocabulário fechado de "operacao" ganha só "planejamento" (a chamada do coordenador que
-- propõe o plano, a única operação nova que esta entrega executa). Só ACRESCENTA um valor: toda condição e
-- todo contexto já gravados continuam válidos. Mesma regra do Zod em src/db/politicas.ts
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
               WHEN 'operacao' THEN (e.valor #>> '{}') IN ('execucao','auditoria','planejamento')
               WHEN 'prioridade' THEN (e.valor #>> '{}') IN ('CRITICAL','HIGH','MEDIUM','LOW')
               ELSE false
             END
    )
  END
$$;
