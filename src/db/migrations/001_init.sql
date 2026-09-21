CREATE TABLE demandas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo text NOT NULL CHECK (char_length(titulo) BETWEEN 1 AND 200),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 20000),
  categoria text NOT NULL CHECK (categoria IN (
    'gestores','d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11','d12','d13','d14','d15','d16','d17','d18'
  )),
  prioridade text NOT NULL DEFAULT 'MEDIUM' CHECK (prioridade IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  prazo date,
  solicitante text CHECK (char_length(solicitante) <= 200),
  referencias text CHECK (char_length(referencias) <= 5000),
  status text NOT NULL DEFAULT 'Nova' CHECK (status IN (
    'Nova','Em andamento','Aguardando humano','Aguardando insumo','Concluída','Arquivada','Falhou'
  )),
  entrega_url text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  claimed_by_run uuid,
  claimed_at timestamptz,
  alternativa_insumo text CHECK (alternativa_insumo IN ('A','B','C')),
  bloqueio_humano jsonb,
  tentativas integer NOT NULL DEFAULT 0
);
CREATE INDEX demandas_status_criado_idx ON demandas (status, criado_em);

CREATE TABLE mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  autor text NOT NULL CHECK (autor IN ('solicitante','agente')),
  setor text,
  agente text,
  texto text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 4000),
  criado_em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mensagens_demanda_idx ON mensagens (demanda_id, criado_em);

CREATE TABLE relatorios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  demanda_titulo text NOT NULL,
  gerente text NOT NULL,
  nivel_complexidade integer NOT NULL CHECK (nivel_complexidade BETWEEN 1 AND 4),
  setores_envolvidos text[] NOT NULL DEFAULT '{}',
  fontes_utilizadas text,
  metricas jsonb NOT NULL DEFAULT '{}'::jsonb,
  ganhos text,
  perdas text,
  aprendizado text,
  ponderacoes jsonb NOT NULL DEFAULT '[]'::jsonb,
  entrega_url text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relatorios_demanda_idx ON relatorios (demanda_id, criado_em DESC);

CREATE TABLE aprendizado_evolucao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data date NOT NULL DEFAULT current_date,
  demanda text NOT NULL,
  nivel integer NOT NULL CHECK (nivel BETWEEN 1 AND 4),
  aprendizado text NOT NULL,
  indice integer CHECK (indice BETWEEN 0 AND 100),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  terminado_em timestamptz,
  gatilho text NOT NULL DEFAULT 'cron' CHECK (gatilho IN ('cron','manual')),
  demandas_processadas integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro','pausada')),
  erro text
);
CREATE INDEX runs_iniciado_idx ON runs (iniciado_em DESC);

CREATE TABLE agent_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  demanda_id uuid REFERENCES demandas(id) ON DELETE SET NULL,
  papel text NOT NULL,
  modelo text NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cache_read integer NOT NULL DEFAULT 0,
  cache_write integer NOT NULL DEFAULT 0,
  custo_usd numeric(12,6) NOT NULL DEFAULT 0,
  duracao_ms integer,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_steps_criado_idx ON agent_steps (criado_em);

CREATE TABLE entregas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE CASCADE,
  tipo text NOT NULL DEFAULT 'html_hospedado' CHECK (tipo IN ('html_hospedado')),
  titulo text NOT NULL,
  conteudo text NOT NULL CHECK (octet_length(conteudo) <= 2000000),
  status_promocao text NOT NULL DEFAULT 'pendente' CHECK (status_promocao IN ('pendente','promovida','dispensada')),
  artifact_url text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entregas_demanda_idx ON entregas (demanda_id);

CREATE TABLE system_flags (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pausado boolean NOT NULL DEFAULT false,
  pausado_motivo text,
  alertas_enviados jsonb NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_flags DEFAULT VALUES;
