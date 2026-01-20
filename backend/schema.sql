-- Schema compatível com Postgres para futura migração

CREATE TABLE IF NOT EXISTS historico (
    id BIGSERIAL PRIMARY KEY,
    entry_id TEXT UNIQUE,
    placa VARCHAR(16) NOT NULL,
    marca VARCHAR(120),
    modelo VARCHAR(120),
    cor VARCHAR(60),
    data_entrada DATE NOT NULL DEFAULT CURRENT_DATE,
    hora_entrada TIME NOT NULL DEFAULT CURRENT_TIME,
    data_saida DATE,
    hora_saida TIME,
    tempo_permanencia VARCHAR(32),
    valor_pago NUMERIC(10,2),
    forma_pagamento VARCHAR(60),
    status VARCHAR(16) NOT NULL DEFAULT 'ativo',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_historico_placa ON historico(placa);
CREATE INDEX IF NOT EXISTS idx_historico_status ON historico(status);
CREATE INDEX IF NOT EXISTS idx_historico_data_saida ON historico(data_saida);
CREATE INDEX IF NOT EXISTS idx_historico_forma_pagamento ON historico(forma_pagamento);

CREATE TABLE IF NOT EXISTS configuracoes (
    id BIGSERIAL PRIMARY KEY,
    chave VARCHAR(120) UNIQUE NOT NULL,
    valor VARCHAR(255) NOT NULL,
    descricao VARCHAR(255),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seeds padrão (idempotente)
INSERT INTO configuracoes (chave, valor, descricao)
VALUES
 ('valor_hora_inicial', '5.00', 'Valor da primeira hora (R$)'),
 ('valor_hora_adicional', '2.50', 'Valor por hora adicional (R$)'),
 ('tempo_tolerancia', '15', 'Tempo de tolerância em minutos'),
 ('total_vagas', '50', 'Número total de vagas do estacionamento')
ON CONFLICT (chave) DO NOTHING;
