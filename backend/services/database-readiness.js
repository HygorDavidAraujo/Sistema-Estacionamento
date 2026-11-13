// Trabalho de inicialização é aguardado pela requisição que precisa dele.
// Uma falha não fica memorizada como indisponibilidade permanente da instância.
export function createDatabaseReadiness({ initialize, now = Date.now, retryDelayMs = 1000, onError = () => {} }) {
    let initialized = false;
    let pending = null;
    let retryAt = 0;
    let failures = 0;
    function ready() {
        if (initialized) return Promise.resolve(true);
        if (pending) return pending;
        if (now() < retryAt) return Promise.resolve(false);
        pending = Promise.resolve().then(initialize).then(() => {
            initialized = true;
            failures = 0;
            retryAt = 0;
            return true;
        }).catch(error => {
            failures++;
            retryAt = now() + Math.min(15000, retryDelayMs * 2 ** Math.min(failures - 1, 4));
            onError(error);
            return false;
        }).finally(() => { pending = null; });
        return pending;
    }
    return { ready };
}

export function initializationFailure(error) {
    // Diagnóstico sem a URL de conexão, parâmetros, senhas ou stack do fornecedor.
    const code = String(error?.code || 'DATABASE_INITIALIZATION_FAILED');
    if (/timeout/i.test(String(error?.message || '')) || ['ETIMEDOUT','57014','55P03'].includes(code)) return { codigo: code, motivo: 'Tempo limite na conexão ou preparação do banco' };
    if (['ENOENT','ENOTDIR'].includes(code)) return { codigo: code, motivo: 'Arquivo SQL ausente no pacote da função' };
    if (['28P01','28000'].includes(code)) return { codigo: code, motivo: 'Credenciais do banco recusadas' };
    if (['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','08006'].includes(code)) return { codigo: code, motivo: 'Falha de rede na conexão PostgreSQL' };
    if (code === '42501') return { codigo: code, motivo: 'Permissão insuficiente para preparar o banco' };
    if(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(code))return {codigo:code,motivo:'Certificado TLS do banco não pôde ser verificado'};
    return { codigo: code, motivo: 'Não foi possível preparar o schema do banco' };
}
