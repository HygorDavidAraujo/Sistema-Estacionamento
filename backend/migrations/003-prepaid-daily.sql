-- Diárias novas são antecipadas e válidas até o horário combinado de retirada.
-- Registros antigos permanecem sem antecipação/horário presumidos.
ALTER TABLE historico ADD COLUMN IF NOT EXISTS diaria_retirada_em TIMESTAMPTZ;
ALTER TABLE historico ADD COLUMN IF NOT EXISTS diaria_valor_pago NUMERIC(10,2) CHECK (diaria_valor_pago >= 0);
ALTER TABLE operacoes_financeiras DROP CONSTRAINT IF EXISTS operacoes_financeiras_tipo_check;
ALTER TABLE operacoes_financeiras ADD CONSTRAINT operacoes_financeiras_tipo_check CHECK (tipo IN ('saida','mensalidade','diaria'));
