CREATE TABLE IF NOT EXISTS usuarios (
    id BIGSERIAL PRIMARY KEY,
    login VARCHAR(60) UNIQUE NOT NULL,
    nome VARCHAR(120) NOT NULL,
    perfil VARCHAR(20) NOT NULL CHECK (perfil IN ('operador','supervisor','financeiro','administrador')),
    senha_hash TEXT NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sessoes (
    token_hash VARCHAR(64) PRIMARY KEY,
    usuario_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    csrf_token VARCHAR(64) NOT NULL,
    expira_em TIMESTAMPTZ NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id);
ALTER TABLE historico ADD COLUMN IF NOT EXISTS tarifa JSONB;
ALTER TABLE historico ADD COLUMN IF NOT EXISTS comprovante_entrada JSONB;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS usuario_id BIGINT;
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS usuario_nome VARCHAR(120);
CREATE TABLE IF NOT EXISTS operacoes_financeiras (
    chave VARCHAR(100) PRIMARY KEY,
    tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('saida','mensalidade')),
    referencia BIGINT NOT NULL,
    usuario_id BIGINT NOT NULL,
    requisicao_hash VARCHAR(64) NOT NULL,
    resposta JSONB NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE caixa_movimentos ADD COLUMN IF NOT EXISTS operacao_chave VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_operacao ON caixa_movimentos(operacao_chave);
CREATE TABLE IF NOT EXISTS cotacoes_saida (
    chave VARCHAR(64) PRIMARY KEY,
    historico_id BIGINT NOT NULL,
    usuario_id BIGINT NOT NULL REFERENCES usuarios(id),
    dados JSONB NOT NULL,
    expira_em TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cotacoes_expiracao ON cotacoes_saida(expira_em);
INSERT INTO configuracoes (chave,valor,descricao) VALUES
    ('nome_estacionamento','Estacionamento','Nome exibido nos comprovantes'),
    ('documento_estacionamento','','Documento exibido nos comprovantes'),
    ('endereco_estacionamento','','Endereço exibido nos comprovantes'),
    ('telefone_estacionamento','','Telefone exibido nos comprovantes')
ON CONFLICT (chave) DO NOTHING;
