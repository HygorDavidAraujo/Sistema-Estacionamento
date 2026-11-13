CREATE TABLE IF NOT EXISTS mensalista_contratos (
    id BIGSERIAL PRIMARY KEY,
    mensalista_id BIGINT NOT NULL UNIQUE REFERENCES mensalistas(id),
    plano VARCHAR(80) NOT NULL DEFAULT 'Mensal',
    valor_mensal NUMERIC(10,2) NOT NULL CHECK (valor_mensal > 0),
    inicio DATE NOT NULL,
    dia_base INTEGER NOT NULL CHECK (dia_base BETWEEN 1 AND 31),
    pago_ate DATE,
    estado VARCHAR(16) NOT NULL CHECK (estado IN ('ativo','suspenso','cancelado')),
    renovacao VARCHAR(16) NOT NULL DEFAULT 'pagamento' CHECK (renovacao='pagamento'),
    limite_simultaneo INTEGER NOT NULL DEFAULT 1 CHECK (limite_simultaneo BETWEEN 1 AND 20),
    revisao INTEGER NOT NULL DEFAULT 0,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mensalista_veiculos (
    id BIGSERIAL PRIMARY KEY,
    mensalista_id BIGINT NOT NULL REFERENCES mensalistas(id),
    placa VARCHAR(16) NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_mensalista_veiculos_cliente ON mensalista_veiculos(mensalista_id);
CREATE TABLE IF NOT EXISTS mensalista_cobrancas (
    id BIGSERIAL PRIMARY KEY,
    contrato_id BIGINT NOT NULL REFERENCES mensalista_contratos(id),
    chave VARCHAR(100) NOT NULL UNIQUE,
    criada_por BIGINT NOT NULL,
    competencia DATE NOT NULL,
    inicio_periodo DATE NOT NULL,
    fim_periodo DATE NOT NULL,
    vencimento DATE NOT NULL,
    meses INTEGER NOT NULL CHECK (meses BETWEEN 1 AND 24),
    dia_base INTEGER NOT NULL CHECK (dia_base BETWEEN 1 AND 31),
    valor_mensal NUMERIC(10,2) NOT NULL CHECK (valor_mensal > 0),
    total NUMERIC(10,2) NOT NULL CHECK (total > 0),
    pago NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (pago >= 0 AND pago <= total),
    estado VARCHAR(16) NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta','parcial','paga','cancelada')),
    motivo_cancelamento VARCHAR(255),
    cancelada_por BIGINT,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (fim_periodo > inicio_periodo),
    CHECK ((estado='paga' AND pago=total) OR (estado='parcial' AND pago>0 AND pago<total) OR (estado IN ('aberta','cancelada') AND pago=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobranca_aberta_contrato ON mensalista_cobrancas(contrato_id) WHERE estado IN ('aberta','parcial');
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobranca_periodo ON mensalista_cobrancas(contrato_id,inicio_periodo) WHERE estado <> 'cancelada';
ALTER TABLE historico ADD COLUMN IF NOT EXISTS mensalista_id BIGINT REFERENCES mensalistas(id);
ALTER TABLE historico ADD COLUMN IF NOT EXISTS mensalista_cobertura_ate TIMESTAMPTZ;
ALTER TABLE operacoes_financeiras ADD COLUMN IF NOT EXISTS cobranca_id BIGINT REFERENCES mensalista_cobrancas(id);
CREATE INDEX IF NOT EXISTS idx_operacoes_cobranca ON operacoes_financeiras(cobranca_id);
-- Preserva cadastros e validades legadas. Não cria cobranças ou recebimentos retroativos.
INSERT INTO mensalista_contratos (mensalista_id,valor_mensal,inicio,dia_base,pago_ate,estado)
SELECT m.id, GREATEST(COALESCE((SELECT valor::numeric FROM configuracoes WHERE chave='valor_mensalidade'),300),0.01),
       (m.criado_em AT TIME ZONE 'America/Sao_Paulo')::date,
       EXTRACT(DAY FROM COALESCE(m.vencimento,(m.criado_em AT TIME ZONE 'America/Sao_Paulo')::date))::int,
       m.vencimento,CASE WHEN m.ativo THEN 'ativo' ELSE 'suspenso' END
FROM mensalistas m ON CONFLICT (mensalista_id) DO NOTHING;
INSERT INTO mensalista_veiculos (mensalista_id,placa) SELECT id,placa FROM mensalistas ON CONFLICT (placa) DO NOTHING;
