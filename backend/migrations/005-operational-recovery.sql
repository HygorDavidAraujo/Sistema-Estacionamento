CREATE TABLE IF NOT EXISTS operacao_estado (
    id INTEGER PRIMARY KEY CHECK (id=1),
    manutencao BOOLEAN NOT NULL DEFAULT false,
    motivo VARCHAR(255),
    usuario_id BIGINT,
    usuario_nome VARCHAR(120),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    backup_lease_id VARCHAR(100),
    backup_lease_ate TIMESTAMPTZ
);
INSERT INTO operacao_estado (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS backup_execucoes (
    id VARCHAR(100) PRIMARY KEY,
    chave_agendamento VARCHAR(100) UNIQUE,
    origem VARCHAR(20) NOT NULL CHECK (origem IN ('manual','agendamento')),
    estado VARCHAR(20) NOT NULL CHECK (estado IN ('executando','concluido','falhou')),
    arquivo TEXT,
    checksum VARCHAR(64),
    chave_id VARCHAR(16),
    tamanho BIGINT,
    registros INTEGER,
    verificado_em TIMESTAMPTZ,
    erro_codigo VARCHAR(100),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    concluido_em TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS operacao_restauracoes (
    id VARCHAR(100) PRIMARY KEY,
    snapshot BYTEA NOT NULL,
    checksum VARCHAR(64) NOT NULL,
    usuario_id BIGINT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS auth_recuperacoes (
    token_hash VARCHAR(64) PRIMARY KEY,
    usuario_id BIGINT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
