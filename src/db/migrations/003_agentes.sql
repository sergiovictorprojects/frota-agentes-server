-- Catálogo de agentes (Fase 2 — Entrega 1). Aditiva: nenhuma tabela existente é alterada.
-- Substitui gradualmente a definição estática de setores (src/domain/setores.ts) por um catálogo
-- persistido, versionável e auditável — sem alterar o fluxo de execução, a UI pública, SSE ou a cidade 3D.
-- Nenhum prompt, token, segredo ou texto livre de execução é armazenado aqui: nome e descrição são
-- curtos e controlados pelo código de seed, nunca texto gerado por modelo ou copiado de uma demanda.
CREATE TABLE agentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identidade estável (ver gatilho abaixo, que a torna imutável após a criação): hoje reaproveita o
  -- mesmo valor de Setor.papel (ex.: "frota:architect") — a mesma string já usada em mensagens.agente,
  -- relatorios.gerente e nos eventos do ledger. Não é uma identidade nova e paralela.
  chave text NOT NULL UNIQUE CHECK (char_length(chave) BETWEEN 1 AND 100),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 200),
  descricao text NOT NULL CHECK (char_length(descricao) BETWEEN 1 AND 500),
  categoria text NOT NULL CHECK (categoria IN (
    'gestores','d1','d2','d3','d4','d5','d6','d7','d8','d9','d10','d11','d12','d13','d14','d15','d16','d17','d18'
  )),
  papel text NOT NULL CHECK (papel IN ('coordenador','executor','avaliador','auditor')),
  estado text NOT NULL DEFAULT 'ativo' CHECK (estado IN ('ativo','suspenso','sob_demanda')),
  versao integer NOT NULL DEFAULT 1 CHECK (versao > 0),
  modelo_permitido text NOT NULL CHECK (char_length(modelo_permitido) BETWEEN 1 AND 100),
  -- Nulo até o Policy Engine existir; quando existir, é uma referência curta e fechada (formato de slug),
  -- nunca texto livre — não há como colar uma frase, um prompt ou um segredo aqui.
  politica_ref text CHECK (politica_ref IS NULL OR politica_ref ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agentes_estado_idx ON agentes (estado);
CREATE INDEX agentes_categoria_idx ON agentes (categoria);

-- Trilha append-only de mudanças de agentes: quem mudou o quê, quando, e a versão de/para. Uma linha por
-- UPDATE que de fato muda estado, modelo_permitido ou politica_ref — gravada pelo PRÓPRIO GATILHO abaixo,
-- não por código de aplicação, então nenhum caminho de UPDATE escapa dela (ver o porquê logo abaixo).
-- campos_alterados guarda só os campos que de fato mudaram, nunca texto livre: estado e modelo_permitido
-- são valores curtos e controlados, politica_ref é uma referência de formato fechado, não conteúdo.
CREATE TABLE agentes_historico (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agente_id uuid NOT NULL REFERENCES agentes(id) ON DELETE RESTRICT,
  -- Identificador curto e controlado (ex.: "sistema", "operador:ana", "sistema:sql_direto") — nunca uma
  -- frase livre. "sistema:sql_direto" é o valor com que o próprio gatilho marca um UPDATE que mudou de
  -- fato o banco sem passar por set_config('frota.ator_da_alteracao', ...): não é possível evitar a
  -- gravação da trilha, o máximo que dá para "esconder" é não se identificar nela.
  ator text NOT NULL CHECK (ator ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  campos_alterados jsonb NOT NULL,
  versao_anterior integer NOT NULL CHECK (versao_anterior > 0),
  versao_nova integer NOT NULL CHECK (versao_nova > versao_anterior),
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agentes_historico_agente_idx ON agentes_historico (agente_id, id);

-- Append-only de verdade: bloqueado no banco. Mesmo padrão de agent_events (migration 002).
CREATE FUNCTION agentes_historico_bloquear_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'agentes_historico é append-only: % não é permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agentes_historico_impede_update
  BEFORE UPDATE ON agentes_historico
  FOR EACH ROW EXECUTE FUNCTION agentes_historico_bloquear_alteracao();

CREATE TRIGGER agentes_historico_impede_delete
  BEFORE DELETE ON agentes_historico
  FOR EACH ROW EXECUTE FUNCTION agentes_historico_bloquear_alteracao();

-- id, chave, nome, descricao, categoria e papel são imutáveis: esta entrega não tem rota de
-- administração para editá-los, então não existe UPDATE sancionado para eles — ficam bloqueados por
-- inteiro, sempre, sem exceção.
--
-- estado, modelo_permitido e politica_ref PODEM mudar — mas a garantia de que toda mudança gera trilha
-- não depende de um caminho de código ser seguido: é o PRÓPRIO GATILHO que grava agentes_historico e
-- força versao = versao_anterior + 1, como parte do mesmo UPDATE que muda a linha. Isso vale para
-- qualquer UPDATE que chegue à tabela — via atualizarAgente() (src/db/agentes.ts) ou via SQL direto —
-- porque não há como uma linha mudar sem passar por este gatilho. Uma versão anterior desta migration
-- tentava impedir UPDATE direto com uma flag de sessão (SET LOCAL ... = 'on'): isso era só teatro de
-- segurança — qualquer sessão com as mesmas credenciais da aplicação podia ligar a mesma flag e escrever
-- direto, sem trilha nenhuma. Removido: agora não existe permissão a burlar, porque a trilha não é uma
-- permissão, é um efeito colateral automático e inevitável do próprio UPDATE.
--
-- O único grau de liberdade que sobra é o "ator": um UPDATE que nunca chamou set_config(
-- 'frota.ator_da_alteracao', ...) ainda assim grava a trilha — só que atribuída a 'sistema:sql_direto',
-- o valor sentinela que deixa evidente, na própria trilha, que aquela mudança não passou pelo caminho
-- sancionado. Nada faz a trilha em si desaparecer ou a versão pular.
CREATE FUNCTION agentes_controlar_mudancas() RETURNS trigger AS $$
DECLARE
  campos jsonb := '{}'::jsonb;
  ator_da_mudanca text;
BEGIN
  IF NEW.id <> OLD.id OR NEW.chave <> OLD.chave OR NEW.nome <> OLD.nome OR NEW.descricao <> OLD.descricao
     OR NEW.categoria <> OLD.categoria OR NEW.papel <> OLD.papel THEN
    RAISE EXCEPTION 'agentes: id, chave, nome, descricao, categoria e papel são imutáveis nesta entrega';
  END IF;

  IF NEW.estado = OLD.estado AND NEW.modelo_permitido = OLD.modelo_permitido
     AND NEW.politica_ref IS NOT DISTINCT FROM OLD.politica_ref THEN
    -- Nada nos três campos versionáveis mudou de fato: nunca aceita versao ou atualizado_em vindos de
    -- fora sem uma mudança real por trás, senão um UPDATE solto poderia inflar a versão sem motivo.
    NEW.versao := OLD.versao;
    NEW.atualizado_em := OLD.atualizado_em;
    RETURN NEW;
  END IF;

  IF NEW.estado <> OLD.estado THEN
    campos := campos || jsonb_build_object('estado', jsonb_build_object('de', OLD.estado, 'para', NEW.estado));
  END IF;
  IF NEW.modelo_permitido <> OLD.modelo_permitido THEN
    campos := campos || jsonb_build_object('modeloPermitido', jsonb_build_object('de', OLD.modelo_permitido, 'para', NEW.modelo_permitido));
  END IF;
  IF NEW.politica_ref IS DISTINCT FROM OLD.politica_ref THEN
    campos := campos || jsonb_build_object('politicaRef', jsonb_build_object('de', OLD.politica_ref, 'para', NEW.politica_ref));
  END IF;

  -- nullif(..., ''), não só coalesce: um pool de conexões reaproveita a mesma sessão entre transações, e
  -- depois que o escopo local (SET LOCAL/set_config com is_local=true) termina, o Postgres não volta a
  -- "esquecer" esse parâmetro de sessão custom — ele vira string vazia, não NULL. Sem o nullif, uma
  -- sessão que já usou a flag antes (mesmo em outra transação, já encerrada) gravaria ator = '' aqui.
  ator_da_mudanca := coalesce(nullif(current_setting('frota.ator_da_alteracao', true), ''), 'sistema:sql_direto');

  -- A versão nunca é escolhida por quem chama: sempre soma 1 ao valor já gravado no banco, não importa
  -- o que o UPDATE tentou colocar em NEW.versao.
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := now();

  INSERT INTO agentes_historico (agente_id, ator, campos_alterados, versao_anterior, versao_nova)
  VALUES (OLD.id, ator_da_mudanca, campos, OLD.versao, NEW.versao);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agentes_controla_mudancas
  BEFORE UPDATE ON agentes
  FOR EACH ROW EXECUTE FUNCTION agentes_controlar_mudancas();
