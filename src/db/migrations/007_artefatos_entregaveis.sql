-- Serviço de artefatos entregáveis. A migration 006 permanece imutável: artefatos_tarefa continuam sendo
-- contexto interno texto/json; esta tabela contém somente arquivos finais, publicados e baixáveis.

-- =====================================================================================================
-- 1. Capacidades explícitas, versionadas e auditáveis no catálogo de agentes
-- =====================================================================================================

CREATE FUNCTION formatos_entregaveis_validos(formatos text[]) RETURNS boolean AS $$
  SELECT formatos <@ ARRAY[
    'pdf','docx','xlsx','pptx','csv','tsv','json','yaml','xml','sql','txt','markdown','html','svg','ics','vcf','zip'
  ]::text[]
  AND cardinality(formatos) = (SELECT count(DISTINCT valor) FROM unnest(formatos) AS f(valor))
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE agentes
  ADD COLUMN gerar_artefatos text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN publicar_artefatos boolean NOT NULL DEFAULT false,
  ADD COLUMN ler_anexos boolean NOT NULL DEFAULT false,
  ADD COLUMN max_artefatos_por_demanda integer NOT NULL DEFAULT 0,
  ADD COLUMN max_bytes_por_artefato integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT agentes_gerar_artefatos_check CHECK (formatos_entregaveis_validos(gerar_artefatos)),
  ADD CONSTRAINT agentes_max_artefatos_check CHECK (max_artefatos_por_demanda BETWEEN 0 AND 5),
  ADD CONSTRAINT agentes_max_bytes_artefato_check CHECK (max_bytes_por_artefato BETWEEN 0 AND 5242880),
  ADD CONSTRAINT agentes_publicar_artefatos_check CHECK (NOT publicar_artefatos OR papel = 'coordenador'),
  ADD CONSTRAINT agentes_ler_anexos_desligado_check CHECK (NOT ler_anexos),
  ADD CONSTRAINT agentes_papel_sem_artefatos_check CHECK (
    papel NOT IN ('avaliador','auditor')
    OR (cardinality(gerar_artefatos) = 0 AND NOT publicar_artefatos AND max_artefatos_por_demanda = 0 AND max_bytes_por_artefato = 0)
  ),
  ADD CONSTRAINT agentes_limites_artefato_check CHECK (
    (cardinality(gerar_artefatos) = 0 AND max_artefatos_por_demanda = 0 AND max_bytes_por_artefato = 0)
    OR
    (cardinality(gerar_artefatos) > 0 AND max_artefatos_por_demanda > 0 AND max_bytes_por_artefato > 0)
  );

-- Amplia o mesmo gatilho da migration 003. As capacidades são campos versionáveis: qualquer SQL direto
-- também cria agentes_historico e incrementa a versão; identidade e papel continuam imutáveis.
CREATE OR REPLACE FUNCTION agentes_controlar_mudancas() RETURNS trigger AS $$
DECLARE
  campos jsonb := '{}'::jsonb;
  ator_da_mudanca text;
BEGIN
  IF NEW.id <> OLD.id OR NEW.chave <> OLD.chave OR NEW.nome <> OLD.nome OR NEW.descricao <> OLD.descricao
     OR NEW.categoria <> OLD.categoria OR NEW.papel <> OLD.papel THEN
    RAISE EXCEPTION 'agentes: id, chave, nome, descricao, categoria e papel são imutáveis nesta entrega';
  END IF;

  IF NEW.estado = OLD.estado AND NEW.modelo_permitido = OLD.modelo_permitido
     AND NEW.politica_ref IS NOT DISTINCT FROM OLD.politica_ref
     AND NEW.gerar_artefatos = OLD.gerar_artefatos
     AND NEW.publicar_artefatos = OLD.publicar_artefatos
     AND NEW.ler_anexos = OLD.ler_anexos
     AND NEW.max_artefatos_por_demanda = OLD.max_artefatos_por_demanda
     AND NEW.max_bytes_por_artefato = OLD.max_bytes_por_artefato THEN
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
  IF NEW.gerar_artefatos <> OLD.gerar_artefatos THEN
    campos := campos || jsonb_build_object('gerarArtefatos', jsonb_build_object('de', OLD.gerar_artefatos, 'para', NEW.gerar_artefatos));
  END IF;
  IF NEW.publicar_artefatos <> OLD.publicar_artefatos THEN
    campos := campos || jsonb_build_object('publicarArtefatos', jsonb_build_object('de', OLD.publicar_artefatos, 'para', NEW.publicar_artefatos));
  END IF;
  IF NEW.ler_anexos <> OLD.ler_anexos THEN
    campos := campos || jsonb_build_object('lerAnexos', jsonb_build_object('de', OLD.ler_anexos, 'para', NEW.ler_anexos));
  END IF;
  IF NEW.max_artefatos_por_demanda <> OLD.max_artefatos_por_demanda THEN
    campos := campos || jsonb_build_object('maxArtefatosPorDemanda', jsonb_build_object('de', OLD.max_artefatos_por_demanda, 'para', NEW.max_artefatos_por_demanda));
  END IF;
  IF NEW.max_bytes_por_artefato <> OLD.max_bytes_por_artefato THEN
    campos := campos || jsonb_build_object('maxBytesPorArtefato', jsonb_build_object('de', OLD.max_bytes_por_artefato, 'para', NEW.max_bytes_por_artefato));
  END IF;

  ator_da_mudanca := coalesce(nullif(current_setting('frota.ator_da_alteracao', true), ''), 'sistema:sql_direto');
  NEW.versao := OLD.versao + 1;
  NEW.atualizado_em := now();

  INSERT INTO agentes_historico (agente_id, ator, campos_alterados, versao_anterior, versao_nova)
  VALUES (OLD.id, ator_da_mudanca, campos, OLD.versao, NEW.versao);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

SELECT set_config('frota.ator_da_alteracao', 'sistema:migration_007', true);

UPDATE agentes SET
  gerar_artefatos = CASE WHEN papel IN ('avaliador','auditor') THEN ARRAY[]::text[] ELSE CASE categoria
      WHEN 'gestores' THEN ARRAY['pdf','docx','xlsx','pptx','csv','tsv','json','yaml','xml','sql','txt','markdown','html','svg','ics','vcf','zip']::text[]
      WHEN 'd1' THEN ARRAY['pdf','docx','pptx','json','yaml','xml','sql','txt','markdown','html','svg','zip']::text[]
      WHEN 'd2' THEN ARRAY['pdf','docx','csv','json','txt','markdown','html']::text[]
      WHEN 'd3' THEN ARRAY['pdf','docx','csv','json','txt','markdown','html']::text[]
      WHEN 'd4' THEN ARRAY['pdf','docx','json','yaml','xml','sql','txt','markdown','html']::text[]
      WHEN 'd5' THEN ARRAY['yaml','xml','sql','txt','markdown','html','zip']::text[]
      WHEN 'd6' THEN ARRAY['xlsx','csv','tsv','json','xml','txt','markdown','html']::text[]
      WHEN 'd7' THEN ARRAY['pdf','docx','pptx','json','yaml','xml','txt','markdown','html','svg','zip']::text[]
      WHEN 'd8' THEN ARRAY['pdf','docx','pptx','txt','markdown','html']::text[]
      WHEN 'd9' THEN ARRAY['json','sql','txt','markdown','zip']::text[]
      WHEN 'd10' THEN ARRAY['pdf','docx','xlsx','csv','tsv','json','txt','markdown','html']::text[]
      WHEN 'd11' THEN ARRAY['pdf','pptx','html','svg','zip']::text[]
      WHEN 'd12' THEN ARRAY['pdf','docx','csv','json','yaml','xml','sql','txt','markdown','html','zip']::text[]
      WHEN 'd13' THEN ARRAY['pdf','docx','xlsx','csv','tsv','json','yaml','txt','markdown','html','svg','zip']::text[]
      WHEN 'd14' THEN ARRAY['csv','tsv','json','yaml','xml','txt','markdown','html','ics','vcf','zip']::text[]
      WHEN 'd15' THEN ARRAY['pdf','docx','json','yaml','xml','sql','txt','markdown','html','svg','zip']::text[]
      WHEN 'd16' THEN ARRAY['pdf','docx','xlsx','pptx','csv','tsv','json','txt','markdown','html','svg','ics','vcf','zip']::text[]
      WHEN 'd17' THEN ARRAY[]::text[]
      WHEN 'd18' THEN ARRAY['pdf','docx','xlsx','pptx','csv','tsv','json','txt','markdown','html','ics','vcf']::text[]
    END
  END,
  publicar_artefatos = papel = 'coordenador',
  ler_anexos = false,
  max_artefatos_por_demanda = CASE WHEN papel IN ('avaliador','auditor') OR categoria = 'd17' THEN 0 WHEN papel = 'coordenador' THEN 5 ELSE 3 END,
  max_bytes_por_artefato = CASE WHEN papel IN ('avaliador','auditor') OR categoria = 'd17' THEN 0 ELSE 5242880 END;

-- =====================================================================================================
-- 2. Bytes finais imutáveis, metadados conferidos pelo banco
-- =====================================================================================================

CREATE FUNCTION artefato_entregavel_extensao(formato text) RETURNS text AS $$
  SELECT CASE formato
    WHEN 'pdf' THEN 'pdf' WHEN 'docx' THEN 'docx' WHEN 'xlsx' THEN 'xlsx' WHEN 'pptx' THEN 'pptx'
    WHEN 'csv' THEN 'csv' WHEN 'tsv' THEN 'tsv' WHEN 'json' THEN 'json' WHEN 'yaml' THEN 'yaml'
    WHEN 'xml' THEN 'xml' WHEN 'sql' THEN 'sql' WHEN 'txt' THEN 'txt' WHEN 'markdown' THEN 'md'
    WHEN 'html' THEN 'html' WHEN 'svg' THEN 'svg' WHEN 'ics' THEN 'ics' WHEN 'vcf' THEN 'vcf'
    WHEN 'zip' THEN 'zip'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION artefato_entregavel_mime(formato text) RETURNS text AS $$
  SELECT CASE formato
    WHEN 'pdf' THEN 'application/pdf'
    WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    WHEN 'pptx' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    WHEN 'csv' THEN 'text/csv; charset=utf-8'
    WHEN 'tsv' THEN 'text/tab-separated-values; charset=utf-8'
    WHEN 'json' THEN 'application/json'
    WHEN 'yaml' THEN 'application/yaml'
    WHEN 'xml' THEN 'application/xml'
    WHEN 'sql' THEN 'application/sql'
    WHEN 'txt' THEN 'text/plain; charset=utf-8'
    WHEN 'markdown' THEN 'text/markdown; charset=utf-8'
    WHEN 'html' THEN 'text/html; charset=utf-8'
    WHEN 'svg' THEN 'image/svg+xml'
    WHEN 'ics' THEN 'text/calendar; charset=utf-8'
    WHEN 'vcf' THEN 'text/vcard; charset=utf-8'
    WHEN 'zip' THEN 'application/zip'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE artefatos_entregaveis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demanda_id uuid NOT NULL REFERENCES demandas(id) ON DELETE RESTRICT,
  entrega_id uuid NOT NULL REFERENCES entregas(id) ON DELETE RESTRICT,
  ordem smallint NOT NULL CHECK (ordem BETWEEN 1 AND 5),
  formato text NOT NULL CHECK (formatos_entregaveis_validos(ARRAY[formato])),
  nome_arquivo text NOT NULL CHECK (
    char_length(nome_arquivo) BETWEEN 3 AND 100
    AND nome_arquivo ~ '^[a-z0-9][a-z0-9._-]*\.[a-z0-9]+$'
    AND right(nome_arquivo, char_length(artefato_entregavel_extensao(formato)) + 1) = '.' || artefato_entregavel_extensao(formato)
  ),
  mime_type text NOT NULL CHECK (mime_type = artefato_entregavel_mime(formato)),
  conteudo bytea NOT NULL,
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  gerado_por text NOT NULL REFERENCES agentes(chave) ON DELETE RESTRICT,
  publicado_por text NOT NULL REFERENCES agentes(chave) ON DELETE RESTRICT,
  classificacao text NOT NULL DEFAULT 'interna' CHECK (classificacao = 'interna'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artefatos_entregaveis_bytes_check CHECK (bytes = octet_length(conteudo)),
  CONSTRAINT artefatos_entregaveis_sha256_check CHECK (sha256 = encode(sha256(conteudo), 'hex')),
  CONSTRAINT artefatos_entregaveis_entrega_ordem_key UNIQUE (entrega_id, ordem),
  CONSTRAINT artefatos_entregaveis_entrega_nome_key UNIQUE (entrega_id, nome_arquivo)
);

CREATE INDEX artefatos_entregaveis_demanda_idx ON artefatos_entregaveis (demanda_id, ordem);

CREATE FUNCTION artefatos_entregaveis_controlar() RETURNS trigger AS $$
DECLARE
  demanda_da_entrega uuid;
  gerador_estado text;
  formatos_gerador text[];
  max_arquivos integer;
  max_bytes integer;
  publicador_estado text;
  publicador_papel text;
  pode_publicar boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'artefatos_entregaveis é append-only: % não é permitido', TG_OP;
  END IF;

  SELECT demanda_id INTO demanda_da_entrega FROM entregas WHERE id = NEW.entrega_id FOR SHARE;
  IF demanda_da_entrega IS NULL OR demanda_da_entrega <> NEW.demanda_id THEN
    RAISE EXCEPTION 'artefatos_entregaveis: entrega não pertence à demanda';
  END IF;

  SELECT estado, gerar_artefatos, max_artefatos_por_demanda, max_bytes_por_artefato
    INTO gerador_estado, formatos_gerador, max_arquivos, max_bytes
    FROM agentes WHERE chave = NEW.gerado_por FOR SHARE;
  IF gerador_estado IS DISTINCT FROM 'ativo' OR NOT (NEW.formato = ANY(formatos_gerador)) THEN
    RAISE EXCEPTION 'artefatos_entregaveis: agente não autorizado a gerar o formato';
  END IF;
  IF NEW.ordem > max_arquivos OR NEW.bytes > max_bytes THEN
    RAISE EXCEPTION 'artefatos_entregaveis: limite do agente gerador excedido';
  END IF;

  SELECT estado, papel, publicar_artefatos INTO publicador_estado, publicador_papel, pode_publicar
    FROM agentes WHERE chave = NEW.publicado_por FOR SHARE;
  IF publicador_estado IS DISTINCT FROM 'ativo' OR publicador_papel IS DISTINCT FROM 'coordenador' OR pode_publicar IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'artefatos_entregaveis: agente não autorizado a publicar';
  END IF;

  IF (SELECT count(*) FROM artefatos_entregaveis WHERE entrega_id = NEW.entrega_id) >= max_arquivos THEN
    RAISE EXCEPTION 'artefatos_entregaveis: quantidade máxima do agente gerador excedida';
  END IF;
  NEW.criado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER artefatos_entregaveis_controla
  BEFORE INSERT OR UPDATE OR DELETE ON artefatos_entregaveis
  FOR EACH ROW EXECUTE FUNCTION artefatos_entregaveis_controlar();
