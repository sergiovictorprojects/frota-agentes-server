-- Especificações de demanda podem ter muitos requisitos e etapas. A aplicação valida os mesmos limites
-- antes de persistir; esta migration mantém o banco como fronteira definitiva para escritas fora da UI.
ALTER TABLE demandas DROP CONSTRAINT demandas_descricao_check;
ALTER TABLE demandas ADD CONSTRAINT demandas_descricao_check CHECK (char_length(descricao) <= 100000);

ALTER TABLE demandas DROP CONSTRAINT demandas_referencias_check;
ALTER TABLE demandas ADD CONSTRAINT demandas_referencias_check CHECK (char_length(referencias) <= 20000);
