ALTER TABLE demandas
  ADD COLUMN complexidade text NOT NULL DEFAULT 'MEDIUM',
  ADD COLUMN estimativa_uso jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE demandas
  ADD CONSTRAINT demandas_complexidade_check CHECK (complexidade IN ('LOW','MEDIUM','HIGH')),
  ADD CONSTRAINT demandas_estimativa_uso_check CHECK (jsonb_typeof(estimativa_uso) = 'object');
