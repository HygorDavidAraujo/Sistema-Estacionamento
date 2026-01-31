-- Schema compatível com Postgres para futura migração

CREATE TABLE IF NOT EXISTS historico (
    id BIGSERIAL PRIMARY KEY,
    entry_id TEXT UNIQUE,
    placa VARCHAR(16) NOT NULL,
    marca VARCHAR(120),
    modelo VARCHAR(120),
    cor VARCHAR(60),
    mensalista BOOLEAN NOT NULL DEFAULT FALSE,
    diarista BOOLEAN NOT NULL DEFAULT FALSE,
    cliente_nome VARCHAR(120),
    cliente_telefone VARCHAR(40),
    cliente_cpf VARCHAR(20),
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

CREATE TABLE IF NOT EXISTS mensalistas (
    id BIGSERIAL PRIMARY KEY,
    placa VARCHAR(16) UNIQUE NOT NULL,
    nome VARCHAR(120) NOT NULL,
    telefone VARCHAR(40),
    cpf VARCHAR(20),
    vencimento DATE,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mensalistas_placa ON mensalistas(placa);
CREATE INDEX IF NOT EXISTS idx_mensalistas_cpf ON mensalistas(cpf);

CREATE TABLE IF NOT EXISTS auditoria (
    id BIGSERIAL PRIMARY KEY,
    acao VARCHAR(120) NOT NULL,
    detalhes JSONB,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS caixa_movimentos (
    id BIGSERIAL PRIMARY KEY,
    origem VARCHAR(32) NOT NULL,
    historico_id BIGINT,
    mensalista_id BIGINT,
    placa VARCHAR(16),
    nome VARCHAR(120),
    valor_pago NUMERIC(10,2) NOT NULL,
    forma_pagamento VARCHAR(60),
    data_pagamento DATE NOT NULL DEFAULT CURRENT_DATE,
    hora_pagamento TIME NOT NULL DEFAULT CURRENT_TIME,
    observacao VARCHAR(255),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_data ON caixa_movimentos(data_pagamento);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_forma ON caixa_movimentos(forma_pagamento);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_origem ON caixa_movimentos(origem);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_hist ON caixa_movimentos(historico_id);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_mensalista ON caixa_movimentos(mensalista_id);

-- Seeds padrão (idempotente)
INSERT INTO configuracoes (chave, valor, descricao)
VALUES
 ('valor_hora_inicial', '5.00', 'Valor da primeira hora (R$)'),
 ('valor_hora_adicional', '2.50', 'Valor por hora adicional (R$)'),
 ('tempo_tolerancia', '15', 'Tempo de tolerância em minutos'),
 ('total_vagas', '50', 'Número total de vagas do estacionamento'),
 ('valor_mensalidade', '300.00', 'Valor da mensalidade (R$)'),
 ('valor_diaria', '25.00', 'Valor da diária (R$)')
ON CONFLICT (chave) DO NOTHING;
