-- Turnos anteriores continuam identificados como legados, sem atribuição financeira inventada.
ALTER TABLE caixa_turnos ADD COLUMN IF NOT EXISTS operador_id BIGINT;
ALTER TABLE caixa_turnos ADD COLUMN IF NOT EXISTS operador_nome VARCHAR(120);
ALTER TABLE caixa_turnos ADD COLUMN IF NOT EXISTS fundo_inicial NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fundo_inicial >= 0);
ALTER TABLE caixa_turnos ADD COLUMN IF NOT EXISTS estado VARCHAR(32) NOT NULL DEFAULT 'legado' CHECK (estado IN ('legado','aberto','aguardando_aprovacao','fechado'));
ALTER TABLE caixa_turnos ADD COLUMN IF NOT EXISTS revisao INTEGER NOT NULL DEFAULT 0;
ALTER TABLE caixa_turnos ADD COLUMN IF NOT EXISTS ultima_conferencia_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unico_caixa_aberto ON caixa_turnos ((true)) WHERE estado='aberto';
ALTER TABLE caixa_movimentos ADD COLUMN IF NOT EXISTS turno_id BIGINT REFERENCES caixa_turnos(id);
ALTER TABLE caixa_movimentos ADD COLUMN IF NOT EXISTS operador_id BIGINT;
ALTER TABLE caixa_movimentos ADD COLUMN IF NOT EXISTS operador_nome VARCHAR(120);
CREATE INDEX IF NOT EXISTS idx_movimentos_turno ON caixa_movimentos(turno_id);
ALTER TABLE operacoes_financeiras ADD COLUMN IF NOT EXISTS turno_id BIGINT REFERENCES caixa_turnos(id);
CREATE INDEX IF NOT EXISTS idx_operacoes_turno ON operacoes_financeiras(turno_id);
CREATE TABLE IF NOT EXISTS caixa_ajustes (
    id BIGSERIAL PRIMARY KEY,
    turno_id BIGINT NOT NULL REFERENCES caixa_turnos(id),
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('sangria','suprimento')),
    valor NUMERIC(10,2) NOT NULL CHECK (valor > 0),
    motivo VARCHAR(255) NOT NULL CHECK (char_length(motivo) >= 10),
    usuario_id BIGINT NOT NULL,
    usuario_nome VARCHAR(120) NOT NULL,
    comprovante JSONB NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ajustes_turno ON caixa_ajustes(turno_id);
CREATE TABLE IF NOT EXISTS caixa_conferencias (
    id BIGSERIAL PRIMARY KEY,
    turno_id BIGINT NOT NULL REFERENCES caixa_turnos(id),
    versao INTEGER NOT NULL CHECK (versao > 0),
    resumo JSONB NOT NULL,
    contagem JSONB NOT NULL,
    diferencas JSONB NOT NULL,
    motivo VARCHAR(255),
    responsavel_id BIGINT NOT NULL,
    responsavel_nome VARCHAR(120) NOT NULL,
    estado VARCHAR(20) NOT NULL CHECK (estado IN ('pendente','aprovado')),
    aprovado_por BIGINT,
    aprovado_nome VARCHAR(120),
    aprovado_em TIMESTAMPTZ,
    motivo_aprovacao VARCHAR(255),
    substituida_em TIMESTAMPTZ,
    comprovante JSONB NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(turno_id,versao)
);
CREATE TABLE IF NOT EXISTS caixa_acoes (
    chave VARCHAR(100) PRIMARY KEY,
    acao VARCHAR(32) NOT NULL,
    turno_id BIGINT NOT NULL REFERENCES caixa_turnos(id),
    usuario_id BIGINT NOT NULL,
    requisicao_hash VARCHAR(64) NOT NULL,
    resposta JSONB NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
