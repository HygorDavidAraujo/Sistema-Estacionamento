(function () {
    let user = null;
    let csrf = '';
    let setup = false;
    let bound = false;
    let generation = 0;
    const el = id => document.getElementById(id);
    const base = () => window.BACKEND_BASE || `${location.origin}/api`;
    const roles = { operador: 'Operador', supervisor: 'Supervisor', financeiro: 'Financeiro', administrador: 'Administrador' };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
    function headers(initial) {
        const result = new Headers(initial || {});
        if (csrf) result.set('x-csrf-token', csrf);
        return result;
    }
    async function request(url, options = {}) {
        const epoch = generation;
        const response = await fetch(url, { ...options, credentials: 'include', headers: headers(options.headers) });
        if (epoch !== generation) throw new Error('Sessão encerrada');
        if (response.status === 401 && user) expire();
        return response;
    }
    async function json(path, method = 'GET', body) {
        const response = await request(`${base()}${path}`, { method, headers: body ? { 'Content-Type':'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) throw Object.assign(new Error(data.error || 'Não foi possível concluir'),{ status:response.status });
        return data;
    }
    function applyPermissions() {
        const role = user?.perfil;
        document.body.dataset.session = user ? 'active' : 'locked';
        el('btnAuth').textContent = user ? 'Sair' : 'Acesso';
        el('sessionIdentity').textContent = user ? `${user.nome} · ${roles[role]}` : 'Entre para operar o estacionamento';
        const permissions = {
            btnEntrada: ['operador','supervisor','administrador'], btnSaida: ['operador','supervisor','administrador'],
            btnMenu: ['administrador'], btnUsuarios: ['administrador'], btnMinhaSenha: Object.keys(roles),
            btnFecharCaixa: Object.keys(roles), btnTurnoCaixa: Object.keys(roles),
            btnBackupImport: ['administrador'], btnBackupExport: ['administrador']
        };
        for (const [id, allowed] of Object.entries(permissions)) if (el(id)) el(id).hidden = !allowed.includes(role);
        if (el('caixaSidebar')) el('caixaSidebar').hidden = !user;
        for (const id of ['btnNovoMensalista','btnSalvarMensalista','btnLimparMensalista']) if (el(id)) el(id).hidden = !['supervisor','administrador'].includes(role);
        if (el('mensalistasPopup')) el('mensalistasPopup').dataset.canEdit = String(['supervisor','administrador'].includes(role));
        document.querySelectorAll('.btn-cancel-card').forEach(button => { button.hidden = !['supervisor','administrador'].includes(role); });
        document.querySelectorAll('.btn-saida-card').forEach(button => { button.hidden = !['operador','supervisor','administrador'].includes(role); });
    }
    function clearLocal() {
        StorageService.clearOperationalData?.();
        ['adminToken','vehicleDB','valorHora','valorHoraAdicional','toleranciaHoraAdicional','valorMensalidade','valorDiaria','totalVagas'].forEach(key => localStorage.removeItem(key));
        for (const id of ['patioCarList','historicoConteudo','mensalistasLista','mensalidadeHistoricoConteudo','relatorioCaixaConteudo','fechamentosConteudo','comprovanteEntrada','comprovantePermanencia','comprovanteMensalidade','resumoPagamento','mensalidadeResumo','fechamentoResumo','turnoResumo','splitPagamentoLista','splitMensalidadeLista','usuariosLista','restoreResumo','toastContainer']) if (el(id)) el(id).replaceChildren();
        document.querySelectorAll('.popup input:not([id^="auth"]), .popup textarea').forEach(input => {
            input.value = '';
            if (input.type === 'checkbox') input.checked = false;
        });
        window.dadosPagamento = null; window.mensalidadePagamento = null;
        window.ReceiptService?.clear();
        window.CashService?.clear();
        if(el('comprovanteCaixa'))el('comprovanteCaixa').replaceChildren();
        window.PlateCamera?.close();
        document.querySelectorAll('.popup').forEach(popup => popup.setAttribute('aria-hidden','true'));
        document.querySelectorAll('.caixa-item .valor').forEach(node => { node.textContent = node.id === 'caixaTransacoes' ? '0' : 'R$ ••••••'; node.dataset.valor = '0'; });
    }
    function expire() {
        generation++;
        user = null; csrf = ''; clearLocal(); applyPermissions();
        el('authForm').reset();
        el('authMessage').textContent = 'Entre novamente para continuar.';
        el('authPopup').setAttribute('aria-hidden','false');
        window.onSessionEnded?.();
    }
    async function status() {
        const data = await json('/auth/status');
        setup = data.primeiro_acesso;
        el('authTitle').textContent = setup ? 'Primeiro acesso' : 'Acesso ao estacionamento';
        el('authSetupFields').hidden = !setup;
        el('authNome').required = setup; el('authCodigo').required = setup;
        el('authSubmit').textContent = setup ? 'Criar administrador' : 'Entrar';
        el('authSenha').autocomplete = setup ? 'new-password' : 'current-password';
        el('authMessage').textContent = setup ? 'Crie seu administrador com o código de primeiro acesso fornecido na implantação.' : '';
    }
    async function initialize() {
        if (!bound) bind();
        localStorage.removeItem('adminToken');
        let available = false;
        el('authSubmit').disabled = true; el('authRetry').disabled = true;
        try {
            await status();
            available = true;
            const response = await request(`${base()}/auth/me`);
            if (response.ok) {
                const data = await response.json(); user = data.usuario; csrf = data.csrf;
            }
        } catch (error) { el('authMessage').textContent = error.message; }
        if (!user) { clearLocal(); el('authPopup').setAttribute('aria-hidden','false'); }
        applyPermissions();
        el('authSubmit').disabled = !available;
        el('authRetry').disabled = false; el('authRetry').hidden = available;
        return Boolean(user);
    }
    async function access() {
        if (user) {
            try { await json('/auth/logout','POST',{}); expire(); el('authMessage').textContent = 'Sessão encerrada.'; }
            catch (error) { el('authMessage').textContent = error.message; window.notify?.('Não foi possível encerrar a sessão no servidor. Tente novamente.','error'); }
        } else {
            try { await status(); } catch (error) { el('authMessage').textContent = error.message; }
            el('authPopup').setAttribute('aria-hidden','false'); el('authLogin').focus();
        }
    }
    async function loadUsers() {
        const { dados } = await json('/auth/users');
        const list = el('usuariosLista'); list.replaceChildren();
        for (const row of dados) {
            const item = document.createElement('div'); item.className = 'user-row';
            const text = document.createElement('span'); text.textContent = `${row.nome} (${row.login}) · ${roles[row.perfil]} · ${row.ativo ? 'Ativo' : 'Inativo'}`;
            const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Editar'; edit.className = 'btn-ghost';
            edit.onclick = () => { el('usuarioId').value = row.id; el('usuarioNome').value = row.nome; el('usuarioLogin').value = row.login; el('usuarioLogin').readOnly = true; el('usuarioPerfil').value = row.perfil; el('usuarioAtivo').checked = row.ativo; el('usuarioSenha').value = ''; el('usuarioSenha').required = false; };
            item.append(text, edit); list.append(item);
        }
    }
    function resetUserForm() { el('usuarioForm').reset(); el('usuarioId').value = ''; el('usuarioLogin').readOnly = false; el('usuarioSenha').required = true; el('usuarioAtivo').checked = true; }
    function bind() {
        bound = true;
        el('authRetry').addEventListener('click',async()=>{
            if(await initialize()) await window.onSessionStarted?.();
        });
        el('authForm').addEventListener('submit', async event => {
            event.preventDefault(); const button = el('authSubmit'); button.disabled = true;
            try {
                const data = await json(setup ? '/auth/setup' : '/auth/login','POST',{ login: el('authLogin').value, senha: el('authSenha').value, nome: el('authNome').value, codigo: el('authCodigo').value });
                user = data.usuario; csrf = data.csrf; setup = false;
                el('authSetupFields').hidden = true; el('authNome').required = false; el('authCodigo').required = false;
                el('authTitle').textContent = 'Acesso ao estacionamento'; el('authSubmit').textContent = 'Entrar';
                el('authSenha').autocomplete = 'current-password';
                el('authForm').reset(); el('authMessage').textContent = ''; el('authPopup').setAttribute('aria-hidden','true'); applyPermissions();
                await window.onSessionStarted?.();
            } catch (error) { el('authMessage').textContent = error.message; if(error.status===503)el('authRetry').hidden=false; }
            finally { button.disabled = false; }
        });
        el('btnUsuarios').addEventListener('click', async () => {
            el('menu').setAttribute('aria-hidden','true');
            el('usuariosPopup').setAttribute('aria-hidden','false'); resetUserForm();
            try { await loadUsers(); } catch (error) { el('usuariosMessage').textContent = error.message; }
        });
        el('usuarioNovo').addEventListener('click',resetUserForm);
        el('usuarioForm').addEventListener('submit',async event => {
            event.preventDefault(); const button = el('usuarioSalvar'); button.disabled = true;
            try {
                const id = el('usuarioId').value;
                await json(id ? `/auth/users/${id}` : '/auth/users', id ? 'PATCH':'POST',{ nome:el('usuarioNome').value,login:el('usuarioLogin').value,perfil:el('usuarioPerfil').value,ativo:el('usuarioAtivo').checked,senha:el('usuarioSenha').value });
                el('usuariosMessage').textContent = 'Usuário salvo. Sessões anteriores do usuário editado foram encerradas.';
                resetUserForm(); await loadUsers();
            } catch (error) { el('usuariosMessage').textContent = error.message; }
            finally { button.disabled = false; }
        });
        el('btnMinhaSenha').addEventListener('click',() => el('senhaPopup').setAttribute('aria-hidden','false'));
        el('senhaForm').addEventListener('submit',async event => {
            event.preventDefault(); const button = el('senhaSalvar'); button.disabled = true;
            try {
                await json('/auth/senha','POST',{ senha_atual:el('senhaAtual').value,nova_senha:el('senhaNova').value });
                el('senhaForm').reset(); expire(); el('authMessage').textContent = 'Senha alterada. Entre com a nova senha.';
            } catch (error) { el('senhaMessage').textContent = error.message; }
            finally { button.disabled = false; }
        });
    }
    window.AuthService = { initialize, access, fetch:request, headers, applyPermissions, expire, get user() { return user; } };
})();
