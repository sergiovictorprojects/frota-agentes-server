-- Fase 3 — Entrega 3.2a (execução sequencial por tarefas: só a base de dados). Aditiva: nenhuma coluna existente
-- é removida ou muda de significado, nenhuma linha existente é alterada e não há backfill. As colunas novas são
-- anuláveis ou têm padrão; os CHECK antigos são trocados por versões que só ampliam; os gatilhos da 005 são
-- substituídos por versões que mantêm o comportamento dela para planos e tarefas shadow. Nada aqui liga a
-- execução: o código desta entrega não cria plano em execução, envelope, reserva ou autorização fora dos
-- testes. Decisões, fronteiras e rollback em docs/adr/0007-execucao-sequencial-e-teto-de-custo.md.
--
-- Nenhuma coluna guarda prompt, raciocínio, resposta bruta do modelo, lease_token em log ou segredo. O
-- conteúdo de artefato (texto do modelo) fica só em artefatos_tarefa, nunca em eventos ou no dossiê.

-- =====================================================================================================
-- 1. Envelope da demanda
-- =====================================================================================================

-- Criado na primeira vez que a demanda entra na orquestração por tarefas e nunca apagado. Guarda o teto base
-- (cópia de ORQUESTRACAO_CUSTO_MAX_USD no momento da criação), a rota e o bloqueio por custo.
CREATE TABLE orquestracao_demandas (
  demanda_id uuid PRIMARY KEY REFERENCES demandas(id) ON DELETE RESTRICT,
  teto_base_usd numeric(8,2) NOT NULL CHECK (teto_base_usd BETWEEN 1.00 AND 20.00),
  rota text NOT NULL DEFAULT 'tarefas' CHECK (rota IN ('tarefas','legado_fixo')),
  motivo_legado text CHECK (motivo_legado IN ('plano_rejeitado','planejamento_falhou','tarefa_falhou','agente_indisponivel')),
  legado_fixado_em timestamptz,
  bloqueada_por_custo boolean NOT NULL DEFAULT false,
  bloqueio_custo_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orquestracao_demandas_legado_check CHECK (
    (rota = 'legado_fixo') = (motivo_legado IS NOT NULL) AND (rota = 'legado_fixo') = (legado_fixado_em IS NOT NULL)
  ),
  CONSTRAINT orquestracao_demandas_bloqueio_check CHECK (bloqueada_por_custo = (bloqueio_custo_em IS NOT NULL))
);

-- Nenhum DELETE. Identidade e teto imutáveis. A rota só muda de tarefas para legado_fixo, uma vez. O bloqueio
-- por custo só é limpo com uma linha de autorizacoes_custo inserida na mesma transação (txid_current()).
-- Datas de controle são sempre do banco, nunca de quem chama.
CREATE FUNCTION orquestracao_demandas_controlar() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'orquestracao_demandas: DELETE não é permitido';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.rota <> 'tarefas' OR NEW.motivo_legado IS NOT NULL OR NEW.legado_fixado_em IS NOT NULL
       OR NEW.bloqueada_por_custo OR NEW.bloqueio_custo_em IS NOT NULL THEN
      RAISE EXCEPTION 'orquestracao_demandas: o envelope nasce com a rota tarefas e sem bloqueio';
    END IF;
    NEW.criado_em := now();
    RETURN NEW;
  END IF;

  IF NEW.demanda_id <> OLD.demanda_id OR NEW.teto_base_usd <> OLD.teto_base_usd OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'orquestracao_demandas: demanda, teto base e data de criação são imutáveis';
  END IF;

  IF OLD.rota = 'legado_fixo' THEN
    IF NEW.rota <> 'legado_fixo' OR NEW.motivo_legado IS DISTINCT FROM OLD.motivo_legado
       OR NEW.legado_fixado_em IS DISTINCT FROM OLD.legado_fixado_em THEN
      RAISE EXCEPTION 'orquestracao_demandas: a rota legado_fixo é definitiva';
    END IF;
  ELSIF NEW.rota = 'legado_fixo' THEN
    NEW.legado_fixado_em := now();
  ELSE
    NEW.legado_fixado_em := NULL;
  END IF;

  IF NOT OLD.bloqueada_por_custo AND NEW.bloqueada_por_custo THEN
    NEW.bloqueio_custo_em := now();
  ELSIF OLD.bloqueada_por_custo AND NOT NEW.bloqueada_por_custo THEN
    IF NOT EXISTS (SELECT 1 FROM autorizacoes_custo a WHERE a.demanda_id = NEW.demanda_id AND a.transacao = txid_current()) THEN
      RAISE EXCEPTION 'orquestracao_demandas: o bloqueio por custo só sai com uma autorização na mesma transação';
    END IF;
    NEW.bloqueio_custo_em := NULL;
  ELSE
    NEW.bloqueio_custo_em := OLD.bloqueio_custo_em;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orquestracao_demandas_controla
  BEFORE INSERT OR UPDATE OR DELETE ON orquestracao_demandas
  FOR EACH ROW EXECUTE FUNCTION orquestracao_demandas_controlar();

-- No COMMIT: uma rota legado_fixo nunca convive com plano ativo. Fixar a rota exige abandonar o plano na mesma
-- transação (seção 5.9 do plano).
CREATE FUNCTION orquestracao_demandas_conferir_no_commit() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM orquestracao_demandas e WHERE e.demanda_id = NEW.demanda_id AND e.rota = 'legado_fixo')
     AND EXISTS (SELECT 1 FROM planos_demanda p WHERE p.demanda_id = NEW.demanda_id AND p.estado = 'ativo') THEN
    RAISE EXCEPTION 'orquestracao_demandas: a rota legado_fixo não pode conviver com plano ativo';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER orquestracao_demandas_confere_no_commit
  AFTER UPDATE ON orquestracao_demandas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION orquestracao_demandas_conferir_no_commit();

-- =====================================================================================================
-- 2. planos_demanda: modo execucao e máquina de estados
-- =====================================================================================================

ALTER TABLE planos_demanda DROP CONSTRAINT planos_demanda_modo_check;
ALTER TABLE planos_demanda DROP CONSTRAINT planos_demanda_estado_check;
ALTER TABLE planos_demanda DROP CONSTRAINT planos_demanda_motivo_rejeicao_check;

ALTER TABLE planos_demanda
  ADD COLUMN motivo_abandono text,
  ADD COLUMN ativado_em timestamptz,
  ADD COLUMN encerrado_em timestamptz,
  ADD CONSTRAINT planos_demanda_modo_check CHECK (modo IN ('shadow','execucao')),
  ADD CONSTRAINT planos_demanda_estado_check CHECK (estado IN ('registrado','rejeitado','ativo','concluido','abandonado')),
  ADD CONSTRAINT planos_demanda_motivo_rejeicao_check CHECK (motivo_rejeicao IN (
    'sem_tarefas','limite_tarefas','chave_duplicada','chave_reservada','capacidade_nao_executora',
    'dependencia_inexistente','autodependencia','ciclo','objetivo_invalido'
  )),
  ADD CONSTRAINT planos_demanda_motivo_abandono_check CHECK (motivo_abandono IN (
    'tarefa_falhou','agente_indisponivel','pendencia_humana','orquestracao_desligada','demanda_encerrada'
  )),
  -- Plano shadow continua só registrado ou rejeitado, como na 005.
  ADD CONSTRAINT planos_demanda_shadow_check CHECK (modo = 'execucao' OR estado IN ('registrado','rejeitado')),
  ADD CONSTRAINT planos_demanda_abandono_check CHECK ((estado = 'abandonado') = (motivo_abandono IS NOT NULL)),
  ADD CONSTRAINT planos_demanda_ativado_check CHECK ((estado IN ('ativo','concluido','abandonado')) = (ativado_em IS NOT NULL)),
  ADD CONSTRAINT planos_demanda_encerrado_check CHECK ((estado IN ('concluido','abandonado')) = (encerrado_em IS NOT NULL));

-- No máximo um plano ativo por demanda.
CREATE UNIQUE INDEX planos_demanda_um_ativo_idx ON planos_demanda (demanda_id) WHERE estado = 'ativo';

DROP TRIGGER planos_demanda_imutavel ON planos_demanda;
DROP FUNCTION planos_demanda_imutavel();

-- Nenhum DELETE. Plano shadow imutável, como na 005. Plano em execução: só é inserido com envelope na rota
-- tarefas; identidade imutável; transições registrado → ativo e ativo → concluido | abandonado. A ativação
-- confere a forma do plano no banco. As datas de controle são sempre do banco.
CREATE FUNCTION planos_demanda_controlar() RETURNS trigger AS $$
DECLARE
  v_integracoes integer;
  v_especialistas integer;
  v_sem_objetivo integer;
  v_sem_aresta integer;
  v_dependem_da_integracao integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'planos_demanda: DELETE não é permitido';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.modo = 'execucao' THEN
      IF NEW.estado NOT IN ('registrado','rejeitado') THEN
        RAISE EXCEPTION 'planos_demanda: um plano em execução nasce registrado ou rejeitado';
      END IF;
      PERFORM 1 FROM orquestracao_demandas e WHERE e.demanda_id = NEW.demanda_id AND e.rota = 'tarefas' FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'planos_demanda: um plano em execução exige o envelope da demanda na rota tarefas';
      END IF;
    END IF;
    NEW.criado_em := now();
    RETURN NEW;
  END IF;

  IF OLD.modo = 'shadow' THEN
    RAISE EXCEPTION 'planos_demanda: plano shadow é imutável (UPDATE não é permitido)';
  END IF;

  IF NEW.id <> OLD.id OR NEW.demanda_id <> OLD.demanda_id OR NEW.versao <> OLD.versao
     OR NEW.criado_pela_run_id IS DISTINCT FROM OLD.criado_pela_run_id OR NEW.modo <> OLD.modo
     OR NEW.motivo_rejeicao IS DISTINCT FROM OLD.motivo_rejeicao OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'planos_demanda: a identidade do plano é imutável';
  END IF;

  IF OLD.estado = 'registrado' AND NEW.estado = 'ativo' THEN
    PERFORM 1 FROM orquestracao_demandas e WHERE e.demanda_id = NEW.demanda_id AND e.rota = 'tarefas' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'planos_demanda: a ativação exige o envelope da demanda na rota tarefas';
    END IF;

    SELECT count(*) FILTER (WHERE t.tipo = 'integracao'),
           count(*) FILTER (WHERE t.tipo = 'especialista'),
           count(*) FILTER (WHERE t.tipo = 'especialista' AND t.objetivo IS NULL)
      INTO v_integracoes, v_especialistas, v_sem_objetivo
      FROM tarefas t WHERE t.plano_id = NEW.id;
    IF v_integracoes <> 1 THEN
      RAISE EXCEPTION 'planos_demanda: a ativação exige exatamente uma integração';
    END IF;
    IF v_especialistas NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'planos_demanda: a ativação exige de 1 a 3 especialistas';
    END IF;
    IF v_sem_objetivo > 0 THEN
      RAISE EXCEPTION 'planos_demanda: a ativação exige objetivo em todas as especialistas';
    END IF;

    SELECT count(*) INTO v_sem_aresta
      FROM tarefas e
     WHERE e.plano_id = NEW.id AND e.tipo = 'especialista'
       AND NOT EXISTS (
         SELECT 1 FROM tarefas_dependencias td JOIN tarefas i ON i.id = td.tarefa_id
          WHERE i.plano_id = NEW.id AND i.tipo = 'integracao' AND td.depende_de_id = e.id
       );
    IF v_sem_aresta > 0 THEN
      RAISE EXCEPTION 'planos_demanda: a ativação exige uma aresta direta da integração para cada especialista';
    END IF;

    SELECT count(*) INTO v_dependem_da_integracao
      FROM tarefas_dependencias td
      JOIN tarefas e ON e.id = td.tarefa_id
      JOIN tarefas i ON i.id = td.depende_de_id
     WHERE e.plano_id = NEW.id AND e.tipo = 'especialista' AND i.tipo = 'integracao';
    IF v_dependem_da_integracao > 0 THEN
      RAISE EXCEPTION 'planos_demanda: nenhuma especialista pode depender da integração';
    END IF;

    NEW.ativado_em := now();
    NEW.encerrado_em := NULL;
  ELSIF OLD.estado = 'ativo' AND NEW.estado = 'concluido' THEN
    IF NOT EXISTS (
      SELECT 1 FROM tarefas t
       WHERE t.plano_id = NEW.id AND t.tipo = 'integracao' AND t.estado = 'concluida' AND t.entrega_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'planos_demanda: concluir exige a integração concluída e com entrega';
    END IF;
    NEW.ativado_em := OLD.ativado_em;
    NEW.encerrado_em := now();
  ELSIF OLD.estado = 'ativo' AND NEW.estado = 'abandonado' THEN
    NEW.ativado_em := OLD.ativado_em;
    NEW.encerrado_em := now();
  ELSE
    RAISE EXCEPTION 'planos_demanda: transição % → % não é permitida', OLD.estado, NEW.estado;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planos_demanda_controla
  BEFORE INSERT OR UPDATE OR DELETE ON planos_demanda
  FOR EACH ROW EXECUTE FUNCTION planos_demanda_controlar();

-- No COMMIT: um plano concluído ou abandonado não fica com tarefa pendente, pronta ou em execução. Um abandono
-- por tarefa que falhou ou agente indisponível fixa a rota legado_fixo, com o mesmo motivo, na mesma transação.
-- Lê o estado atual da linha, não NEW: a transação pode ter mexido nela mais de uma vez.
CREATE FUNCTION planos_demanda_conferir_no_commit() RETURNS trigger AS $$
DECLARE
  v_estado text;
  v_motivo text;
  v_demanda uuid;
BEGIN
  SELECT p.estado, p.motivo_abandono, p.demanda_id INTO v_estado, v_motivo, v_demanda
    FROM planos_demanda p WHERE p.id = NEW.id;
  IF v_estado IN ('concluido','abandonado') THEN
    IF EXISTS (SELECT 1 FROM tarefas t WHERE t.plano_id = NEW.id AND t.estado IN ('pendente','pronta','em_execucao')) THEN
      RAISE EXCEPTION 'planos_demanda: plano % com tarefa aberta', v_estado;
    END IF;
    IF v_motivo IN ('tarefa_falhou','agente_indisponivel') AND NOT EXISTS (
      SELECT 1 FROM orquestracao_demandas e
       WHERE e.demanda_id = v_demanda AND e.rota = 'legado_fixo' AND e.motivo_legado = v_motivo
    ) THEN
      RAISE EXCEPTION 'planos_demanda: abandono por % exige a rota legado_fixo com o mesmo motivo', v_motivo;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER planos_demanda_confere_no_commit
  AFTER UPDATE ON planos_demanda
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION planos_demanda_conferir_no_commit();

-- =====================================================================================================
-- 3. tarefas: campos e máquina de estados da execução
-- =====================================================================================================

ALTER TABLE tarefas DROP CONSTRAINT tarefas_estado_check;

-- objetivo: texto do modelo, curto e imutável. Sem caracteres de controle (C0, DEL, C1 e os separadores de
-- linha e parágrafo U+2028 e U+2029), sem < e sem >. Vai para o prompt só pela serialização canônica e nunca
-- aparece em eventos, dossiê, logs ou interface.
-- claim_id: uuid novo a cada claim, gerado pelo banco. Não é credencial: identifica o claim para idempotência
-- e correlação, mas não autoriza persistência. lease_token: também gerado pelo banco no claim; só ele autoriza
-- persistir o resultado (condição de WHERE no repositório) e nunca vai para evento, log ou interface.
-- agente_chave, agente_versao, agente_papel e modelo: o snapshot do catálogo gravado no claim.
ALTER TABLE tarefas
  ADD COLUMN objetivo text,
  ADD COLUMN claim_id uuid,
  ADD COLUMN agente_chave text REFERENCES agentes(chave) ON DELETE RESTRICT,
  ADD COLUMN agente_versao integer,
  ADD COLUMN agente_papel text,
  ADD COLUMN modelo text,
  ADD COLUMN tentativas integer NOT NULL DEFAULT 0,
  ADD COLUMN max_tentativas integer NOT NULL DEFAULT 2,
  ADD COLUMN timeout_segundos integer,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expira_em timestamptz,
  ADD COLUMN enviada_em timestamptz,
  ADD COLUMN iniciada_em timestamptz,
  ADD COLUMN concluida_em timestamptz,
  ADD COLUMN codigo_erro text,
  ADD COLUMN entrega_id uuid REFERENCES entregas(id) ON DELETE RESTRICT,
  ADD CONSTRAINT tarefas_estado_check CHECK (estado IN ('pendente','pronta','em_execucao','concluida','falhou','cancelada')),
  ADD CONSTRAINT tarefas_objetivo_check CHECK (
    objetivo IS NULL OR (char_length(objetivo) BETWEEN 1 AND 300 AND objetivo !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029<>]')
  ),
  ADD CONSTRAINT tarefas_objetivo_tipo_check CHECK (tipo = 'especialista' OR objetivo IS NULL),
  ADD CONSTRAINT tarefas_tentativas_check CHECK (max_tentativas BETWEEN 1 AND 3 AND tentativas BETWEEN 0 AND max_tentativas),
  ADD CONSTRAINT tarefas_timeout_check CHECK (
    timeout_segundos IS NULL
    OR (tipo = 'especialista' AND timeout_segundos = 480)
    OR (tipo = 'integracao' AND timeout_segundos = 720)
  ),
  ADD CONSTRAINT tarefas_lease_check CHECK (
    (estado = 'em_execucao') = (lease_token IS NOT NULL)
    AND (estado = 'em_execucao') = (lease_expira_em IS NOT NULL)
    AND (estado = 'em_execucao') = (claim_id IS NOT NULL)
  ),
  ADD CONSTRAINT tarefas_envio_check CHECK (
    (enviada_em IS NULL OR estado IN ('em_execucao','concluida')) AND (estado <> 'concluida' OR enviada_em IS NOT NULL)
  ),
  ADD CONSTRAINT tarefas_snapshot_check CHECK (
    num_nulls(agente_chave, agente_versao, agente_papel, modelo) IN (0, 4)
    AND (estado NOT IN ('em_execucao','concluida') OR agente_chave IS NOT NULL)
    AND (estado NOT IN ('pendente','pronta') OR agente_chave IS NULL)
  ),
  ADD CONSTRAINT tarefas_agente_papel_check CHECK (agente_papel IN ('coordenador','executor')),
  ADD CONSTRAINT tarefas_agente_versao_check CHECK (agente_versao > 0),
  ADD CONSTRAINT tarefas_modelo_check CHECK (modelo ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
  ADD CONSTRAINT tarefas_concluida_check CHECK ((estado = 'concluida') = (concluida_em IS NOT NULL)),
  ADD CONSTRAINT tarefas_codigo_erro_check CHECK (codigo_erro IN (
    'contexto_excedido','artefato_invalido','lease_expirado','llm_recusa','llm_truncado','llm_invalido',
    'llm_api','llm_timeout','falha_inesperada'
  )),
  ADD CONSTRAINT tarefas_falhou_check CHECK ((estado = 'falhou') = (codigo_erro IS NOT NULL)),
  ADD CONSTRAINT tarefas_entrega_check CHECK ((entrega_id IS NOT NULL) = (tipo = 'integracao' AND estado = 'concluida')),
  ADD CONSTRAINT tarefas_pendente_check CHECK (estado <> 'pendente' OR (tentativas = 0 AND iniciada_em IS NULL)),
  ADD CONSTRAINT tarefas_entrega_id_key UNIQUE (entrega_id),
  -- Alvo das FKs compostas (agent_steps e reservas_custo): a tarefa e o plano sempre juntos.
  ADD CONSTRAINT tarefas_id_plano_id_key UNIQUE (id, plano_id);

CREATE INDEX tarefas_prontas_idx ON tarefas (plano_id, chave COLLATE "C") WHERE estado = 'pronta';
CREATE INDEX tarefas_em_execucao_idx ON tarefas (lease_expira_em) WHERE estado = 'em_execucao';

-- Substitui o gatilho da 005 (mesmo nome). Nenhum DELETE. Só um plano registrado recebe tarefas (a linha do
-- plano fica travada em FOR SHARE, o que serializa com a ativação). Tarefa de plano shadow: imutável, como na
-- 005. Tarefa de plano em execução: identidade imutável, tentativa só sobe no registro de envio e nunca desce,
-- e só as transições da tabela 4.4 do plano. claim_id, lease_token e as datas de controle são sempre do banco;
-- ao sair de em_execucao, lease e claim_id são limpos aqui, então nenhum caminho os esquece.
CREATE OR REPLACE FUNCTION tarefas_controlar() RETURNS trigger AS $$
DECLARE
  v_plano planos_demanda%ROWTYPE;
  v_agente agentes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tarefas: DELETE não é permitido';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_plano FROM planos_demanda WHERE id = NEW.plano_id FOR SHARE;
    IF v_plano.estado IS DISTINCT FROM 'registrado' THEN
      RAISE EXCEPTION 'só um plano registrado recebe tarefas';
    END IF;
    IF NEW.estado <> 'pendente' OR NEW.tentativas <> 0 OR num_nonnulls(
         NEW.claim_id, NEW.agente_chave, NEW.agente_versao, NEW.agente_papel, NEW.modelo, NEW.lease_token,
         NEW.lease_expira_em, NEW.enviada_em, NEW.iniciada_em, NEW.concluida_em, NEW.codigo_erro, NEW.entrega_id) > 0 THEN
      RAISE EXCEPTION 'tarefas: uma tarefa nasce pendente, sem claim e sem execução';
    END IF;
    IF v_plano.modo = 'shadow' THEN
      IF NEW.objetivo IS NOT NULL OR NEW.timeout_segundos IS NOT NULL THEN
        RAISE EXCEPTION 'tarefas: tarefa de plano shadow não tem objetivo nem timeout';
      END IF;
    ELSE
      IF NEW.tipo = 'especialista' AND NEW.objetivo IS NULL THEN
        RAISE EXCEPTION 'tarefas: especialista de plano em execução exige objetivo';
      END IF;
      NEW.timeout_segundos := CASE NEW.tipo WHEN 'especialista' THEN 480 ELSE 720 END;
    END IF;
    NEW.criado_em := now();
    RETURN NEW;
  END IF;

  SELECT * INTO v_plano FROM planos_demanda WHERE id = OLD.plano_id;
  IF v_plano.modo = 'shadow' THEN
    RAISE EXCEPTION 'tarefas: tarefa de plano shadow é imutável (UPDATE não é permitido)';
  END IF;

  IF NEW.id <> OLD.id OR NEW.plano_id <> OLD.plano_id OR NEW.chave <> OLD.chave OR NEW.tipo <> OLD.tipo
     OR NEW.capacidade <> OLD.capacidade OR NEW.objetivo IS DISTINCT FROM OLD.objetivo
     OR NEW.max_tentativas <> OLD.max_tentativas OR NEW.timeout_segundos IS DISTINCT FROM OLD.timeout_segundos
     OR NEW.criado_em <> OLD.criado_em THEN
    RAISE EXCEPTION 'tarefas: a identidade da tarefa é imutável';
  END IF;
  IF NEW.tentativas < OLD.tentativas THEN
    RAISE EXCEPTION 'tarefas: tentativas nunca descem';
  END IF;

  -- Colunas de controle: valem as do banco, salvo onde a transição abaixo as define.
  NEW.claim_id := OLD.claim_id;
  NEW.lease_token := OLD.lease_token;
  NEW.enviada_em := OLD.enviada_em;
  NEW.iniciada_em := OLD.iniciada_em;
  NEW.concluida_em := OLD.concluida_em;

  IF OLD.estado = 'em_execucao' AND NEW.estado = 'em_execucao' THEN
    -- Registro de envio: soma exatamente uma tentativa, renova o lease e confere, sob lock, a autorização
    -- final do agente do snapshot e a reserva aberta do mesmo claim.
    IF OLD.enviada_em IS NOT NULL THEN
      RAISE EXCEPTION 'tarefas: uma tarefa em execução só aceita um registro de envio por claim';
    END IF;
    IF NEW.tentativas <> OLD.tentativas + 1 THEN
      RAISE EXCEPTION 'tarefas: o registro de envio soma exatamente uma tentativa';
    END IF;
    IF NEW.agente_chave IS DISTINCT FROM OLD.agente_chave OR NEW.agente_versao IS DISTINCT FROM OLD.agente_versao
       OR NEW.agente_papel IS DISTINCT FROM OLD.agente_papel OR NEW.modelo IS DISTINCT FROM OLD.modelo THEN
      RAISE EXCEPTION 'tarefas: o snapshot do claim é imutável';
    END IF;
    IF NEW.lease_expira_em IS NULL OR NEW.lease_expira_em <= now() THEN
      RAISE EXCEPTION 'tarefas: o registro de envio exige um lease renovado';
    END IF;
    IF v_plano.estado <> 'ativo' THEN
      RAISE EXCEPTION 'tarefas: o registro de envio exige o plano ativo';
    END IF;
    SELECT * INTO v_agente FROM agentes WHERE chave = OLD.agente_chave FOR SHARE;
    IF v_agente.estado <> 'ativo' OR v_agente.versao <> OLD.agente_versao OR v_agente.modelo_permitido <> OLD.modelo THEN
      RAISE EXCEPTION 'tarefas: o agente do claim não está mais autorizado';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM reservas_custo r WHERE r.tarefa_id = OLD.id AND r.claim_id = OLD.claim_id AND r.estado = 'aberta'
    ) THEN
      RAISE EXCEPTION 'tarefas: nenhum envio sem reserva aberta do mesmo claim';
    END IF;
    NEW.enviada_em := now();
    NEW.iniciada_em := COALESCE(OLD.iniciada_em, now());
    RETURN NEW;
  END IF;

  IF NEW.tentativas <> OLD.tentativas THEN
    RAISE EXCEPTION 'tarefas: a tentativa só sobe no registro de envio';
  END IF;

  IF OLD.estado = 'pendente' AND NEW.estado = 'pronta' THEN
    IF v_plano.estado <> 'ativo' THEN
      RAISE EXCEPTION 'tarefas: só um plano ativo libera tarefas';
    END IF;
    IF EXISTS (
      SELECT 1 FROM tarefas_dependencias td JOIN tarefas d ON d.id = td.depende_de_id
       WHERE td.tarefa_id = OLD.id AND d.estado <> 'concluida'
    ) THEN
      RAISE EXCEPTION 'tarefas: uma tarefa só fica pronta com todas as dependências concluídas';
    END IF;

  ELSIF OLD.estado = 'pronta' AND NEW.estado = 'em_execucao' THEN
    -- Claim: plano ativo, lease com validade, snapshot de um agente ativo e compatível. A tentativa não conta.
    IF v_plano.estado <> 'ativo' THEN
      RAISE EXCEPTION 'tarefas: o claim exige o plano ativo';
    END IF;
    IF OLD.tentativas >= OLD.max_tentativas THEN
      RAISE EXCEPTION 'tarefas: sem tentativa restante, a tarefa não pode ser reivindicada';
    END IF;
    IF NEW.lease_expira_em IS NULL OR NEW.lease_expira_em <= now() THEN
      RAISE EXCEPTION 'tarefas: o claim exige um lease com validade';
    END IF;
    SELECT * INTO v_agente FROM agentes WHERE chave = NEW.agente_chave FOR SHARE;
    IF NOT FOUND OR v_agente.estado <> 'ativo' OR v_agente.categoria <> NEW.capacidade
       OR v_agente.versao IS DISTINCT FROM NEW.agente_versao OR v_agente.papel IS DISTINCT FROM NEW.agente_papel
       OR v_agente.modelo_permitido IS DISTINCT FROM NEW.modelo THEN
      RAISE EXCEPTION 'tarefas: o snapshot do claim precisa ser de um agente ativo e compatível no catálogo';
    END IF;
    NEW.claim_id := gen_random_uuid();
    NEW.lease_token := gen_random_uuid();

  ELSIF OLD.estado = 'pronta' AND NEW.estado = 'falhou' THEN
    -- Erro determinístico medido antes do claim: sem lease, sem tentativa e com o plano abandonado na mesma
    -- transação (e, pelo gatilho adiado do plano, a rota fixada).
    IF NEW.codigo_erro IS DISTINCT FROM 'contexto_excedido' THEN
      RAISE EXCEPTION 'tarefas: pronta → falhou só com contexto_excedido';
    END IF;
    IF v_plano.estado <> 'abandonado' OR v_plano.motivo_abandono <> 'tarefa_falhou' THEN
      RAISE EXCEPTION 'tarefas: contexto_excedido exige o plano abandonado por tarefa_falhou na mesma transação';
    END IF;

  ELSIF OLD.estado = 'em_execucao' AND NEW.estado IN ('concluida','pronta','falhou','cancelada') THEN
    IF NEW.estado = 'concluida' THEN
      IF OLD.enviada_em IS NULL THEN
        RAISE EXCEPTION 'tarefas: concluir exige o envio registrado';
      END IF;
      IF v_plano.estado <> 'ativo' THEN
        RAISE EXCEPTION 'tarefas: concluir exige o plano ativo';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM artefatos_tarefa a WHERE a.tarefa_id = OLD.id) THEN
        RAISE EXCEPTION 'tarefas: concluir exige o artefato da tarefa';
      END IF;
      IF OLD.tipo = 'integracao' AND NOT EXISTS (
        SELECT 1 FROM entregas en WHERE en.id = NEW.entrega_id AND en.demanda_id = v_plano.demanda_id
      ) THEN
        RAISE EXCEPTION 'tarefas: a integração conclui com uma entrega da mesma demanda do plano';
      END IF;
      NEW.concluida_em := now();
    ELSIF NEW.estado = 'pronta' THEN
      IF OLD.tentativas >= OLD.max_tentativas THEN
        RAISE EXCEPTION 'tarefas: sem tentativa restante, a tarefa não volta para pronta';
      END IF;
      IF v_plano.estado <> 'ativo' THEN
        RAISE EXCEPTION 'tarefas: só um plano ativo recebe a tarefa de volta';
      END IF;
      NEW.enviada_em := NULL;
      NEW.agente_chave := NULL;
      NEW.agente_versao := NULL;
      NEW.agente_papel := NULL;
      NEW.modelo := NULL;
    ELSE
      IF NEW.estado = 'cancelada' AND v_plano.estado <> 'abandonado' THEN
        RAISE EXCEPTION 'tarefas: cancelar exige o plano abandonado na mesma transação';
      END IF;
      -- contexto_excedido é medido antes do claim (pronta → falhou, acima); uma tarefa reivindicada nunca falha
      -- com ele, o que mantém o evento tarefa_falhou coerente (claimId nulo exatamente nesse código).
      IF NEW.estado = 'falhou' AND NEW.codigo_erro = 'contexto_excedido' THEN
        RAISE EXCEPTION 'tarefas: contexto_excedido é anterior ao claim; uma tarefa em execução não falha com ele';
      END IF;
      NEW.enviada_em := NULL;
    END IF;
    IF NEW.estado <> 'pronta' THEN
      NEW.agente_chave := OLD.agente_chave;
      NEW.agente_versao := OLD.agente_versao;
      NEW.agente_papel := OLD.agente_papel;
      NEW.modelo := OLD.modelo;
    END IF;
    NEW.claim_id := NULL;
    NEW.lease_token := NULL;
    NEW.lease_expira_em := NULL;

  ELSIF OLD.estado IN ('pendente','pronta') AND NEW.estado = 'cancelada' THEN
    IF v_plano.estado <> 'abandonado' THEN
      RAISE EXCEPTION 'tarefas: cancelar exige o plano abandonado na mesma transação';
    END IF;

  ELSE
    RAISE EXCEPTION 'tarefas: transição % → % não é permitida', OLD.estado, NEW.estado;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- O gatilho tarefas_controla da 005 já aponta para tarefas_controlar(): o CREATE OR REPLACE acima basta.

-- =====================================================================================================
-- 4. tarefas_dependencias: grafo congelado depois da ativação
-- =====================================================================================================

-- Mantém tudo da 005 (mesmo plano, FOR UPDATE na linha do plano, CTE que barra ciclos) e acrescenta: só um plano
-- registrado recebe arestas. Depois da ativação o grafo fica congelado.
CREATE OR REPLACE FUNCTION tarefas_dependencias_controlar() RETURNS trigger AS $$
DECLARE
  plano_origem uuid;
  plano_destino uuid;
  estado_plano text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tarefas_dependencias é append-only: % não é permitido', TG_OP;
  END IF;
  SELECT plano_id INTO plano_origem FROM tarefas WHERE id = NEW.tarefa_id;
  SELECT plano_id INTO plano_destino FROM tarefas WHERE id = NEW.depende_de_id;
  IF plano_origem IS DISTINCT FROM plano_destino THEN
    RAISE EXCEPTION 'dependência entre tarefas de planos diferentes não é permitida';
  END IF;
  SELECT estado INTO estado_plano FROM planos_demanda WHERE id = plano_origem FOR UPDATE;
  IF estado_plano IS DISTINCT FROM 'registrado' THEN
    RAISE EXCEPTION 'só um plano registrado recebe dependências: o grafo fica congelado depois da ativação';
  END IF;
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

-- =====================================================================================================
-- 5. artefatos_tarefa
-- =====================================================================================================

-- true se o texto é JSON aceito pelo jsonb do Postgres.
CREATE FUNCTION texto_e_json(t text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  PERFORM t::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$;

-- URL de referência: https; host com nome (letras no último rótulo, nunca IP), minúsculo, sem credencial nem
-- porta; sem query e sem fragmento; e sem trecho com cara de token (sequência de 24 ou mais caracteres de
-- palavra, de 16 ou mais com algum dígito, ou um uuid). Mesmas expressões do Zod em src/db/artefatos.ts;
-- test/db/artefatos.test.ts confere as duas por SQL direto.
CREATE FUNCTION referencia_url_valida(u text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT char_length(u) <= 500
     AND u ~ '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(/[A-Za-z0-9._~%!$&''()*+,;=:@-]*)*$'
     AND u !~ '[A-Za-z0-9_]{24,}'
     AND u !~ '(^|[^A-Za-z0-9_])(?=[A-Za-z0-9_]{16})[A-Za-z_]*[0-9]'
     AND u !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
$$;

-- Referências de um artefato: até 10, em três formas fechadas, com as chaves exatas.
--   {"tipo":"url","url":"https://…"}                citação de página pública
--   {"tipo":"fonte","citacao":"…"}                  citação textual (1 a 300 caracteres, sem controle)
--   {"tipo":"artefato","tarefaId":"<uuid>"}          artefato de uma dependência direta (conferido no gatilho)
CREATE FUNCTION artefato_referencias_validas(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN r IS NULL OR jsonb_typeof(r) <> 'array' THEN false
    WHEN jsonb_array_length(r) > 10 THEN false
    ELSE NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(r) AS e(v)
       WHERE NOT (
         jsonb_typeof(e.v) = 'object'
         AND jsonb_typeof(e.v -> 'tipo') = 'string'
         AND CASE e.v ->> 'tipo'
           WHEN 'url' THEN
             (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(e.v) AS k) = ARRAY['tipo','url']
             AND jsonb_typeof(e.v -> 'url') = 'string'
             AND referencia_url_valida(e.v ->> 'url')
           WHEN 'fonte' THEN
             (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(e.v) AS k) = ARRAY['citacao','tipo']
             AND jsonb_typeof(e.v -> 'citacao') = 'string'
             AND char_length(e.v ->> 'citacao') BETWEEN 1 AND 300
             AND (e.v ->> 'citacao') !~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
           WHEN 'artefato' THEN
             (SELECT array_agg(k COLLATE "C" ORDER BY k COLLATE "C") FROM jsonb_object_keys(e.v) AS k) = ARRAY['tarefaId','tipo']
             AND jsonb_typeof(e.v -> 'tarefaId') = 'string'
             AND (e.v ->> 'tarefaId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           ELSE false
         END
       )
    )
  END
$$;

-- Um artefato por tarefa, append-only. sha256 é calculado pelo servidor e conferido pelo banco; bytes também.
-- classificacao é sempre "interna" nesta entrega. O artefato da integração é o ResultadoExecucao sem o
-- conteúdo da entrega: duplica de propósito o que depois vai para relatorios, para a retomada depois de uma
-- queda (ADR 0007).
CREATE TABLE artefatos_tarefa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarefa_id uuid NOT NULL UNIQUE REFERENCES tarefas(id) ON DELETE RESTRICT,
  formato text NOT NULL CHECK (formato IN ('texto','json')),
  resumo text NOT NULL CHECK (char_length(resumo) BETWEEN 1 AND 500),
  conteudo text NOT NULL CHECK (octet_length(conteudo) <= 131072),
  bytes integer NOT NULL,
  sha256 text NOT NULL,
  referencias jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (artefato_referencias_validas(referencias)),
  classificacao text NOT NULL DEFAULT 'interna' CHECK (classificacao = 'interna'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artefatos_tarefa_bytes_check CHECK (bytes = octet_length(conteudo)),
  CONSTRAINT artefatos_tarefa_sha256_check CHECK (sha256 = encode(sha256(convert_to(conteudo, 'UTF8')), 'hex'))
);

-- INSERT só com a tarefa em execução e com o envio registrado (a linha da tarefa fica travada). Limite de
-- tamanho por tipo, JSON válido quando o formato é json e referência a artefato só para dependência direta.
-- Sem UPDATE nem DELETE.
CREATE FUNCTION artefatos_tarefa_controlar() RETURNS trigger AS $$
DECLARE
  v_tarefa tarefas%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'artefatos_tarefa é append-only: % não é permitido', TG_OP;
  END IF;
  SELECT * INTO v_tarefa FROM tarefas WHERE id = NEW.tarefa_id FOR UPDATE;
  IF v_tarefa.estado IS DISTINCT FROM 'em_execucao' OR v_tarefa.enviada_em IS NULL THEN
    RAISE EXCEPTION 'artefatos_tarefa: só uma tarefa em execução, com envio registrado, recebe artefato';
  END IF;
  IF v_tarefa.tipo = 'especialista' AND octet_length(NEW.conteudo) > 65536 THEN
    RAISE EXCEPTION 'artefatos_tarefa: o artefato de especialista tem no máximo 65536 bytes';
  END IF;
  IF NEW.formato = 'json' AND NOT texto_e_json(NEW.conteudo) THEN
    RAISE EXCEPTION 'artefatos_tarefa: formato json exige conteúdo JSON válido';
  END IF;
  IF NOT artefato_referencias_validas(NEW.referencias) THEN
    RAISE EXCEPTION 'artefatos_tarefa: referências fora do formato fechado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.referencias) AS e(v)
     WHERE e.v ->> 'tipo' = 'artefato'
       AND NOT EXISTS (
         SELECT 1 FROM tarefas_dependencias td
          WHERE td.tarefa_id = NEW.tarefa_id AND td.depende_de_id = (e.v ->> 'tarefaId')::uuid
       )
  ) THEN
    RAISE EXCEPTION 'artefatos_tarefa: uma referência a artefato só aponta para uma dependência direta';
  END IF;
  NEW.criado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER artefatos_tarefa_controla
  BEFORE INSERT OR UPDATE OR DELETE ON artefatos_tarefa
  FOR EACH ROW EXECUTE FUNCTION artefatos_tarefa_controlar();

-- =====================================================================================================
-- 6. agent_steps: plano, tarefa e operação
-- =====================================================================================================

ALTER TABLE agent_steps
  ADD COLUMN plano_id uuid REFERENCES planos_demanda(id) ON DELETE RESTRICT,
  ADD COLUMN tarefa_id uuid,
  ADD COLUMN operacao text CHECK (operacao IN ('planejamento','execucao','integracao','auditoria')),
  ADD CONSTRAINT agent_steps_tarefa_plano_fkey FOREIGN KEY (tarefa_id, plano_id) REFERENCES tarefas(id, plano_id) ON DELETE RESTRICT,
  ADD CONSTRAINT agent_steps_tarefa_check CHECK (tarefa_id IS NULL OR plano_id IS NOT NULL),
  ADD CONSTRAINT agent_steps_plano_operacao_check CHECK (plano_id IS NULL OR operacao IS NOT NULL);

CREATE INDEX agent_steps_demanda_idx ON agent_steps (demanda_id);

-- Um passo com plano pertence à mesma demanda do plano. Os passos legados (sem plano) nem entram aqui.
CREATE FUNCTION agent_steps_conferir_plano() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM planos_demanda p WHERE p.id = NEW.plano_id AND p.demanda_id = NEW.demanda_id) THEN
    RAISE EXCEPTION 'agent_steps: o plano precisa ser da mesma demanda do passo';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_steps_confere_plano
  BEFORE INSERT OR UPDATE ON agent_steps
  FOR EACH ROW WHEN (NEW.plano_id IS NOT NULL)
  EXECUTE FUNCTION agent_steps_conferir_plano();

-- =====================================================================================================
-- 7. reservas_custo
-- =====================================================================================================

-- Toda chamada de uma demanda com envelope reserva antes de ser enviada (a PR 3.2b liga isso). A reserva é
-- gravada com o envelope travado e só se o comprometido mais ela couber no limite; o gatilho repete a conta,
-- então nem SQL direto passa do limite. Uma reserva de tarefa pertence ao claim atual (uma por claim) e é
-- exigida pelo registro de envio. Liquidar exige o agent_step da mesma chamada, com o custo real (FK e UNIQUE:
-- um passo liquida no máximo uma reserva). Cancelar ou reter nunca cria agent_step.
CREATE TABLE reservas_custo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES orquestracao_demandas(demanda_id) ON DELETE RESTRICT,
  plano_id uuid REFERENCES planos_demanda(id) ON DELETE RESTRICT,
  tarefa_id uuid,
  claim_id uuid,
  operacao text NOT NULL CHECK (operacao IN ('planejamento','execucao','integracao','auditoria')),
  modelo text NOT NULL CHECK (modelo ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
  valor_reservado_usd numeric(12,6) NOT NULL CHECK (valor_reservado_usd > 0),
  estado text NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta','liquidada','cancelada','retida','reconhecida')),
  custo_real_usd numeric(12,6) CHECK (custo_real_usd >= 0),
  agent_step_id uuid REFERENCES agent_steps(id) ON DELETE RESTRICT,
  reconhecida_por text CHECK (reconhecida_por ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  expira_em timestamptz NOT NULL,
  criada_em timestamptz NOT NULL DEFAULT now(),
  encerrada_em timestamptz,
  CONSTRAINT reservas_custo_tarefa_plano_fkey FOREIGN KEY (tarefa_id, plano_id) REFERENCES tarefas(id, plano_id) ON DELETE RESTRICT,
  CONSTRAINT reservas_custo_agent_step_id_key UNIQUE (agent_step_id),
  CONSTRAINT reservas_custo_tarefa_check CHECK (tarefa_id IS NULL OR plano_id IS NOT NULL),
  CONSTRAINT reservas_custo_claim_check CHECK ((tarefa_id IS NULL) = (claim_id IS NULL)),
  CONSTRAINT reservas_custo_operacao_tarefa_check CHECK (
    (operacao <> 'integracao' OR tarefa_id IS NOT NULL) AND (tarefa_id IS NULL OR operacao IN ('execucao','integracao'))
  ),
  CONSTRAINT reservas_custo_liquidada_check CHECK (
    (estado = 'liquidada') = (custo_real_usd IS NOT NULL) AND (estado = 'liquidada') = (agent_step_id IS NOT NULL)
  ),
  CONSTRAINT reservas_custo_reconhecida_check CHECK ((estado = 'reconhecida') = (reconhecida_por IS NOT NULL)),
  CONSTRAINT reservas_custo_encerrada_check CHECK ((estado = 'aberta') = (encerrada_em IS NULL)),
  CONSTRAINT reservas_custo_expira_check CHECK (expira_em > criada_em)
);

-- Uma reserva por claim.
CREATE UNIQUE INDEX reservas_custo_claim_idx ON reservas_custo (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX reservas_custo_demanda_idx ON reservas_custo (demanda_id, estado);
-- Varredura do watchdog: reservas abertas vencidas viram retidas.
CREATE INDEX reservas_custo_abertas_idx ON reservas_custo (expira_em) WHERE estado = 'aberta';

CREATE FUNCTION reservas_custo_controlar() RETURNS trigger AS $$
DECLARE
  v_envelope orquestracao_demandas%ROWTYPE;
  v_tarefa tarefas%ROWTYPE;
  v_demanda_plano uuid;
  v_comprometido numeric;
  v_limite numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservas_custo: DELETE não é permitido';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'aberta' OR num_nonnulls(NEW.custo_real_usd, NEW.agent_step_id, NEW.reconhecida_por, NEW.encerrada_em) > 0 THEN
      RAISE EXCEPTION 'reservas_custo: uma reserva nasce aberta';
    END IF;
    SELECT * INTO v_envelope FROM orquestracao_demandas WHERE demanda_id = NEW.demanda_id FOR UPDATE;
    IF v_envelope.bloqueada_por_custo THEN
      RAISE EXCEPTION 'reservas_custo: a demanda está bloqueada por custo';
    END IF;
    IF NEW.plano_id IS NOT NULL THEN
      SELECT demanda_id INTO v_demanda_plano FROM planos_demanda WHERE id = NEW.plano_id;
      IF v_demanda_plano IS DISTINCT FROM NEW.demanda_id THEN
        RAISE EXCEPTION 'reservas_custo: o plano precisa ser da mesma demanda';
      END IF;
    END IF;
    IF NEW.tarefa_id IS NOT NULL THEN
      SELECT * INTO v_tarefa FROM tarefas WHERE id = NEW.tarefa_id FOR SHARE;
      IF v_tarefa.estado <> 'em_execucao' OR v_tarefa.enviada_em IS NOT NULL OR v_tarefa.claim_id IS DISTINCT FROM NEW.claim_id THEN
        RAISE EXCEPTION 'reservas_custo: a reserva de uma tarefa é do claim atual, antes do envio';
      END IF;
      IF v_tarefa.modelo IS DISTINCT FROM NEW.modelo
         OR NEW.operacao <> (CASE v_tarefa.tipo WHEN 'especialista' THEN 'execucao' ELSE 'integracao' END) THEN
        RAISE EXCEPTION 'reservas_custo: modelo e operação precisam ser os do snapshot da tarefa';
      END IF;
    END IF;
    NEW.criada_em := now();
    IF NEW.expira_em <= NEW.criada_em THEN
      RAISE EXCEPTION 'reservas_custo: expira_em precisa estar no futuro';
    END IF;
    v_comprometido := orquestracao_comprometido_usd(NEW.demanda_id);
    v_limite := orquestracao_limite_usd(NEW.demanda_id);
    IF v_comprometido + NEW.valor_reservado_usd > v_limite THEN
      RAISE EXCEPTION 'reservas_custo: a reserva passaria do limite da demanda';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.demanda_id <> OLD.demanda_id OR NEW.plano_id IS DISTINCT FROM OLD.plano_id
     OR NEW.tarefa_id IS DISTINCT FROM OLD.tarefa_id OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.operacao <> OLD.operacao OR NEW.modelo <> OLD.modelo OR NEW.valor_reservado_usd <> OLD.valor_reservado_usd
     OR NEW.expira_em <> OLD.expira_em OR NEW.criada_em <> OLD.criada_em THEN
    RAISE EXCEPTION 'reservas_custo: a identidade da reserva é imutável';
  END IF;

  IF OLD.estado = 'aberta' AND NEW.estado = 'liquidada' THEN
    IF NOT EXISTS (
      SELECT 1 FROM agent_steps s
       WHERE s.id = NEW.agent_step_id AND s.demanda_id = NEW.demanda_id AND s.modelo = NEW.modelo
         AND s.custo_usd = NEW.custo_real_usd AND s.operacao = NEW.operacao
         AND s.plano_id IS NOT DISTINCT FROM NEW.plano_id AND s.tarefa_id IS NOT DISTINCT FROM NEW.tarefa_id
    ) THEN
      RAISE EXCEPTION 'reservas_custo: a liquidação exige o agent_step da mesma chamada, com o custo real';
    END IF;
    NEW.encerrada_em := now();
  ELSIF OLD.estado = 'aberta' AND NEW.estado IN ('cancelada','retida') THEN
    NEW.encerrada_em := now();
  ELSIF OLD.estado = 'retida' AND NEW.estado = 'reconhecida' THEN
    NEW.encerrada_em := OLD.encerrada_em;
  ELSE
    RAISE EXCEPTION 'reservas_custo: transição % → % não é permitida', OLD.estado, NEW.estado;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservas_custo_controla
  BEFORE INSERT OR UPDATE OR DELETE ON reservas_custo
  FOR EACH ROW EXECUTE FUNCTION reservas_custo_controlar();

-- =====================================================================================================
-- 8. autorizacoes_custo (append-only)
-- =====================================================================================================

-- Autorização administrativa de custo adicional: de US$ 0,50 a 5,00 por vez. O gatilho trava o envelope, exige
-- o bloqueio por custo e confere os limites sob lock. autorizado_por é o login da requisição autenticada.
-- transacao é sempre txid_current(): é o que permite ao envelope conferir que o bloqueio saiu com uma
-- autorização da mesma transação.
CREATE TABLE autorizacoes_custo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  demanda_id uuid NOT NULL REFERENCES orquestracao_demandas(demanda_id) ON DELETE RESTRICT,
  valor_usd numeric(6,2) NOT NULL CHECK (valor_usd BETWEEN 0.50 AND 5.00),
  limite_anterior_usd numeric(10,2) NOT NULL,
  limite_novo_usd numeric(10,2) NOT NULL,
  autorizado_por text NOT NULL CHECK (autorizado_por ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  transacao bigint NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT autorizacoes_custo_limite_check CHECK (limite_novo_usd = limite_anterior_usd + valor_usd)
);
CREATE INDEX autorizacoes_custo_demanda_idx ON autorizacoes_custo (demanda_id, id);

-- Limite da demanda: teto base mais a soma das autorizações. Comprometido: todo o gasto realizado da demanda
-- (agent_steps, com o histórico inteiro, inclusive de antes do envelope) mais as reservas que ainda contam
-- (aberta, retida e reconhecida). Tudo em numeric; nada zera o comprometido. Funções únicas para o gatilho de
-- reservas_custo e para o repositório (src/db/orquestracao.ts) usarem a mesma regra.
CREATE FUNCTION orquestracao_limite_usd(p_demanda uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT e.teto_base_usd + COALESCE((SELECT sum(a.valor_usd) FROM autorizacoes_custo a WHERE a.demanda_id = e.demanda_id), 0)
    FROM orquestracao_demandas e
   WHERE e.demanda_id = p_demanda
$$;

CREATE FUNCTION orquestracao_comprometido_usd(p_demanda uuid) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT sum(s.custo_usd) FROM agent_steps s WHERE s.demanda_id = p_demanda), 0)
       + COALESCE((SELECT sum(r.valor_reservado_usd) FROM reservas_custo r
                    WHERE r.demanda_id = p_demanda AND r.estado IN ('aberta','retida','reconhecida')), 0)
$$;

CREATE FUNCTION autorizacoes_custo_controlar() RETURNS trigger AS $$
DECLARE
  v_envelope orquestracao_demandas%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'autorizacoes_custo é append-only: % não é permitido', TG_OP;
  END IF;
  SELECT * INTO v_envelope FROM orquestracao_demandas WHERE demanda_id = NEW.demanda_id FOR UPDATE;
  IF NOT FOUND OR NOT v_envelope.bloqueada_por_custo THEN
    RAISE EXCEPTION 'autorizacoes_custo: só uma demanda bloqueada por custo recebe autorização';
  END IF;
  IF NEW.limite_anterior_usd <> orquestracao_limite_usd(NEW.demanda_id) THEN
    RAISE EXCEPTION 'autorizacoes_custo: limite_anterior_usd diverge do limite atual';
  END IF;
  IF NEW.limite_novo_usd <> NEW.limite_anterior_usd + NEW.valor_usd THEN
    RAISE EXCEPTION 'autorizacoes_custo: limite_novo_usd precisa ser o anterior mais o valor';
  END IF;
  NEW.transacao := txid_current();
  NEW.criado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER autorizacoes_custo_controla
  BEFORE INSERT OR UPDATE OR DELETE ON autorizacoes_custo
  FOR EACH ROW EXECUTE FUNCTION autorizacoes_custo_controlar();

-- No COMMIT: a autorização libera o bloqueio na mesma transação (nenhuma autorização "solta").
CREATE FUNCTION autorizacoes_custo_conferir_no_commit() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM orquestracao_demandas e WHERE e.demanda_id = NEW.demanda_id AND e.bloqueada_por_custo) THEN
    RAISE EXCEPTION 'autorizacoes_custo: a autorização precisa liberar o bloqueio na mesma transação';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER autorizacoes_custo_confere_no_commit
  AFTER INSERT ON autorizacoes_custo
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION autorizacoes_custo_conferir_no_commit();

-- =====================================================================================================
-- 9. Eventos e avaliações de política: tarefa_id e claim_id
-- =====================================================================================================

ALTER TABLE agent_events ADD COLUMN tarefa_id uuid REFERENCES tarefas(id) ON DELETE RESTRICT;
CREATE INDEX agent_events_tarefa_idx ON agent_events (tarefa_id, id) WHERE tarefa_id IS NOT NULL;

-- claim_id liga a avaliação ao snapshot exato do claim que foi avaliado. Anuláveis: as avaliações de hoje (sem
-- tarefa) continuam iguais.
ALTER TABLE avaliacoes_politica
  ADD COLUMN tarefa_id uuid REFERENCES tarefas(id) ON DELETE RESTRICT,
  ADD COLUMN claim_id uuid,
  ADD CONSTRAINT avaliacoes_politica_claim_check CHECK ((tarefa_id IS NULL) = (claim_id IS NULL));
CREATE INDEX avaliacoes_politica_tarefa_idx ON avaliacoes_politica (tarefa_id, id) WHERE tarefa_id IS NOT NULL;

-- Um evento com tarefa pertence à mesma demanda da tarefa.
CREATE FUNCTION agent_events_conferir_tarefa() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tarefas t JOIN planos_demanda p ON p.id = t.plano_id
     WHERE t.id = NEW.tarefa_id AND p.demanda_id = NEW.demanda_id
  ) THEN
    RAISE EXCEPTION 'agent_events: a tarefa precisa ser da mesma demanda do evento';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_events_confere_tarefa
  BEFORE INSERT ON agent_events
  FOR EACH ROW WHEN (NEW.tarefa_id IS NOT NULL)
  EXECUTE FUNCTION agent_events_conferir_tarefa();

-- Uma avaliação com tarefa pertence à mesma demanda, e a operação do contexto é a da tarefa (execucao para
-- especialista, integracao para integração). No estágio pre, o contexto é exatamente o snapshot do claim
-- atual: mesmo claim_id, agente, papel e modelo.
CREATE FUNCTION avaliacoes_politica_conferir_tarefa() RETURNS trigger AS $$
DECLARE
  v_tarefa tarefas%ROWTYPE;
  v_demanda uuid;
BEGIN
  SELECT t.* INTO v_tarefa FROM tarefas t WHERE t.id = NEW.tarefa_id;
  SELECT p.demanda_id INTO v_demanda FROM planos_demanda p WHERE p.id = v_tarefa.plano_id;
  IF v_demanda IS DISTINCT FROM NEW.demanda_id THEN
    RAISE EXCEPTION 'avaliacoes_politica: a tarefa precisa ser da mesma demanda da avaliação';
  END IF;
  IF (NEW.contexto ->> 'operacao') IS DISTINCT FROM (CASE v_tarefa.tipo WHEN 'especialista' THEN 'execucao' ELSE 'integracao' END) THEN
    RAISE EXCEPTION 'avaliacoes_politica: a operação precisa ser a da tarefa';
  END IF;
  IF NEW.estagio = 'pre' AND (
    v_tarefa.claim_id IS DISTINCT FROM NEW.claim_id
    OR v_tarefa.agente_chave IS DISTINCT FROM NEW.contexto ->> 'agente'
    OR v_tarefa.agente_papel IS DISTINCT FROM NEW.contexto ->> 'papel'
    OR v_tarefa.modelo IS DISTINCT FROM NEW.contexto ->> 'modelo'
  ) THEN
    RAISE EXCEPTION 'avaliacoes_politica: a avaliação pre usa exatamente o snapshot do claim atual';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER avaliacoes_politica_confere_tarefa
  BEFORE INSERT ON avaliacoes_politica
  FOR EACH ROW WHEN (NEW.tarefa_id IS NOT NULL)
  EXECUTE FUNCTION avaliacoes_politica_conferir_tarefa();

-- Policy Engine: o vocabulário fechado de "operacao" ganha "integracao". Só ACRESCENTA um valor: toda condição e
-- todo contexto já gravados continuam válidos. Mesma regra do Zod em src/db/politicas.ts (OPERACOES_AVALIADAS).
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
