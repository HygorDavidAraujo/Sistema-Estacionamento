// Configuração: endereço do backend
const IS_LOCAL_ENV = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
let BACKEND_BASE = window.BACKEND_BASE || (IS_LOCAL_ENV ? 'http://localhost:3000' : `${location.origin}/api`);

function apiFetch(url, options = {}) { return AuthService.fetch(url,options); }
async function operationRequest(path, body) {
    const res = await apiFetch(`${BACKEND_BASE}${path}`,{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || 'Não foi possível concluir a operação');
    return data;
}

function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    if (typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
    }
    return undefined;
}

async function detectBackendPort(startPort = 3000, maxPort = 3005) {
    const host = location.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';
    if (location.protocol !== 'file:') {
        try {
            const current = await fetch(`${location.origin}/health`,{signal:timeoutSignal(1500)});
            if(current.ok && (await current.json()).service === 'estacionamento') return location.origin;
        } catch { /* Procura uma porta local se a interface estiver em outro servidor. */ }
    }
    for (let port = startPort; port <= maxPort; port++) {
        try {
            const res = await fetch(`http://${host}:${port}/health`, {
                method: 'GET',
                signal: timeoutSignal(1500)
            });
            if (res.ok && (await res.json()).service === 'estacionamento') {
                console.log(`[front] Backend detectado na porta ${port}`);
                return `http://${host}:${port}`;
            }
        } catch (e) {
            // Continua tentando próxima porta
        }
    }
    console.warn('[front] Backend não encontrado em portas 3000-3005, usando 3000 como padrão');
    return `http://${host}:3000`;
}

document.addEventListener('DOMContentLoaded', async () => {
    if (IS_LOCAL_ENV && !window.BACKEND_BASE) {
        BACKEND_BASE = await detectBackendPort();
    }
    window.BACKEND_BASE = BACKEND_BASE;
    updateAuthButton();
    StorageService.migrateLegacyEntries?.();
    bindUI();
    ReceiptService.bind();
    CashService.bind();
    ReportService.bind();SubscriptionService.bind();
    window.onSessionStarted = async () => {
        await loadConfig();
        await syncActiveEntriesFromBackend();
        await carregarDashboard();
        await CashService.refresh();await SubscriptionService.alerts();SubscriptionService.clearForm();
        updatePatioCarList();
    };
    window.onSessionEnded = () => { CashService.clear(); SubscriptionService.clear();ReportService.clear(); window.mensalistaEditId = null; restoreCandidate = null; clearEntradaForm(); };
    if (await AuthService.initialize()) await window.onSessionStarted();
    // atualiza tempos no pátio, dashboard vagas e caixa a cada 10s
    let refreshing = false;
    setInterval(async () => {
        if (refreshing || document.hidden || !AuthService.user) return;
        refreshing = true;
        try {
            await syncActiveEntriesFromBackend();
            updatePatioCarList();
            await Promise.allSettled([carregarDashboard(), CashService.refresh(), SubscriptionService.alerts()]);
        } finally { refreshing = false; }
    }, 10000);
});

///////////////////////////
// util tempo
///////////////////////////
function notify(message, type = 'info', timeout = 3200) {
    const container = document.getElementById('toastContainer');
    if (!container) { alert(message); return; }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 200);
    }, timeout);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function diffMs(start, end) { return end.getTime() - start.getTime(); }
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2,'0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2,'0');
    const s = String(totalSeconds % 60).padStart(2,'0');
    return `${h}:${m}:${s}`;
}

function parseEntradaDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'number') {
        const numericDate = new Date(value);
        if (!Number.isNaN(numericDate.getTime())) return numericDate;
    }
    const str = String(value).trim();
    const isoNoTz = str.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (isoNoTz) {
        const [, yyyy, mm, dd, hh, min, ss = '00'] = isoNoTz;
        return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss));
    }
    const direct = new Date(str);
    if (!Number.isNaN(direct.getTime())) return direct;
    const brMatch = str.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (brMatch) {
        const [, dd, mm, yyyy, hh = '00', min = '00', ss = '00'] = brMatch;
        return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`);
    }
    return null;
}

function calcularValoresPermanencia(horaEntradaISO, horaSaida = new Date()) {
    const horaEntrada = parseEntradaDate(horaEntradaISO) || new Date();
    let ms = diffMs(horaEntrada, horaSaida);
    if (ms < 0) ms = 0;
    const tempoFormatado = formatDuration(ms);
    const totalMinCeil = Math.ceil(ms / 60000);

    const valorHora = parseFloat(localStorage.getItem('valorHora')) || 0;
    const valorHoraAd = parseFloat(localStorage.getItem('valorHoraAdicional')) || 0;
    const tolerancia = parseInt(localStorage.getItem('toleranciaHoraAdicional')) || 0;
    const toleranciaMs = tolerancia * 60000;

    let total = 0;
    if (ms <= toleranciaMs) {
        total = 0;
    } else if (totalMinCeil <= 60) {
        total = valorHora;
    } else {
        const exced = totalMinCeil - 60;
        total = valorHora + Math.ceil(exced/60) * valorHoraAd;
    }

    return { tempoFormatado, total, horaEntrada, horaSaida, totalMin: totalMinCeil };
}

function getEntryPricing(entry, horaSaida = new Date()) {
    const { tempoFormatado, total, horaEntrada } = calcularValoresPermanencia(entry.horaEntradaMs ?? entry.horaEntrada, horaSaida);
    const valorDiaria = parseFloat(localStorage.getItem('valorDiaria') || '0');
    if (entry.mensalista) {
        return { tempoFormatado, total: 0, horaEntrada, horaSaida, tipo: 'mensalista' };
    }
    if (entry.diarista) {
        let due=entry.tarifa?.diaria!=null?entry.tarifa.diaria/100:valorDiaria;
        if(entry.diaria_retirada_em&&entry.diaria_valor_pago!=null){
            const minutes=Math.ceil(Math.max(0,horaSaida-new Date(entry.diaria_retirada_em))/60000);
            const first=entry.tarifa?.inicial!=null?entry.tarifa.inicial/100:Number(localStorage.getItem('valorHora')||0);
            const additional=entry.tarifa?.adicional!=null?entry.tarifa.adicional/100:Number(localStorage.getItem('valorHoraAdicional')||0);
            due=minutes===0?0:first+Math.ceil(Math.max(0,minutes-60)/60)*additional;
        }
        return { tempoFormatado, total:due||0, horaEntrada, horaSaida, tipo: 'diarista' };
    }
    return { tempoFormatado, total, horaEntrada, horaSaida, tipo: 'avulso' };
}

///////////////////////////
// split pagamento
///////////////////////////
const PAYMENT_OPTIONS = [
    { value: 'Dinheiro', label: '💵 Dinheiro' },
    { value: 'Cartão de Crédito', label: '💳 Cartão de Crédito' },
    { value: 'Cartão de Débito', label: '💳 Cartão de Débito' },
    { value: 'Pix', label: '📱 Pix' }
];

function buildFormaOptions(selectedValue = '') {
    const options = ['<option value="">Selecione...</option>'];
    PAYMENT_OPTIONS.forEach((opt) => {
        const selected = opt.value === selectedValue ? 'selected' : '';
        options.push(`<option value="${opt.value}" ${selected}>${opt.label}</option>`);
    });
    return options.join('');
}

function formatCurrency(value) {
    const num = Number(value || 0);
    return `R$ ${num.toFixed(2)}`;
}

function addSplitRow(listEl, { forma = '', valor = 0 } = {}) {
    const row = document.createElement('div');
    row.className = 'split-row';
    row.innerHTML = `
        <select class="split-forma">${buildFormaOptions(forma)}</select>
        <input type="number" class="split-valor" step="0.01" min="0" value="${Number(valor || 0).toFixed(2)}" />
        <button type="button" class="btn-ghost split-remove">✖</button>
    `;
    listEl.appendChild(row);
}

function getSplitPayments(listId) {
    const listEl = document.getElementById(listId);
    if (!listEl) return [];
    const rows = Array.from(listEl.querySelectorAll('.split-row'));
    return rows
        .map((row) => {
            const forma = row.querySelector('.split-forma')?.value;
            const valor = Number(row.querySelector('.split-valor')?.value || 0);
            return { forma_pagamento: forma, valor_pago: valor };
        })
        .filter((p) => p.forma_pagamento && p.valor_pago > 0);
}

function updateSplitSummary(listId, totalId, remainingId, totalValue) {
    const totalEl = document.getElementById(totalId);
    const remainingEl = document.getElementById(remainingId);
    const payments = getSplitPayments(listId);
    const sum = payments.reduce((acc, cur) => acc + cur.valor_pago, 0);
    const remaining = Math.max(0, Number(totalValue || 0) - sum);
    if (totalEl) totalEl.textContent = formatCurrency(totalValue);
    if (remainingEl) remainingEl.textContent = formatCurrency(remaining);
}

function resetSplitUI(listId, totalId, remainingId, totalValue) {
    const listEl = document.getElementById(listId);
    if (!listEl) return;
    listEl.innerHTML = '';
    addSplitRow(listEl, { valor: Number(totalValue || 0) });
    updateSplitSummary(listId, totalId, remainingId, totalValue);
}

function initSplitHandlers({ listId, totalId, remainingId, addBtnId, totalProvider }) {
    const listEl = document.getElementById(listId);
    const addBtn = document.getElementById(addBtnId);
    if (!listEl || !addBtn) return;

    const update = () => updateSplitSummary(listId, totalId, remainingId, totalProvider());

    addBtn.addEventListener('click', () => {
        const total = totalProvider();
        const existing = getSplitPayments(listId).reduce((acc, cur) => acc + cur.valor_pago, 0);
        const remaining = Math.max(0, Number(total || 0) - existing);
        addSplitRow(listEl, { valor: remaining });
        update();
    });

    listEl.addEventListener('click', (e) => {
        const target = e.target;
        if (target?.classList?.contains('split-remove')) {
            target.closest('.split-row')?.remove();
            update();
        }
    });

    listEl.addEventListener('input', update);
    listEl.addEventListener('change', update);

    update();
}

function validateSplitTotal(expectedTotal, payments) {
    const total = payments.reduce((acc, cur) => acc + cur.valor_pago, 0);
    return Math.abs(Number(expectedTotal || 0) - total) < 0.01;
}

function addMonthsToISODateFront(baseDateStr, months) {
    const safeBase = typeof baseDateStr === 'string' ? baseDateStr : '';
    const isValidIso = /^\d{4}-\d{2}-\d{2}$/.test(safeBase);
    let dt;
    if (isValidIso) {
        const [y, m, d] = safeBase.split('-').map(Number);
        dt = new Date(Date.UTC(y, m - 1, d));
    } else {
        const now = new Date();
        dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    const originalDay = dt.getUTCDate();
    dt.setUTCDate(1); dt.setUTCMonth(dt.getUTCMonth() + (Number(months) || 0));
    const lastDay = new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth()+1,0)).getUTCDate();
    dt.setUTCDate(Math.min(originalDay,lastDay));
    return dt.toISOString().slice(0, 10);
}

function formatBrDate(isoDate) {
    if (!isoDate) return '-';
    const [y, m, d] = String(isoDate).split('-');
    return `${d}/${m}/${y}`;
}

function formatDateTimeBr(value) {
    if (!value) return '-';
    const dt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(dt.getTime())) return '-';
    const date = dt.toLocaleDateString('pt-BR');
    const time = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
}

///////////////////////////
// backend consulta (via backend com API gratuita)
///////////////////////////
async function consultarPlacaAPI(placa) {
    return PlateService.lookupPlateAPI(placa);
}

///////////////////////////
// banco local (vehicleDB) para cachear resultados e evitar consultas repetidas
///////////////////////////
const VEHICLE_CACHE_TTL = 30 * 86400000;
function saveVehicleInfo(placa, marca, modelo, cor, origem = 'manual', updated = new Date().toISOString()) {
    if (!placa || (!marca && !modelo && !cor)) return;
    try {
        const db = JSON.parse(localStorage.getItem('vehicleDB') || '{}');
        db[normalizePlaca(placa)] = { marca, modelo, cor, origem, updated };
        localStorage.setItem('vehicleDB', JSON.stringify(db));
    } catch { /* Armazenamento local cheio não interrompe o atendimento. */ }
}
function getVehicleInfo(placa) {
    try {
        const data = JSON.parse(localStorage.getItem('vehicleDB') || '{}')[normalizePlaca(placa)];
        if (!data || !Number.isFinite(new Date(data.updated).getTime()) || Date.now() - new Date(data.updated).getTime() > VEHICLE_CACHE_TTL) return null;
        return data;
    } catch { return null; }
}

async function preencherMensalistaPorPlaca(placa) {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/mensalistas/${placa}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !data.dados) return;
        if (normalizePlaca(document.getElementById('placaEntrada').value) !== normalizePlaca(placa)
            || !document.getElementById('mensalistaCheck')?.checked) return;
        const mensalista = data.dados;
        document.getElementById('mensalistaNome').value = mensalista.nome || '';
        document.getElementById('mensalistaTelefone').value = mensalista.telefone || '';
        document.getElementById('mensalistaCpf').value = mensalista.cpf || '';
        if(['vencido','vence_hoje','a_vencer','sem_pagamento','suspenso','cancelado'].includes(mensalista.situacao))notify(`Mensalista: ${({vencido:'mensalidade vencida',vence_hoje:'vence hoje',a_vencer:'vence em até 2 dias',sem_pagamento:'sem quitação',suspenso:'contrato suspenso',cancelado:'contrato cancelado'})[mensalista.situacao]}. ${mensalista.vencimento?'Pago até '+mensalista.vencimento:''}`,'info',7000);
    } catch (err) {
        // sem mensalista cadastrado
    }
}

///////////////////////////
// debounce helper
///////////////////////////
function debounce(fn, wait = 450) {
    let t;
    const debounced = function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
    debounced.cancel = () => clearTimeout(t);
    return debounced;
}

///////////////////////////
// auto-fill (debounced)
///////////////////////////
let vehicleLookupController = null;
let vehicleLookupSequence = 0;
let vehicleFieldPlate = '';
function lookupStatus(message, state = 'info') {
    const el = document.getElementById('vehicleLookupStatus');
    if (el) { el.textContent = message; el.dataset.state = state; }
}
function cancelVehicleLookup() {
    vehicleLookupSequence++;
    vehicleLookupController?.abort();
    vehicleLookupController = null;
    autoFillVehicleDataAPI.cancel();
}
const autoFillVehicleDataAPI = debounce(async function(options = {}) {
    const input = document.getElementById('placaEntrada');
    const placa = normalizePlaca(input?.value || '');
    if (!isValidPlaca(placa)) { lookupStatus('Use ABC1234 ou ABC1D23.'); return; }
    cancelVehicleLookup();
    const sequence = vehicleLookupSequence;
    const controller = new AbortController();
    vehicleLookupController = controller;
    const initialValues = ['marcaEntrada', 'modeloEntrada', 'corEntrada'].map(id => document.getElementById(id).value);
    const local = options.refresh ? null : getVehicleInfo(placa);
    lookupStatus('Consultando marca, modelo e cor…', 'loading');
    try {
        const info = local ? { ...local, encontrado: true, origem: 'local' }
            : await PlateService.lookupPlateAPI(placa, { signal: controller.signal });
        if (controller.signal.aborted || sequence !== vehicleLookupSequence || normalizePlaca(input.value) !== placa) return;
        if (info?.encontrado) {
            ['marca', 'modelo', 'cor'].forEach((key, index) => {
                const field = document.getElementById(['marcaEntrada', 'modeloEntrada', 'corEntrada'][index]);
                if (field.value === initialValues[index] && info[key]) field.value = info[key];
            });
            const complete = Boolean(info.marca && info.modelo && info.cor);
            const source = info.origem === 'api' ? 'Dados consultados na API.' : 'Dados recuperados do cadastro salvo.';
            const remaining = info.cota?.restante;
            lookupStatus(source + (complete ? ' Confira antes de registrar.' : ' Complete os campos que faltam.')
                + (Number.isFinite(remaining) ? ' Cota restante: ' + remaining + '.' : ''), complete ? 'success' : 'warning');
            saveVehicleInfo(placa, info.marca, info.modelo, info.cor, info.fornecedor || info.origem, info.atualizadoEm || info.updated || new Date().toISOString());
        } else {
            lookupStatus(info?.mensagem || 'Cadastro não encontrado. Preencha os dados manualmente.', 'warning');
        }
    } catch (error) {
        if (error.name !== 'AbortError') lookupStatus('Não foi possível consultar. Preencha os dados manualmente.', 'warning');
    } finally {
        if (vehicleLookupController === controller) vehicleLookupController = null;
    }
}, 550);
function handlePlateInput() {
    cancelVehicleLookup();
    const input = document.getElementById('placaEntrada');
    const placa = normalizePlaca(input.value);
    input.value = placa;
    if (vehicleFieldPlate !== placa) {
        ['marcaEntrada', 'modeloEntrada', 'corEntrada'].forEach(id => { document.getElementById(id).value = ''; });
        ['mensalistaNome', 'mensalistaTelefone', 'mensalistaCpf'].forEach(id => { document.getElementById(id).value = ''; });
        vehicleFieldPlate = placa;
    }
    autoFillVehicleDataAPI();
}

const autoFillMensalistaData = debounce(async function() {
    const mensalistaCheck = document.getElementById('mensalistaCheck');
    if (!mensalistaCheck?.checked) return;
    const placaIn = document.getElementById('placaEntrada');
    if (!placaIn) return;
    const placa = normalizePlaca(placaIn.value || '');
    if (placa.length < 7 || !isValidPlaca(placa)) return;
    await preencherMensalistaPorPlaca(placa);
}, 600);

///////////////////////////
// captura de placa via câmera
///////////////////////////
function iniciarScanPlaca() { return PlateCamera.open(); }
function capturarPlacaDaCamera() { return PlateCamera.capture(); }
function fecharCameraEntrada() { return PlateCamera.close(); }

///////////////////////////
// QR Code saída (câmera e leitor USB)
///////////////////////////
async function iniciarScanQrSaida() {
    const container = document.getElementById('qrCameraContainer');
    const statusEl = document.getElementById('qrCameraStatus');
    const videoEl = document.getElementById('qrCameraPreview');
    const canvasEl = document.getElementById('qrCameraCanvas');
    if (!container || !videoEl) return;

    container.setAttribute('aria-hidden', 'false');
    statusEl.textContent = 'Abrindo câmera...';
    try {
        await QrReaderService.start(videoEl, canvasEl, tratarQrCodeSaida);
        statusEl.textContent = 'Aponte o QR Code para a câmera.';
    } catch (err) {
        statusEl.textContent = 'Não foi possível iniciar a leitura.';
        alert('Não foi possível iniciar a câmera: ' + err.message);
        fecharCameraSaida();
    }
}

function fecharCameraSaida() {
    const container = document.getElementById('qrCameraContainer');
    const videoEl = document.getElementById('qrCameraPreview');
    if (container) container.setAttribute('aria-hidden', 'true');
    QrReaderService.stop(videoEl);
}

async function tratarQrCodeSaida(payload) {
    let entryId = payload;
    let plateFromPayload = '';
    try {
        const parsed = JSON.parse(payload);
        entryId = parsed.entryId || parsed.id || parsed.entry_id || payload;
        plateFromPayload = parsed.placa || parsed.plate || '';
    } catch (e) {
        // payload não é JSON, usa texto puro
    }

    let entry = StorageService.getEntryById(entryId) || StorageService.getEntryByPlate(plateFromPayload);
    if (!entry) {
        entry = await fetchActiveEntryFromBackend({ entryId, placa: plateFromPayload });
    }
    if (!entry) {
        alert('QR Code não corresponde a uma entrada ativa.');
        return;
    }

    document.getElementById('placaSaida').value = entry.placa;
    fecharCameraSaida();
    prepararPagamento(entry);
}

///////////////////////////
// UI bindings
///////////////////////////
function bindUI() {
    document.getElementById('btnEntrada').onclick = () => openPopup('entradaPopup');
    document.getElementById('btnSaida').onclick = () => openPopup('saidaPopup');
    document.getElementById('btnHistorico').onclick = () => {
        openPopup('historicoPopup');
        if(AuthService.user?.perfil==='operador')carregarHistoricoCompleto();else carregarRelatorioResumo();
    };
    document.getElementById('btnMenu').onclick = () => toggleMenu(true);
    document.getElementById('btnMensalistas').onclick = () => {
        openPopup('mensalistasPopup');
        carregarMensalistas();
    };
    document.getElementById('btnAuth').onclick = handleAuthClick;
    document.getElementById('restoreForm').addEventListener('submit',confirmarRestore);
    document.body.addEventListener('click',event=>{const button=event.target.closest('[data-operation-receipt]');if(button)abrirComprovanteOperacao(button.dataset.operationReceipt);});

    document.getElementById('registrarBtn').onclick = registrarEntrada;
    document.getElementById('calcularBtn').onclick = calcularPermanencia;
    document.getElementById('saveConfigBtn').onclick = saveConfig;
    document.getElementById('btnBackupExport')?.addEventListener('click', exportarBackup);
    document.getElementById('btnBackupImport')?.addEventListener('click', () => document.getElementById('backupFileInput').click());
    document.getElementById('backupFileInput')?.addEventListener('change', importarBackup);

    document.getElementById('scanPlacaBtn')?.addEventListener('click', iniciarScanPlaca);
    document.getElementById('capturarPlacaBtn')?.addEventListener('click', capturarPlacaDaCamera);
    document.getElementById('fecharCameraEntradaBtn')?.addEventListener('click', fecharCameraEntrada);

    document.getElementById('scanQrSaidaBtn')?.addEventListener('click', iniciarScanQrSaida);
    document.getElementById('fecharQrCameraBtn')?.addEventListener('click', fecharCameraSaida);

    QrReaderService.bindKeyboardInput(document.getElementById('qrSaidaInput'), tratarQrCodeSaida);


    document.getElementById('btnRelatorioResumo')?.addEventListener('click', carregarRelatorioResumo);
    document.getElementById('btnHistoricoCompleto')?.addEventListener('click', carregarHistoricoCompleto);
    document.getElementById('btnBuscaPlaca')?.addEventListener('click', buscarPorPlaca);
    document.getElementById('btnAplicarFiltro')?.addEventListener('click', aplicarFiltroData);
    document.getElementById('btnLimparFiltro')?.addEventListener('click', limparFiltro);
    
    // Caixa
    document.getElementById('toggleCaixaBtn')?.addEventListener('click', toggleCaixaValores);
    document.getElementById('btnRelatoriosCaixa')?.addEventListener('click', () => openPopup('relatoriosCaixaPopup'));
    document.getElementById('btnHistoricoFechamentos')?.addEventListener('click', abrirHistoricoFechamentos);
    document.getElementById('btnFecharCaixa')?.addEventListener('click', abrirFechamentoCaixa);
    document.getElementById('btnGerarRelatorioCaixa')?.addEventListener('click', gerarRelatorioCaixa);
    document.getElementById('confirmarPagamentoBtn')?.addEventListener('click', confirmarPagamento);
    document.getElementById('confirmarMensalidadeBtn')?.addEventListener('click', confirmarPagamentoMensalidade);
    document.getElementById('renovarAntesSaida').addEventListener('click',()=>{
        const pending=window.saidaMensalistaPendente;if(!pending?.dados.mensalista_id)return;
        closePopup('mensalistaVencidoPopup');SubscriptionService.openPayment({id:pending.dados.mensalista_id,nome:pending.dados.nome,placa:pending.entry.placa});
    });
    document.getElementById('saidaSemRenovar').addEventListener('click',()=>{const pending=window.saidaMensalistaPendente;if(!pending)return;window.saidaMensalistaPendente=null;closePopup('mensalistaVencidoPopup');prepararPagamento(pending.entry,{continuarAvulso:true});});
    document.getElementById('continuarSaidaMensalista').addEventListener('click',()=>{const pending=window.saidaMensalistaPendente;if(!pending)return;window.saidaMensalistaPendente=null;document.getElementById('continuarSaidaMensalista').hidden=true;closePopup('comprovanteMensalidadePopup');prepararPagamento(pending.entry);});
    document.getElementById('confirmarFechamentoBtn')?.addEventListener('click', confirmarFechamentoCaixa);
    document.getElementById('cancelarFechamentoBtn')?.addEventListener('click', () => closePopup('fechamentoCaixaPopup'));
    document.getElementById('btnBuscarFechamentos')?.addEventListener('click', carregarHistoricoFechamentos);
    document.getElementById('btnTurnoCaixa')?.addEventListener('click', abrirTurnoCaixa);
    document.getElementById('confirmarAberturaTurnoBtn')?.addEventListener('click', confirmarAberturaTurno);
    document.getElementById('confirmarFechamentoTurnoBtn')?.addEventListener('click', confirmarFechamentoTurno);

    initSplitHandlers({
        listId: 'splitPagamentoLista',
        totalId: 'splitPagamentoTotal',
        remainingId: 'splitPagamentoRestante',
        addBtnId: 'addSplitPagamento',
        totalProvider: () => Number(window.dadosPagamento?.valor || 0)
    });

    initSplitHandlers({
        listId: 'splitMensalidadeLista',
        totalId: 'splitMensalidadeTotal',
        remainingId: 'splitMensalidadeRestante',
        addBtnId: 'addSplitMensalidade',
        totalProvider: () => getMensalidadeTotal()
    });

    document.getElementById('btnBuscarMensalistas')?.addEventListener('click', carregarMensalistas);
    document.getElementById('btnNovoMensalista')?.addEventListener('click', limparFormMensalista);
    document.getElementById('btnSalvarMensalista')?.addEventListener('click', salvarMensalista);
    document.getElementById('btnLimparMensalista')?.addEventListener('click', limparFormMensalista);

    document.getElementById('mensalidadeMeses')?.addEventListener('input', atualizarResumoMensalidade);
    document.getElementById('mensalidadeValor')?.addEventListener('input', atualizarResumoMensalidade);

    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => closePopupByElement(e.target.closest('.popup'))));

    // input placa => autoFill
    document.getElementById('placaEntrada').addEventListener('input', handlePlateInput);
    document.getElementById('refreshPlateBtn').addEventListener('click', () => autoFillVehicleDataAPI({ refresh: true }));
    PlateCamera.bind();
    document.getElementById('placaEntrada').addEventListener('input', autoFillMensalistaData);

    const mensalistaCheck = document.getElementById('mensalistaCheck');
    const diaristaCheck = document.getElementById('diaristaCheck');
    const mensalistaFields = document.getElementById('mensalistaFields');

    const syncMensalistaUI = () => {
        if (mensalistaCheck?.checked) {
            if (diaristaCheck) diaristaCheck.checked = false;
            const placa = normalizePlaca(document.getElementById('placaEntrada').value || '');
            if (placa) preencherMensalistaPorPlaca(placa);
        }
        if (mensalistaFields) {
            mensalistaFields.setAttribute('aria-hidden', mensalistaCheck?.checked ? 'false' : 'true');
        }
        if (!mensalistaCheck?.checked) {
            document.getElementById('mensalistaNome').value = '';
            document.getElementById('mensalistaTelefone').value = '';
            document.getElementById('mensalistaCpf').value = '';
        }
        document.getElementById('diaristaFields').hidden=!diaristaCheck?.checked;
    };

    const syncDiaristaUI = () => {
        if (diaristaCheck?.checked) {
            if (mensalistaCheck) mensalistaCheck.checked = false;
        }
        if (mensalistaFields) {
            mensalistaFields.setAttribute('aria-hidden', mensalistaCheck?.checked ? 'false' : 'true');
        }
        if (!mensalistaCheck?.checked) {
            document.getElementById('mensalistaNome').value = '';
            document.getElementById('mensalistaTelefone').value = '';
            document.getElementById('mensalistaCpf').value = '';
        }
        document.getElementById('diaristaFields').hidden=!diaristaCheck?.checked;
    };

    mensalistaCheck?.addEventListener('change', syncMensalistaUI);
    diaristaCheck?.addEventListener('change', syncDiaristaUI);

    // Delegação de eventos para botões de saída nos cards (criados dinamicamente)
    document.getElementById('patioCarList').addEventListener('click', async (e) => {
        const saidaBtn = e.target.closest('.btn-saida-card');
        const printBtn = e.target.closest('.btn-print-card');
        const cancelBtn = e.target.closest('.btn-cancel-card');

        if (saidaBtn) {
            const entryId = saidaBtn.dataset.entryId;
            registrarSaidaPeloCard(entryId);
            return;
        }

        if (printBtn) {
            const entryId = printBtn.dataset.entryId;
            const entry = StorageService.getEntryById(entryId);
            if (!entry) return alert('Entrada não encontrada.');
            await renderComprovanteEntrada(entry);
            openPopup('comprovanteEntradaPopup');
            return;
        }

        if (cancelBtn) {
            const entryId = cancelBtn.dataset.entryId;
            if (!entryId) return alert('ID da entrada não informado.');
            const confirmCancel = window.confirm('Confirma cancelar esta entrada?\n\nA ação NÃO gerará cobrança.');
            if (!confirmCancel) return;
            const motivo = window.prompt('Motivo do cancelamento (10 a 255 caracteres):', '');
            if (!motivo || motivo.trim().length < 10) return notify('Informe um motivo de ao menos 10 caracteres.','error');
            const ok = await cancelEntry({
                entryId,
                motivo: motivo.trim()
            });
            if (ok) {
                closePopup('cancelEntryPopup');
            }
        }
    });

    document.querySelectorAll('.popup').forEach(p => p.addEventListener('click', e => { if (e.target === p) closePopupByElement(p); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('.popup[aria-hidden="false"]').forEach(p => closePopupByElement(p)); toggleMenu(false); }});

    // Cancel entry modal handlers
    document.getElementById('confirmCancelEntryBtn')?.addEventListener('click', async () => {
        const entryId = document.getElementById('cancelEntryId')?.value;
        const motivo = document.getElementById('cancelReason')?.value?.trim() || '';
        const ok = await cancelEntry({ entryId, motivo: motivo || 'Cancelamento solicitado pelo usuário' });
        if (ok) closePopup('cancelEntryPopup');
    });
    document.getElementById('cancelCancelEntryBtn')?.addEventListener('click', () => closePopup('cancelEntryPopup'));

    // Fallback extra: bloqueia a ocultação de popup enquanto um campo dentro dele está focado
    document.querySelectorAll('.popup').forEach((p) => {
        p.addEventListener('transitionend', () => {
            const active = document.activeElement;
            if (active && p.contains(active) && p.getAttribute('aria-hidden') === 'true') {
                active.blur();
            }
        });
    });
}

function openCancelEntryModal(entryId) {
    const idInput = document.getElementById('cancelEntryId');
    const reasonEl = document.getElementById('cancelReason');
    if (idInput) idInput.value = entryId || '';
    if (reasonEl) reasonEl.value = '';
    openPopup('cancelEntryPopup');
    setTimeout(() => { try { document.getElementById('cancelReason')?.focus(); } catch (e) {} }, 100);
}

///////////////////////////
// popups
///////////////////////////
function openPopup(id) { const el = document.getElementById(id); if (el) el.setAttribute('aria-hidden','false'); }
function closePopup(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const active = document.activeElement;
    if (active && el.contains(active)) active.blur();
    el.setAttribute('aria-hidden','true');
    if (id === 'entradaPopup') { cancelVehicleLookup(); fecharCameraEntrada(); }
    if (id === 'saidaPopup') fecharCameraSaida();
}
function closePopupByElement(el) {
    if (!el) return;
    const active = document.activeElement;
    if (active && el.contains(active)) active.blur();
    el.setAttribute('aria-hidden','true');
    if (el.id === 'entradaPopup') { cancelVehicleLookup(); fecharCameraEntrada(); }
    if (el.id === 'saidaPopup') fecharCameraSaida();
}
function toggleMenu(show) { const el = document.getElementById('menu'); if (!el) return; el.setAttribute('aria-hidden', show ? 'false' : 'true'); }

function updateAuthButton() { window.AuthService?.applyPermissions(); }
function handleAuthClick() { return AuthService.access(); }

function mapBackendEntryToLocal(row) {
    const dateIso = row.data_entrada_iso || '';
    const timeIso = row.hora_entrada_iso || '00:00:00';
    const horaEntradaMs = row.hora_entrada_ms ? Number(row.hora_entrada_ms) : null;
    const horaEntrada = dateIso ? `${dateIso}T${timeIso}` : new Date().toISOString();
    const horaEntradaDate = horaEntradaMs ? new Date(horaEntradaMs) : (parseEntradaDate(horaEntrada) || new Date());
    return {
        entryId: row.entry_id,
        placa: row.placa,
        marca: row.marca || '',
        modelo: row.modelo || '',
        cor: row.cor || '',
        horaEntrada,
        horaEntradaMs: horaEntradaDate.getTime(),
        mensalista: !!row.mensalista,
        diarista: !!row.diarista,
        diaria_retirada_em: row.diaria_retirada_em,
        diaria_valor_pago: row.diaria_valor_pago,
        tarifa: row.tarifa,
        cliente_nome: row.cliente_nome || '',
        cliente_telefone: row.cliente_telefone || '',
        cliente_cpf: row.cliente_cpf || ''
    };
}

async function syncActiveEntriesFromBackend() {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/patio/ativos`);
        if (!res.ok) {
            setConnectionStatus(res.status === 401 ? 'Acesso necessário' : 'Servidor indisponível', 'offline');
            return false;
        }
        const data = await res.json();
        if (!data.success || !Array.isArray(data.dados)) return false;
        const entries = data.dados.map(mapBackendEntryToLocal);
        StorageService.replaceEntries(entries);
        setConnectionStatus('Sincronizado', 'online');
        AuthService.applyPermissions();
        return true;
    } catch (err) {
        setConnectionStatus('Sem conexão', 'offline');
        console.warn('[front] falha ao sincronizar pátio:', err.message);
        return false;
    }
}

function setConnectionStatus(message, state) {
    const el = document.getElementById('connectionStatus');
    if (el) { el.textContent = message; el.dataset.state = state; }
}

async function fetchActiveEntryFromBackend({ entryId, placa }) {
    const params = new URLSearchParams();
    if (entryId) params.append('entryId', entryId);
    if (placa) params.append('placa', placa);
    if (!params.toString()) return null;

    try {
        const res = await apiFetch(`${BACKEND_BASE}/patio/ativo?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.success || !data.dados) return null;
        const entry = mapBackendEntryToLocal(data.dados);
        StorageService.upsertEntry(entry);
        return entry;
    } catch (err) {
        return null;
    }
}

///////////////////////////
// config
///////////////////////////
async function loadConfig() {
    try {
        // Carrega do banco de dados
        const res = await apiFetch(`${BACKEND_BASE}/configuracoes`);
        if (!res.ok) throw new Error('Erro ao carregar configurações');
        
        const data = await res.json();
        if (data.success && data.dados) {
            const configs = data.dados;
            for (const [key,id] of [['nome_estacionamento','nomeEstacionamento'],['documento_estacionamento','documentoEstacionamento'],['endereco_estacionamento','enderecoEstacionamento'],['telefone_estacionamento','telefoneEstacionamento']]) document.getElementById(id).value = configs[key]?.valor || '';
            
            // Atualiza campos do formulário
            if (configs.valor_hora_inicial) {
                document.getElementById('valorHora').value = configs.valor_hora_inicial.valor;
                localStorage.setItem('valorHora', configs.valor_hora_inicial.valor);
            }
            if (configs.valor_hora_adicional) {
                document.getElementById('valorHoraAdicional').value = configs.valor_hora_adicional.valor;
                localStorage.setItem('valorHoraAdicional', configs.valor_hora_adicional.valor);
            }
            if (configs.tempo_tolerancia) {
                document.getElementById('toleranciaHoraAdicional').value = configs.tempo_tolerancia.valor;
                localStorage.setItem('toleranciaHoraAdicional', configs.tempo_tolerancia.valor);
            }
            if (configs.total_vagas) {
                document.getElementById('totalVagasConfig').value = configs.total_vagas.valor;
                localStorage.setItem('totalVagas', configs.total_vagas.valor);
            }
            if (configs.valor_mensalidade) {
                document.getElementById('valorMensalidade').value = configs.valor_mensalidade.valor;
                localStorage.setItem('valorMensalidade', configs.valor_mensalidade.valor);
            }
            if (configs.valor_diaria) {
                document.getElementById('valorDiaria').value = configs.valor_diaria.valor;
                localStorage.setItem('valorDiaria', configs.valor_diaria.valor);
            }
            
            console.log('[front] Configurações carregadas do banco de dados');
        }
    } catch (err) {
        console.error('[front] Erro ao carregar configurações, usando localStorage:', err);
        // Fallback para localStorage
        const v1 = localStorage.getItem('valorHora') || '5.00';
        const v2 = localStorage.getItem('valorHoraAdicional') || '2.50';
        const tol = localStorage.getItem('toleranciaHoraAdicional') || '15';
        const vagas = localStorage.getItem('totalVagas') || '50';
        const mensal = localStorage.getItem('valorMensalidade') || '300.00';
        const diaria = localStorage.getItem('valorDiaria') || '25.00';
        
        document.getElementById('valorHora').value = v1;
        document.getElementById('valorHoraAdicional').value = v2;
        document.getElementById('toleranciaHoraAdicional').value = tol;
        document.getElementById('totalVagasConfig').value = vagas;
        document.getElementById('valorMensalidade').value = mensal;
        document.getElementById('valorDiaria').value = diaria;
        localStorage.setItem('valorMensalidade', mensal);
        localStorage.setItem('valorDiaria', diaria);
    }
}

async function saveConfig() {
    const v1 = document.getElementById('valorHora').value;
    const v2 = document.getElementById('valorHoraAdicional').value;
    const tol = document.getElementById('toleranciaHoraAdicional').value;
    const vagas = document.getElementById('totalVagasConfig').value;
    const mensal = document.getElementById('valorMensalidade').value;
    const diaria = document.getElementById('valorDiaria').value;
    
    if (!v1 || !v2 || !tol || !vagas || !mensal || !diaria) return alert('Preencha todos os campos.');
    
    try {
        // Salva no banco de dados
        const res = await apiFetch(`${BACKEND_BASE}/configuracoes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nome_estacionamento:document.getElementById('nomeEstacionamento').value.trim(),
                documento_estacionamento:document.getElementById('documentoEstacionamento').value.trim(),
                endereco_estacionamento:document.getElementById('enderecoEstacionamento').value.trim(),
                telefone_estacionamento:document.getElementById('telefoneEstacionamento').value.trim(),
                valor_hora_inicial: v1,
                valor_hora_adicional: v2,
                tempo_tolerancia: tol,
                total_vagas: vagas,
                valor_mensalidade: mensal,
                valor_diaria: diaria
            })
        });
        
        const data = await res.json();
        
        if (!data.success) {
            throw new Error(data.mensagem || 'Erro ao salvar configurações');
        }
        
        // Atualiza localStorage para cache
        localStorage.setItem('valorHora', v1);
        localStorage.setItem('valorHoraAdicional', v2);
        localStorage.setItem('toleranciaHoraAdicional', tol);
        localStorage.setItem('totalVagas', vagas);
        localStorage.setItem('valorMensalidade', mensal);
        localStorage.setItem('valorDiaria', diaria);
        
        alert('Configurações salvas com sucesso no banco de dados!');
        console.log('[front] Configurações salvas:', data);
        toggleMenu(false);
        
        // Atualiza lista do pátio e dashboard para refletir novos valores
        updatePatioCarList();
        carregarDashboard();
        
    } catch (err) {
        console.error('[front] Erro ao salvar configurações:', err);
        alert('Erro ao salvar configurações: ' + err.message);
    }
}

///////////////////////////
// normalize
///////////////////////////
function normalizePlaca(p) {
    if (!p) return '';
    return String(p).replace(/[^A-Za-z0-9]/g,'').toUpperCase();
}

function isValidPlaca(p) {
    if (!p) return false;
    const plate = normalizePlaca(p);
    const antiga = /^[A-Z]{3}[0-9]{4}$/; // AAA1234
    const mercosul = /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/; // AAA1A23
    return antiga.test(plate) || mercosul.test(plate);
}

function clearEntradaForm() {
    cancelVehicleLookup();
    vehicleFieldPlate = '';
    lookupStatus('Digite a placa ou use a câmera para preencher o cadastro.');
    document.getElementById('placaEntrada').value = '';
    document.getElementById('marcaEntrada').value = '';
    document.getElementById('modeloEntrada').value = '';
    document.getElementById('corEntrada').value = '';
    document.getElementById('mensalistaCheck').checked = false;
    document.getElementById('diaristaCheck').checked = false;
    document.getElementById('diariaRetirada').value = '';
    document.getElementById('diaristaFields').hidden = true;
    document.getElementById('mensalistaNome').value = '';
    document.getElementById('mensalistaTelefone').value = '';
    document.getElementById('mensalistaCpf').value = '';
    document.getElementById('mensalistaFields').setAttribute('aria-hidden', 'true');
}

///////////////////////////
// registrar entrada
///////////////////////////
let entradaBusy = false;
async function registrarEntrada() {
    if (entradaBusy) return;
    const placa = normalizePlaca(document.getElementById('placaEntrada').value);
    if (!isValidPlaca(placa)) return notify('Informe uma placa válida.','error');
    entradaBusy = true; document.getElementById('registrarBtn').disabled = true;
    try {
        const body = { placa,marca:document.getElementById('marcaEntrada').value.trim(),modelo:document.getElementById('modeloEntrada').value.trim(),cor:document.getElementById('corEntrada').value.trim(),mensalista:document.getElementById('mensalistaCheck').checked,diarista:document.getElementById('diaristaCheck').checked };
        if(body.diarista){
            body.retirada_em=document.getElementById('diariaRetirada').value;
            if(!body.retirada_em)throw Error('Informe a data e o horário limite para retirada da diária.');
            const shift=await CashService.requireOwnShift();
            const {dados}=await operationRequest('/entrada/diaria/cotacao',{retirada_em:body.retirada_em});
            window.dadosPagamento={modo:'diaria',entrada:{...body,retirada_em:dados.retirada_em},turno_id:shift.id,operacao_id:crypto.randomUUID(),valor:dados.valor};
            document.getElementById('resumoPagamento').innerHTML=`<h4>Diária antecipada</h4><p>Placa: <strong>${escapeHtml(placa)}</strong></p><p>Retirar até: <strong>${escapeHtml(new Date(dados.retirada_em).toLocaleString('pt-BR',{timeZone:dados.fuso}))}</strong></p><p class="valor-total">Pagar agora: ${formatCurrency(dados.valor)}</p><p class="help-text">Após o horário combinado, o atraso será cobrado pela tarifa avulsa. A entrada é registrada ao confirmar o pagamento.</p>`;
            resetSplitUI('splitPagamentoLista','splitPagamentoTotal','splitPagamentoRestante',dados.valor);
            closePopup('entradaPopup');openPopup('pagamentoPopup');return;
        }
        const data = await operationRequest('/entrada',body);
        await concluirEntrada(body,data);
    } catch (error) { notify(error.message,'error',6000); }
    finally { entradaBusy = false; document.getElementById('registrarBtn').disabled = false; }
}

async function concluirEntrada(body,data){
    const entrada={...body,entryId:data.entry_id,horaEntrada:data.criado_em,horaEntradaMs:new Date(data.criado_em).getTime(),comprovante:data.comprovante,diaria_retirada_em:data.comprovante.diaria_retirada_em,diaria_valor_pago:data.comprovante.diaria_valor_pago,tarifa:data.comprovante.tarifa};
    StorageService.saveEntry(entrada);saveVehicleInfo(body.placa,body.marca,body.modelo,body.cor);
    updatePatioCarList();await carregarDashboard();await CashService.refresh();clearEntradaForm();fecharCameraEntrada();closePopup('entradaPopup');closePopup('pagamentoPopup');
    await renderComprovanteEntrada(entrada);openPopup('comprovanteEntradaPopup');
}

async function processarEntradaDiaria(pagamentos){
    const dados=window.dadosPagamento;if(dados?.modo!=='diaria'||entradaBusy)return;
    entradaBusy=true;document.getElementById('confirmarPagamentoBtn').disabled=true;
    try{
        const body={...dados.entrada,turno_id:dados.turno_id,operacao_id:dados.operacao_id,pagamentos};
        const data=await operationRequest('/entrada',body);
        await concluirEntrada(body,data);window.dadosPagamento=null;
    }catch(error){notify(error.message+' Se a conexão caiu, confirme novamente a mesma operação.','error',8000);}
    finally{entradaBusy=false;document.getElementById('confirmarPagamentoBtn').disabled=false;}
}

async function prepararPagamento(entry,{continuarAvulso=false}={}) {
    if (!entry) return notify('Entrada não localizada.','error');
    try {
        const shift = await CashService.requireOwnShift();
        const { dados } = await operationRequest('/saida/cotacao',{ entryId:entry.entryId,placa:entry.placa,continuar_avulso:continuarAvulso });
        if(dados.mensalista_vencido&&!dados.cotacao_id){
            window.saidaMensalistaPendente={entry,dados};window.dadosPagamento=null;document.getElementById('mensalistaVencidoResumo').textContent=`${dados.nome||entry.placa} · ${dados.pago_ate?'Pago até '+dados.pago_ate:'Validade anterior não disponível'}`;
            document.getElementById('renovarAntesSaida').disabled=!dados.mensalista_id;closePopup('saidaPopup');openPopup('mensalistaVencidoPopup');return;
        }
        window.dadosPagamento = { ...dados,turno_id:shift.id,entryId:dados.entry_id,valor:dados.valor,tempo:dados.tempo,horaEntrada:new Date(dados.entrada_em),horaSaida:new Date(dados.saida_em) };
        document.getElementById('resumoPagamento').innerHTML = `<h4>Resumo da permanência</h4><p>Placa: <strong>${escapeHtml(dados.placa)}</strong></p><p>Entrada: ${escapeHtml(new Date(dados.entrada_em).toLocaleString('pt-BR'))}</p><p>Permanência: ${escapeHtml(dados.tempo)}</p><p>Tipo: ${escapeHtml(dados.tipo)}</p>${dados.diaria_retirada_em?`<p>Diária já paga: ${formatCurrency(dados.diaria_valor_pago)}</p><p>Retirada combinada: ${escapeHtml(new Date(dados.diaria_retirada_em).toLocaleString('pt-BR',{timeZone:dados.fuso}))}</p><p>Atraso: ${escapeHtml(dados.atraso_minutos)} min</p>`:''}<p class="valor-total">${dados.diaria_retirada_em?'Atraso a pagar':'Total'}: ${formatCurrency(dados.valor)}</p><p class="help-text">Valor confirmado pelo servidor. Cotação válida por 2 minutos.</p>`;
        closePopup('saidaPopup');
        if (dados.valor > 0) { resetSplitUI('splitPagamentoLista','splitPagamentoTotal','splitPagamentoRestante',dados.valor); openPopup('pagamentoPopup'); }
        else await processarSaida([]);
    } catch (error) { notify(error.message,'error',6000); }
}



async function calcularPermanencia() {
    const placa = normalizePlaca(document.getElementById('placaSaida').value);
    if (!placa) return alert('Informe a placa.');
    if (!isValidPlaca(placa)) return alert('Placa inválida. Use formato AAA1234 ou AAA1A23.');
    let entrada = StorageService.getEntryByPlate(placa);
    if (!entrada) {
        entrada = await fetchActiveEntryFromBackend({ placa });
    }
    if (!entrada) return alert('Veículo não encontrado.');
    prepararPagamento(entrada);
}

///////////////////////////
// confirmar pagamento
///////////////////////////
function confirmarPagamento() {
    const total = Number(window.dadosPagamento?.valor || 0);
    const pagamentos = getSplitPayments('splitPagamentoLista');

    if (pagamentos.length === 0) {
        alert('Selecione a forma de pagamento');
        return;
    }

    if (!validateSplitTotal(total, pagamentos)) {
        alert('A soma das formas de pagamento precisa fechar o total');
        return;
    }

    if(window.dadosPagamento?.modo==='diaria')processarEntradaDiaria(pagamentos);
    else processarSaida(pagamentos);
}

///////////////////////////
// processar saída (após pagamento)
///////////////////////////
let saidaBusy = false;
async function processarSaida(pagamentos = []) {
    const dados = window.dadosPagamento;
    if (!dados || saidaBusy) return;
    saidaBusy = true; document.getElementById('confirmarPagamentoBtn').disabled = true;
    try {
        const data = await operationRequest('/saida',{ cotacao_id:dados.cotacao_id,operacao_id:dados.operacao_id,turno_id:dados.turno_id,pagamentos });
        StorageService.removeEntry(data.entry_id);
        await ReceiptService.render('comprovantePermanencia',data.comprovante);
        closePopup('pagamentoPopup'); openPopup('comprovantePermanenciaPopup');
        document.getElementById('placaSaida').value = '';
        updatePatioCarList(); await carregarDashboard();
        await CashService.refresh();
        window.dadosPagamento = null;
    } catch (error) { notify(error.message + ' Se a conexão caiu, tente confirmar novamente a mesma operação.','error',8000); }
    finally { saidaBusy = false; document.getElementById('confirmarPagamentoBtn').disabled = false; }
}



function registrarSaidaPeloCard(entryId) {
    const entrada = StorageService.getEntryById(entryId);
    if (!entrada) {
        alert('Veículo não encontrado no cache local.');
        return;
    }
    prepararPagamento(entrada);
}

///////////////////////////
// cancelar entrada (sem cobrança)
///////////////////////////
async function cancelEntry({ entryId, placa, motivo } = {}) {
    if (!entryId && !placa) return alert('Informe entryId ou placa para cancelar a entrada.');
    try {
        const res = await apiFetch(`${BACKEND_BASE}/patio/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entryId, placa, motivo })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            alert('Erro ao cancelar entrada: ' + (data.error || data.mensagem || 'Desconhecido'));
            return false;
        }

        const idToRemove = entryId || data.entry_id;
        if (idToRemove) StorageService.removeEntry(idToRemove);
        else if (placa) {
            const e = StorageService.getEntryByPlate(placa);
            if (e) StorageService.removeEntry(e.entryId);
        }

        updatePatioCarList();
        try { carregarDashboard(); } catch (e) {}
        try { carregarDashboardCaixa(); } catch (e) {}

        alert('Entrada cancelada com sucesso. Não houve cobrança.');
        return true;
    } catch (err) {
        console.error('[front] erro ao cancelar entrada:', err);
        alert('Erro ao cancelar entrada no servidor');
        return false;
    }
}

// helpers para console/uso rápido
window.cancelEntryByPlate = async function(placa) {
    if (!placa) return alert('Informe a placa.');
    if (!confirm(`Confirma cancelar a entrada da placa ${placa}? Esta ação NÃO gerará cobrança.`)) return;
    await cancelEntry({ placa: normalizePlaca(placa) });
};

window.cancelEntryById = async function(entryId) {
    if (!entryId) return alert('Informe entryId.');
    if (!confirm(`Confirma cancelar a entrada id ${entryId}? Esta ação NÃO gerará cobrança.`)) return;
    await cancelEntry({ entryId });
};

///////////////////////////
// dashboard vagas
///////////////////////////
async function carregarDashboard() {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/dashboard`);
        if (!res.ok) throw new Error('Erro ao carregar dashboard');
        
        const data = await res.json();
        if (data.success && data.dados) {
            const { total_vagas, vagas_ocupadas, vagas_disponiveis, percentual_ocupacao } = data.dados;
            
            document.getElementById('totalVagas').textContent = total_vagas;
            document.getElementById('vagasOcupadas').textContent = vagas_ocupadas;
            document.getElementById('vagasDisponiveis').textContent = vagas_disponiveis;
            document.getElementById('percentualOcupacao').textContent = `${percentual_ocupacao}%`;
        }
    } catch (err) {
        console.error('[front] Erro ao carregar dashboard:', err);
        document.getElementById('totalVagas').textContent = '--';
        document.getElementById('vagasOcupadas').textContent = '--';
        document.getElementById('vagasDisponiveis').textContent = '--';
        document.getElementById('percentualOcupacao').textContent = '--';
    }
}

///////////////////////////
// update list
///////////////////////////
function updatePatioCarList() {
    const patio = document.getElementById('patioCarList');
    if (!patio) return;
    patio.innerHTML = '';
    const entries = StorageService.listActiveEntries();
    if (!entries || entries.length === 0) {
        patio.innerHTML = '<p>Nenhum veículo no pátio.</p>';
        return;
    }

    entries.forEach(ent => {
        const { tempoFormatado, total } = getEntryPricing(ent, new Date());
        const badge = ent.mensalista
            ? '<span class="badge mensalista">Mensalista</span>'
            : ent.diarista
                ? '<span class="badge diarista">Diária</span>'
                : '';
        const div = document.createElement('div');
        div.className = 'car-item';
        div.innerHTML = `<p><b>Placa:</b> ${escapeHtml(ent.placa)} ${badge}</p>
                         <p><b>Marca:</b> ${escapeHtml(ent.marca)}</p>
                         <p><b>Modelo:</b> ${escapeHtml(ent.modelo)}</p>
                         <p><b>Cor:</b> ${escapeHtml(ent.cor)}</p>
                         <p><b>Tempo no Pátio:</b> ${tempoFormatado}</p>
                         ${ent.diaria_retirada_em?`<p><b>Diária paga:</b> ${formatCurrency(ent.diaria_valor_pago)}</p><p><b>Retirar até:</b> ${escapeHtml(new Date(ent.diaria_retirada_em).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))}</p>`:''}
                         <p><b>${ent.mensalista?'Mensalidade':'Estimativa'}:</b> <span class="valor-devido">${ent.mensalista?'Conferir validade e eventual renovação na saída':`R$ ${total.toFixed(2)}`}</span></p>
                         <div class="card-actions">
                             <button class="btn-saida-card" data-entry-id="${escapeHtml(ent.entryId)}">Registrar Saída</button>
                             ${ent.diaria_valor_pago!=null?'':`<button class="btn-cancel-card" data-entry-id="${escapeHtml(ent.entryId)}" title="Cancelar entrada">Cancelar</button>`}
                             <button class="btn-print-card" data-entry-id="${escapeHtml(ent.entryId)}" title="Reimprimir comprovante">🖨️</button>
                         </div>`;
        patio.appendChild(div);
    });
    AuthService.applyPermissions();
}

///////////////////////////
// impressão
///////////////////////////
async function renderComprovanteEntrada(entrada) {
    if (!entrada) return;
    let receipt = entrada.comprovante;
    if (!receipt) {
        const res = await apiFetch(`${BACKEND_BASE}/comprovantes/entrada/${encodeURIComponent(entrada.entryId)}`);
        const data = await res.json();
        if (!res.ok) { notify(data.error || 'Comprovante não encontrado','error'); return; }
        receipt = data.dados;
    }
    await ReceiptService.render('comprovanteEntrada',receipt);
}

function formatTipoRegistro(row) {
    if (row?.mensalista) return 'Mensalista';
    if (row?.diarista) return 'Diária';
    return 'Avulso';
}

async function exportarBackup() {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/backup`);
        if (!res.ok) throw new Error('Erro ao exportar backup');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erro ao exportar backup');
        const blob = new Blob([JSON.stringify(data.dados, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `backup-estacionamento-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('Falha ao exportar backup: ' + err.message);
    }
}

let restoreCandidate = null;
async function importarBackup(event) {
    const file=event.target.files?.[0]; event.target.value='';
    if(!file)return;
    try{
        if(file.size>10*1024*1024)throw new Error('O limite do arquivo é 10 MB.');
        const payload=JSON.parse(await file.text());
        if(payload.formato!=='estacionamento-operacional'||![1,2,3].includes(payload.versao)||!payload.tabelas)throw new Error('Selecione um backup operacional no formato atual.');
        restoreCandidate=payload;
        document.getElementById('restoreResumo').textContent=`Arquivo com ${Object.values(payload.tabelas).reduce((n,rows)=>n+(Array.isArray(rows)?rows.length:0),0)} registros. Confira se este é o backup desejado.`;
        document.getElementById('restoreForm').reset();document.getElementById('restoreMessage').textContent='';
        openPopup('restorePopup');
    }catch(error){notify(error.message,'error',6000);}
}
async function confirmarRestore(event){
    event.preventDefault();if(!restoreCandidate)return;
    const button=document.getElementById('restoreSubmit');button.disabled=true;
    try{
        await operationRequest('/restore',{backup:restoreCandidate,confirmacao:document.getElementById('restoreConfirmacao').value,senha:document.getElementById('restoreSenha').value});
        restoreCandidate=null;document.getElementById('restoreForm').reset();closePopup('restorePopup');
        await window.onSessionStarted();notify('Backup restaurado com sucesso.','success');
    }catch(error){document.getElementById('restoreMessage').textContent=error.message;}
    finally{document.getElementById('restoreSenha').value='';button.disabled=false;}
}
async function abrirComprovanteOperacao(key){
    try{
        const res=await apiFetch(`${BACKEND_BASE}/comprovantes/operacao/${encodeURIComponent(key)}`);const data=await res.json();
        if(!res.ok)throw new Error(data.error||'Comprovante não encontrado');
        const target=({mensalidade:'comprovanteMensalidade',entrada:'comprovanteEntrada'})[data.dados.tipo]||'comprovantePermanencia';
        await ReceiptService.render(target,data.dados);
        openPopup(`${target}Popup`);
    }catch(error){notify(error.message,'error');}
}

function limparFormMensalista(){return SubscriptionService.clearForm(true);}
function preencherFormMensalista(row){return SubscriptionService.edit(row);}
function salvarMensalista(){return SubscriptionService.save();}
function carregarMensalistas(){return SubscriptionService.load();}
function carregarHistoricoMensalidade(row){return SubscriptionService.history(row);}
function getMensalidadeTotal(){return SubscriptionService.total();}
function atualizarResumoMensalidade(){return SubscriptionService.preview();}
function abrirPagamentoMensalidade(row){return SubscriptionService.openPayment(row);}
function confirmarPagamentoMensalidade(){return SubscriptionService.pay();}
function carregarRelatorioResumo(){return ReportService.summary();}
function carregarHistoricoCompleto(){return ReportService.vehicles();}
function aplicarFiltroData(){return ReportService.vehicles();}
function limparFiltro(){return ReportService.clearFilters();}
function buscarPorPlaca(){return ReportService.search();}
///////////////////////////
// dashboard caixa
///////////////////////////
async function carregarDashboardCaixa(){return CashService.refresh();}
function toggleCaixaValores(){return CashService.toggle();}
async function abrirFechamentoCaixa(){return CashService.openClose();}
async function confirmarFechamentoCaixa(){return CashService.closeShift();}
async function abrirHistoricoFechamentos(){return CashService.openHistory();}
async function carregarHistoricoFechamentos(){return CashService.history();}
async function carregarTurnoAtual(){return CashService.refresh();}
async function abrirTurnoCaixa(){return CashService.open();}
async function confirmarAberturaTurno(){return CashService.openShift();}
async function confirmarFechamentoTurno(){return CashService.openClose();}
function normalizeFormaPagamento(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (normalized.includes('pix')) return 'Pix';
    if (normalized.includes('dinheiro') || normalized.includes('cash')) return 'Dinheiro';
    if (normalized.includes('debito')) return 'Cartão de Débito';
    if (normalized.includes('credito')) return 'Cartão de Crédito';
    return raw;
}

async function gerarRelatorioCaixa(){return ReportService.financial();}
