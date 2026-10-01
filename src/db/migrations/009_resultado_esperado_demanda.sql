ALTER TABLE demandas
  ADD COLUMN resultado_esperado text NOT NULL DEFAULT 'outro',
  ADD COLUMN criterios_aceite text NOT NULL DEFAULT '';

ALTER TABLE demandas
  ADD CONSTRAINT demandas_resultado_esperado_check CHECK (resultado_esperado IN ('outro','interface','documento','analise','automacao','codigo')),
  ADD CONSTRAINT demandas_criterios_aceite_check CHECK (char_length(criterios_aceite) <= 10000);