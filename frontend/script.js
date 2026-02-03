// Configuração: endereço do backend
const IS_LOCAL_ENV = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
let BACKEND_BASE = window.BACKEND_BASE || (IS_LOCAL_ENV ? 'http://localhost:3000' : `${location.origin}/api`);

function getAuthToken() {
    return localStorage.getItem('adminToken') || '';
}

function apiFetch(url, options = {}) {
    const token = getAuthToken();
    const headers = new Headers(options.headers || {});
    if (token) headers.set('x-admin-token', token);
    return fetch(url, { ...options, headers });
}

async function detectBackendPort(startPort = 3000, maxPort = 3005) {
    for (let port = startPort; port <= maxPort; port++) {
        try {
            const res = await fetch(`http://localhost:${port}/placa/test`, {
                method: 'GET',
                signal: AbortSignal.timeout(1500)
            });
            if (res.ok || res.status === 400 || res.status === 404 || res.status === 502) {
                console.log(`[front] Backend detectado na porta ${port}`);
                return `http://localhost:${port}`;
            }
        } catch (e) {
            // Continua tentando próxima porta
        }
    }
    console.warn('[front] Backend não encontrado em portas 3000-3005, usando 3000 como padrão');
    return 'http://localhost:3000';
}

document.addEventListener('DOMContentLoaded', async () => {
    if (IS_LOCAL_ENV) {
        BACKEND_BASE = await detectBackendPort();
    }
    window.BACKEND_BASE = BACKEND_BASE;
    updateAuthButton();
    StorageService.migrateLegacyEntries?.();
    bindUI();
    await loadConfig(); // Aguarda carregamento das configurações do banco
    await syncActiveEntriesFromBackend();
    carregarDashboard(); // Carrega dashboard de vagas
    carregarDashboardCaixa(); // Carrega dashboard de caixa
    carregarTurnoAtual(); // Carrega status do turno
    updatePatioCarList();
    // atualiza tempos no pátio, dashboard vagas e caixa a cada 10s
    setInterval(() => {
        syncActiveEntriesFromBackend();
        updatePatioCarList();
        carregarDashboard();
        carregarDashboardCaixa();
        carregarTurnoAtual();
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
        return { tempoFormatado, total: valorDiaria || 0, horaEntrada, horaSaida, tipo: 'diarista' };
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
    dt.setUTCMonth(dt.getUTCMonth() + (Number(months) || 0));
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
function saveVehicleInfo(placa, marca, modelo, cor) {
    if (!placa) return;
    const key = normalizePlaca(placa);
    const dbRaw = localStorage.getItem('vehicleDB');
    let db = dbRaw ? JSON.parse(dbRaw) : {};
    db[key] = { marca, modelo, cor, updated: new Date().toISOString() };
    localStorage.setItem('vehicleDB', JSON.stringify(db));
}

function getVehicleInfo(placa) {
    if (!placa) return null;
    const key = normalizePlaca(placa);
    const dbRaw = localStorage.getItem('vehicleDB');
    if (!dbRaw) return null;
    const db = JSON.parse(dbRaw);
    return db[key] || null;
}

async function preencherMensalistaPorPlaca(placa) {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/mensalistas/${placa}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !data.dados) return;
        const mensalista = data.dados;
        document.getElementById('mensalistaNome').value = mensalista.nome || '';
        document.getElementById('mensalistaTelefone').value = mensalista.telefone || '';
        document.getElementById('mensalistaCpf').value = mensalista.cpf || '';
        if (mensalista.vencimento) {
            const venc = new Date(mensalista.vencimento);
            const hoje = new Date();
            if (venc < new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) {
                alert('Mensalidade vencida. Verifique o cadastro do mensalista.');
            }
        }
    } catch (err) {
        // sem mensalista cadastrado
    }
}

///////////////////////////
// debounce helper
///////////////////////////
function debounce(fn, wait = 450) {
    let t;
    return function(...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
    };
}

///////////////////////////
// auto-fill (debounced)
///////////////////////////
const autoFillVehicleDataAPI = debounce(async function() {
    const placaIn = document.getElementById('placaEntrada');
    if (!placaIn) return;
    const placa = normalizePlaca(placaIn.value || '');
    if (placa.length < 7 || !isValidPlaca(placa)) return;

    // 1) Verifica cache local
    const local = getVehicleInfo(placa);
    if (local) {
        console.log('[front] preenchendo via cache local', placa);
        document.getElementById('marcaEntrada').value = local.marca || "";
        document.getElementById('modeloEntrada').value = local.modelo || "";
        document.getElementById('corEntrada').value = local.cor || "";
        return;
    }

    // 2) Consulta backend
    const info = await consultarPlacaAPI(placa);
    if (!info) {
        console.warn('[front] sem dados da API para placa', placa);
        return;
    }

    const shouldNotify = info.mensagem && (!info.encontrado || info.origem === 'cache');
    if (shouldNotify) {
        alert(info.mensagem);
    }

    // Se a API (ou cache) trouxe dados, preenche
    if (info.encontrado || info.marca || info.modelo || info.cor) {
        document.getElementById('marcaEntrada').value = info.marca || "";
        document.getElementById('modeloEntrada').value = info.modelo || "";
        document.getElementById('corEntrada').value = info.cor || "";
        
        // Salva cache apenas se encontrou dados
        if (info.marca || info.modelo) {
            saveVehicleInfo(placa, info.marca, info.modelo, info.cor);
        }
    } else {
        // API não encontrou: usuário preenche manualmente
        console.log('[front] Placa não encontrada na API, preencha manualmente');
    }
}, 600);

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
let autoPlateScanTimer = null;
let autoPlateScanBusy = false;
let autoPlateScanAttempts = 0;
const AUTO_PLATE_SCAN_INTERVAL = 1800;
const AUTO_PLATE_SCAN_MAX_ATTEMPTS = 8;

async function blobFromCanvas(canvas, type = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Falha ao capturar imagem.')), type, quality);
    });
}

async function capturePlateCandidates(videoEl) {
    if (!videoEl) return [];
    const width = videoEl.videoWidth || 1280;
    const height = videoEl.videoHeight || 720;
    const candidates = [];

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, width, height);
    candidates.push(await blobFromCanvas(canvas));

    const cropScales = [0.7, 0.5];
    for (const scale of cropScales) {
        const cw = Math.floor(width * scale);
        const ch = Math.floor(height * scale);
        const sx = Math.floor((width - cw) / 2);
        const sy = Math.floor((height - ch) / 2);
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = cw;
        cropCanvas.height = ch;
        const cctx = cropCanvas.getContext('2d');
        cctx.drawImage(videoEl, sx, sy, cw, ch, 0, 0, cw, ch);
        candidates.push(await blobFromCanvas(cropCanvas));
    }

    return candidates;
}

async function recognizePlateFromVideo(videoEl) {
    const blobs = await capturePlateCandidates(videoEl);
    for (const blob of blobs) {
        const placa = await PlateService.recognizePlateFromImage(blob);
        if (placa) return placa;
    }
    return null;
}

function stopAutoPlateScan() {
    if (autoPlateScanTimer) clearInterval(autoPlateScanTimer);
    autoPlateScanTimer = null;
    autoPlateScanBusy = false;
    autoPlateScanAttempts = 0;
}

function handlePlateDetected(placa) {
    if (!placa) return;
    const placaInput = document.getElementById('placaEntrada');
    if (placaInput) placaInput.value = placa;
    autoFillVehicleDataAPI();
    stopAutoPlateScan();
    setTimeout(fecharCameraEntrada, 600);
}

function startAutoPlateScan() {
    stopAutoPlateScan();
    const videoEl = document.getElementById('entradaCameraPreview');
    const statusEl = document.getElementById('entradaCameraStatus');
    if (!videoEl || !statusEl) return;

    statusEl.textContent = 'Reconhecimento automático ativo...';
    autoPlateScanTimer = setInterval(async () => {
        if (autoPlateScanBusy) return;
        if (!videoEl.srcObject) return;
        if (autoPlateScanAttempts >= AUTO_PLATE_SCAN_MAX_ATTEMPTS) {
            statusEl.textContent = 'Não foi possível reconhecer automaticamente. Use Capturar.';
            stopAutoPlateScan();
            return;
        }
        autoPlateScanBusy = true;
        autoPlateScanAttempts += 1;
        try {
            const placa = await recognizePlateFromVideo(videoEl);
            if (placa) {
                statusEl.textContent = `Placa detectada: ${placa}`;
                handlePlateDetected(placa);
                return;
            }
        } catch (err) {
            console.warn('[front] falha no reconhecimento automático:', err);
        } finally {
            autoPlateScanBusy = false;
        }
    }, AUTO_PLATE_SCAN_INTERVAL);
}

async function iniciarScanPlaca() {
    const container = document.getElementById('cameraEntradaContainer');
    const statusEl = document.getElementById('entradaCameraStatus');
    const videoEl = document.getElementById('entradaCameraPreview');
    const closeBtn = document.getElementById('fecharCameraEntradaBtn');
    if (!container || !videoEl) return;

    container.setAttribute('aria-hidden', 'false');
    closeBtn?.setAttribute('aria-hidden', 'false');
    statusEl.textContent = 'Solicitando acesso à câmera...';

    try {
        try {
            await CameraService.startPreview(
                videoEl,
                { 
                    video: { 
                        facingMode: 'environment',
                        width: { ideal: 1280 },
                        height: { ideal: 720 }
                    } 
                },
                { zoom: 2 }
            );
        } catch (err) {
            await CameraService.startPreview(videoEl, { video: { facingMode: 'environment' } }, { zoom: 2 });
        }
        await CameraService.waitForReady(videoEl, 2500).catch(() => {});
        statusEl.textContent = 'Centralize a placa para reconhecimento automático.';
        startAutoPlateScan();
    } catch (err) {
        statusEl.textContent = 'Não foi possível acessar a câmera.';
        alert('Não foi possível acessar a câmera: ' + err.message);
        fecharCameraEntrada();
    }
}

async function capturarPlacaDaCamera() {
    const videoEl = document.getElementById('entradaCameraPreview');
    const statusEl = document.getElementById('entradaCameraStatus');
    if (!videoEl || !statusEl) return;
    if (!videoEl.srcObject) {
        statusEl.textContent = 'Ative a câmera antes de capturar.';
        return;
    }

    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
        statusEl.textContent = 'Aguardando a câmera ficar pronta...';
        await CameraService.waitForReady(videoEl, 2500).catch(() => {});
    }

    if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
        statusEl.textContent = 'Câmera ainda não está pronta. Tente novamente.';
        return;
    }

    statusEl.textContent = 'Capturando imagem...';
    stopAutoPlateScan();
    try {
        statusEl.textContent = 'Reconhecendo placa...';
        const placa = await recognizePlateFromVideo(videoEl);
        if (placa) {
            statusEl.textContent = `Placa detectada: ${placa}`;
            handlePlateDetected(placa);
        } else {
            statusEl.textContent = 'Não foi possível ler a placa. Tente aproximar ou ajustar o foco.';
        }
    } catch (err) {
        console.error('[front] erro ao capturar placa:', err);
        statusEl.textContent = 'Erro ao capturar imagem.';
        alert('Erro ao capturar a placa: ' + err.message);
    }
}

function fecharCameraEntrada() {
    const container = document.getElementById('cameraEntradaContainer');
    const videoEl = document.getElementById('entradaCameraPreview');
    const closeBtn = document.getElementById('fecharCameraEntradaBtn');
    if (container) container.setAttribute('aria-hidden', 'true');
    if (closeBtn) closeBtn.setAttribute('aria-hidden', 'true');
    stopAutoPlateScan();
    CameraService.stopPreview(videoEl);
}

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
        carregarRelatorioResumo();
    };
    document.getElementById('btnMenu').onclick = () => toggleMenu(true);
    document.getElementById('btnMensalistas').onclick = () => {
        openPopup('mensalistasPopup');
        carregarMensalistas();
    };
    document.getElementById('btnAuth').onclick = handleAuthClick;

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

    document.getElementById('printEntradaBtn')?.addEventListener('click', () => printHtml(document.getElementById('comprovanteEntrada').innerHTML));
    document.getElementById('printPermanenciaBtn')?.addEventListener('click', () => printHtml(document.getElementById('comprovantePermanencia').innerHTML));

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
    document.getElementById('placaEntrada').addEventListener('input', autoFillVehicleDataAPI);
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
    };

    mensalistaCheck?.addEventListener('change', syncMensalistaUI);
    diaristaCheck?.addEventListener('change', syncDiaristaUI);

    // Delegação de eventos para botões de saída nos cards (criados dinamicamente)
    document.getElementById('patioCarList').addEventListener('click', (e) => {
        if (e.target.classList.contains('btn-saida-card')) {
            const entryId = e.target.dataset.entryId;
            registrarSaidaPeloCard(entryId);
        }
        if (e.target.classList.contains('btn-print-card')) {
            const entryId = e.target.dataset.entryId;
            const entry = StorageService.getEntryById(entryId);
            if (!entry) return alert('Entrada não encontrada.');
            renderComprovanteEntrada(entry);
            openPopup('comprovanteEntradaPopup');
        }
    });

    document.querySelectorAll('.popup').forEach(p => p.addEventListener('click', e => { if (e.target === p) closePopupByElement(p); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('.popup[aria-hidden="false"]').forEach(p => closePopupByElement(p)); toggleMenu(false); }});
}

///////////////////////////
// popups
///////////////////////////
function openPopup(id) { const el = document.getElementById(id); if (el) el.setAttribute('aria-hidden','false'); }
function closePopup(id) { const el = document.getElementById(id); if (el) el.setAttribute('aria-hidden','true'); }
function closePopupByElement(el) {
    if (!el) return;
    el.setAttribute('aria-hidden','true');
    if (el.id === 'entradaPopup') fecharCameraEntrada();
    if (el.id === 'saidaPopup') fecharCameraSaida();
}
function toggleMenu(show) { const el = document.getElementById('menu'); if (!el) return; el.setAttribute('aria-hidden', show ? 'false' : 'true'); }

function updateAuthButton() {
    const btn = document.getElementById('btnAuth');
    if (!btn) return;
    btn.textContent = getAuthToken() ? 'Sair' : 'Acesso';
}

function handleAuthClick() {
    const token = getAuthToken();
    if (token) {
        localStorage.removeItem('adminToken');
        updateAuthButton();
        notify('Acesso removido.', 'success');
        return;
    }
    const input = prompt('Informe o token de acesso:');
    if (!input) return;
    localStorage.setItem('adminToken', input.trim());
    updateAuthButton();
    notify('Acesso aplicado.', 'success');
}

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
        cliente_nome: row.cliente_nome || '',
        cliente_telefone: row.cliente_telefone || '',
        cliente_cpf: row.cliente_cpf || ''
    };
}

async function syncActiveEntriesFromBackend() {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/patio/ativos`);
        if (!res.ok) return false;
        const data = await res.json();
        if (!data.success || !Array.isArray(data.dados)) return false;
        const entries = data.dados.map(mapBackendEntryToLocal);
        StorageService.replaceEntries(entries);
        return true;
    } catch (err) {
        console.warn('[front] falha ao sincronizar pátio:', err.message);
        return false;
    }
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
    document.getElementById('placaEntrada').value = '';
    document.getElementById('marcaEntrada').value = '';
    document.getElementById('modeloEntrada').value = '';
    document.getElementById('corEntrada').value = '';
    document.getElementById('mensalistaCheck').checked = false;
    document.getElementById('diaristaCheck').checked = false;
    document.getElementById('mensalistaNome').value = '';
    document.getElementById('mensalistaTelefone').value = '';
    document.getElementById('mensalistaCpf').value = '';
    document.getElementById('mensalistaFields').setAttribute('aria-hidden', 'true');
}

///////////////////////////
// registrar entrada
///////////////////////////
function registrarEntrada() {
    const placa = normalizePlaca(document.getElementById('placaEntrada').value);
    const marca = document.getElementById('marcaEntrada').value.trim();
    const modelo = document.getElementById('modeloEntrada').value.trim();
    const cor = document.getElementById('corEntrada').value.trim();
    const mensalista = document.getElementById('mensalistaCheck').checked;
    const diarista = document.getElementById('diaristaCheck').checked;
    const clienteNome = document.getElementById('mensalistaNome').value.trim();
    const clienteTelefone = document.getElementById('mensalistaTelefone').value.trim();
    const clienteCpf = document.getElementById('mensalistaCpf').value.trim();

    if (!isValidPlaca(placa)) { alert('Placa inválida. Use formato AAA1234 ou AAA1A23.'); return; }
    if (!placa || !marca || !modelo) { alert('Placa, marca e modelo são obrigatórios.'); return; }
    if (mensalista && diarista) { alert('Selecione apenas Mensalista ou Diária.'); return; }
    if (mensalista && (!clienteNome || !clienteTelefone || !clienteCpf)) {
        alert('Informe nome, telefone e CPF do mensalista.');
        return;
    }

    const existingEntry = StorageService.getEntryByPlate(placa);
    if (existingEntry) {
        const entradaAnterior = new Date(existingEntry.horaEntradaMs || existingEntry.horaEntrada).toLocaleString();
        alert(`Este veículo já está no pátio desde ${entradaAnterior}. Não é possível registrar novamente.`);
        return;
    }

    const now = new Date();
    const entrada = {
        entryId: StorageService.generateEntryId(),
        placa,
        marca,
        modelo,
        cor,
        horaEntrada: now.toISOString(),
        horaEntradaMs: now.getTime(),
        mensalista,
        diarista,
        cliente_nome: clienteNome,
        cliente_telefone: clienteTelefone,
        cliente_cpf: clienteCpf
    };

    // Salva no backend (banco de dados)
    apiFetch(`${BACKEND_BASE}/entrada`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            placa,
            marca,
            modelo,
            cor,
            entryId: entrada.entryId,
            mensalista,
            diarista,
            cliente_nome: clienteNome,
            cliente_telefone: clienteTelefone,
            cliente_cpf: clienteCpf
        })
    })
    .then(res => res.json())
    .then(data => {
        if (!data.success) {
            alert('Erro ao registrar entrada: ' + (data.error || data.mensagem || 'Desconhecido'));
            return;
        }
        
        // salva cache local (vehicleDB) e entrada
        saveVehicleInfo(placa, marca, modelo, cor);
        StorageService.saveEntry(entrada);

        updatePatioCarList();
        carregarDashboard();
        clearEntradaForm();
        fecharCameraEntrada();
        closePopup('entradaPopup');

        // Busca valores atualizados do banco
        const valorHora = localStorage.getItem('valorHora') || "5.00";
        const valorHoraAdc = localStorage.getItem('valorHoraAdicional') || "2.50";
        const tolerancia = localStorage.getItem('toleranciaHoraAdicional') || "15";

        renderComprovanteEntrada(entrada);
        openPopup('comprovanteEntradaPopup');
    })
    .catch(err => {
        console.error('[front] erro ao registrar entrada:', err);
        alert('Erro ao registrar entrada no servidor');
    });
}

///////////////////////////
// calcular permanência
///////////////////////////
function prepararPagamento(entry) {
    if (!entry) {
        alert('Entrada não localizada.');
        return;
    }

    const { tempoFormatado, total, horaEntrada, horaSaida, tipo } = getEntryPricing(entry, new Date());

    // Armazena dados temporários para o pagamento
    window.dadosPagamento = {
        entryId: entry.entryId,
        placa: entry.placa,
        marca: entry.marca,
        modelo: entry.modelo,
        horaEntrada: horaEntrada,
        horaSaida: horaSaida,
        tempo: tempoFormatado,
        valor: total,
        tipo
    };

    // Mostra resumo no modal de pagamento
    document.getElementById('resumoPagamento').innerHTML = `
        <h4>Resumo da Permanência</h4>
        <p><b>Entrada:</b> <span>${horaEntrada.toLocaleString()}</span></p>
        <p><b>Saída:</b> <span>${horaSaida.toLocaleString()}</span></p>
        <p><b>Tempo:</b> <span>${tempoFormatado}</span></p>
        <p><b>Veículo:</b> <span>${entry.marca} ${entry.modelo}</span></p>
        <p><b>Placa:</b> <span>${entry.placa}</span></p>
        <p><b>ID:</b> <span>${entry.entryId}</span></p>
        <p><b>Tipo:</b> <span>${tipo === 'mensalista' ? 'Mensalista' : tipo === 'diarista' ? 'Diária' : 'Avulso'}</span></p>
        <p class="valor-total"><b>Total a Pagar:</b> <span>R$ ${Number(total).toFixed(2)}</span></p>
    `;

    // Fecha modal de saída e abre modal de pagamento
    closePopup('saidaPopup');

    if (total > 0) {
        resetSplitUI('splitPagamentoLista', 'splitPagamentoTotal', 'splitPagamentoRestante', total);
        openPopup('pagamentoPopup');
    } else {
        processarSaida([]);
    }
}

///////////////////////////
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
        alert('A soma das formas de pagamento precisa fechar o total da saída');
        return;
    }

    processarSaida(pagamentos);
}

///////////////////////////
// processar saída (após pagamento)
///////////////////////////
function processarSaida(pagamentos = []) {
    const dados = window.dadosPagamento;
    
    if (!dados) {
        alert('Dados de pagamento não encontrados');
        return;
    }
    
    // Registra saída no backend
    const pagamentosValidos = Array.isArray(pagamentos) ? pagamentos.filter(p => p.forma_pagamento && Number(p.valor_pago) > 0) : [];
    const formaPagamento = pagamentosValidos.length === 1 ? pagamentosValidos[0].forma_pagamento : (pagamentosValidos.length > 1 ? 'Múltiplo' : null);

    apiFetch(`${BACKEND_BASE}/saida`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            placa: dados.placa, 
            entryId: dados.entryId,
            valor_pago: dados.valor, 
            tempo_permanencia: dados.tempo,
            forma_pagamento: formaPagamento,
            pagamentos: pagamentosValidos
        })
    })
    .then(res => res.json())
    .then(data => {
        if (!data.success) {
            alert('Erro ao registrar saída: ' + (data.error || 'Desconhecido'));
            return;
        }
        
        // Remove do localStorage
        StorageService.removeEntry(dados.entryId);
        
        // Gera comprovante
        const pagamentosHtml = pagamentosValidos.length
            ? `<p><b>Forma de Pagamento:</b> ${formaPagamento}</p>${pagamentosValidos.length > 1 ? `<ul>${pagamentosValidos.map(p => `<li>${p.forma_pagamento} - ${formatCurrency(p.valor_pago)}</li>`).join('')}</ul>` : ''}`
            : '';

        document.getElementById('comprovantePermanencia').innerHTML = `
            <h3>✅ Comprovante de Saída</h3>
            <p><b>ID da Entrada:</b> ${dados.entryId}</p>
            <p><b>Placa:</b> ${dados.placa}</p>
            <p><b>Veículo:</b> ${dados.marca} ${dados.modelo}</p>
            <p><b>Entrada:</b> ${dados.horaEntrada.toLocaleString()}</p>
            <p><b>Saída:</b> ${dados.horaSaida.toLocaleString()}</p>
            <p><b>Tempo:</b> ${dados.tempo}</p>
            <p><b>Tipo:</b> ${dados.tipo === 'mensalista' ? 'Mensalista' : dados.tipo === 'diarista' ? 'Diária' : 'Avulso'}</p>
            <p><b>Valor:</b> R$ ${Number(dados.valor).toFixed(2)}</p>
            ${pagamentosHtml}
            <p style="margin-top:20px;font-size:12px;color:#666;">Obrigado pela preferência!</p>
        `;
        
        // Fecha modal de pagamento e abre comprovante
        closePopup('pagamentoPopup');
        openPopup('comprovantePermanenciaPopup');
        
        // Limpa formulários
        document.getElementById('placaSaida').value = '';
        resetSplitUI('splitPagamentoLista', 'splitPagamentoTotal', 'splitPagamentoRestante', 0);
        
        // Atualiza dashboards
        updatePatioCarList();
        carregarDashboard();
        carregarDashboardCaixa();
        
        // Limpa dados temporários
        delete window.dadosPagamento;
    })
    .catch(err => {
        console.error('[front] erro ao registrar saída:', err);
        alert('Erro ao registrar saída no servidor');
    });
}

///////////////////////////
// saída pelo card do veículo
///////////////////////////
function registrarSaidaPeloCard(entryId) {
    const entrada = StorageService.getEntryById(entryId);
    if (!entrada) {
        alert('Veículo não encontrado no cache local.');
        return;
    }
    prepararPagamento(entrada);
}

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
        div.innerHTML = `<p><b>Placa:</b> ${ent.placa} ${badge}</p>
                         <p><b>Marca:</b> ${ent.marca}</p>
                         <p><b>Modelo:</b> ${ent.modelo}</p>
                         <p><b>Cor:</b> ${ent.cor}</p>
                         <p><b>Tempo no Pátio:</b> ${tempoFormatado}</p>
                         <p><b>Valor Devido:</b> <span class="valor-devido">R$ ${total.toFixed(2)}</span></p>
                         <div class="card-actions">
                             <button class="btn-saida-card" data-entry-id="${ent.entryId}">Registrar Saída</button>
                             <button class="btn-print-card" data-entry-id="${ent.entryId}" title="Reimprimir comprovante">🖨️</button>
                         </div>`;
        patio.appendChild(div);
    });
}

///////////////////////////
// impressão
///////////////////////////
function printHtml(html) {
    const w = window.open('', '_blank', 'width=600,height=600');
    w.document.write(`<html><head><title>Imprimir</title></head><body>${html}</body></html>`);
    w.document.close();
    setTimeout(()=>{ w.print(); w.close(); }, 300);
}

function renderComprovanteEntrada(entrada) {
    if (!entrada) return;
    const valorHora = localStorage.getItem('valorHora') || "5.00";
    const valorHoraAdc = localStorage.getItem('valorHoraAdicional') || "2.50";
    const tolerancia = localStorage.getItem('toleranciaHoraAdicional') || "15";
    const tipo = entrada.mensalista ? 'Mensalista' : entrada.diarista ? 'Diária' : 'Avulso';
    const entradaDate = new Date(entrada.horaEntradaMs || entrada.horaEntrada);

    document.getElementById('comprovanteEntrada').innerHTML = `
        <h3>Comprovante de Entrada</h3>
        <p><b>Tipo:</b> ${tipo}</p>
        <p><b>Entrada:</b> ${entradaDate.toLocaleString()}</p>
        <p><b>1ª Hora:</b> R$ ${valorHora}</p>
        <p><b>Hora Adicional:</b> R$ ${valorHoraAdc}</p>
        <p><b>Tolerância:</b> ${tolerancia} min</p>
        <div class="qr-area">
            <div id="qrCodeEntrada"></div>
            <p>Apresente este QR Code na saída.</p>
        </div>
    `;

    QRCodeService.render('qrCodeEntrada', entrada.entryId, { size: 164 })
        .catch(err => console.warn('[front] não foi possível gerar QR Code:', err));
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

async function importarBackup(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!confirm('Tem certeza? Essa ação substitui os dados atuais.')) return;

    try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const res = await apiFetch(`${BACKEND_BASE}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Erro ao restaurar backup');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erro ao restaurar backup');
        alert('Backup restaurado com sucesso.');
        await syncActiveEntriesFromBackend();
        updatePatioCarList();
        carregarDashboard();
    } catch (err) {
        alert('Falha ao restaurar backup: ' + err.message);
    }
}

function limparFormMensalista() {
    window.mensalistaEditId = null;
    document.getElementById('mensalistaPlaca').value = '';
    document.getElementById('mensalistaNomeForm').value = '';
    document.getElementById('mensalistaTelefoneForm').value = '';
    document.getElementById('mensalistaCpfForm').value = '';
    document.getElementById('mensalistaVencimento').value = '';
    document.getElementById('mensalistaAtivo').checked = true;
}

function preencherFormMensalista(row) {
    window.mensalistaEditId = row.id;
    document.getElementById('mensalistaPlaca').value = row.placa || '';
    document.getElementById('mensalistaNomeForm').value = row.nome || '';
    document.getElementById('mensalistaTelefoneForm').value = row.telefone || '';
    document.getElementById('mensalistaCpfForm').value = row.cpf || '';
    document.getElementById('mensalistaVencimento').value = row.vencimento ? String(row.vencimento).slice(0, 10) : '';
    document.getElementById('mensalistaAtivo').checked = row.ativo !== false;
}

async function salvarMensalista() {
    const placa = normalizePlaca(document.getElementById('mensalistaPlaca').value);
    const nome = document.getElementById('mensalistaNomeForm').value.trim();
    const telefone = document.getElementById('mensalistaTelefoneForm').value.trim();
    const cpf = document.getElementById('mensalistaCpfForm').value.trim();
    const vencimento = document.getElementById('mensalistaVencimento').value;
    const ativo = document.getElementById('mensalistaAtivo').checked;

    if (!placa || !isValidPlaca(placa)) return alert('Informe uma placa válida.');
    if (!nome) return alert('Nome é obrigatório.');

    try {
        const editId = window.mensalistaEditId;
        const url = editId ? `${BACKEND_BASE}/mensalistas/${editId}` : `${BACKEND_BASE}/mensalistas`;
        const method = editId ? 'PUT' : 'POST';
        const res = await apiFetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ placa, nome, telefone, cpf, vencimento, ativo })
        });
        if (!res.ok) throw new Error('Erro ao salvar mensalista');
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erro ao salvar mensalista');
        limparFormMensalista();
        carregarMensalistas();
        alert('Mensalista salvo com sucesso.');
    } catch (err) {
        alert('Falha ao salvar mensalista: ' + err.message);
    }
}

async function carregarMensalistas() {
    const q = document.getElementById('mensalistasBusca').value.trim();
    const status = document.getElementById('mensalistasStatus').value;
    const params = new URLSearchParams();
    if (q) params.append('q', q);
    if (status) params.append('status', status);
    const url = params.toString() ? `${BACKEND_BASE}/mensalistas?${params}` : `${BACKEND_BASE}/mensalistas`;

    try {
        const res = await apiFetch(url);
        if (!res.ok) throw new Error('Erro ao carregar mensalistas');
        const data = await res.json();
        if (!data.success || !data.dados) throw new Error('Erro ao carregar mensalistas');
        renderMensalistas(data.dados);
    } catch (err) {
        document.getElementById('mensalistasLista').innerHTML = '<p>Erro ao carregar mensalistas.</p>';
    }
}

function renderMensalistas(lista) {
    if (!lista || lista.length === 0) {
        document.getElementById('mensalistasLista').innerHTML = '<p>Nenhum mensalista cadastrado.</p>';
        document.getElementById('mensalidadeHistoricoConteudo').innerHTML = '<p>Selecione um mensalista para ver o histórico.</p>';
        return;
    }

    let html = '<table><tr><th>Placa</th><th>Nome</th><th>CPF</th><th>Vencimento</th><th>Status</th><th>Ações</th></tr>';
    lista.forEach((row) => {
        const venc = row.vencimento ? String(row.vencimento).slice(0, 10) : '-';
        html += `<tr>
            <td>${row.placa}</td>
            <td>${row.nome}</td>
            <td>${row.cpf || '-'}</td>
            <td>${venc}</td>
            <td>${row.ativo === false ? 'Inativo' : 'Ativo'}</td>
            <td>
                <button class="btn-ghost" data-edit-id="${row.id}">Editar</button>
                <button class="btn-ghost" data-history-id="${row.id}">Histórico</button>
                ${row.ativo === false ? '' : `<button class="btn-ghost" data-pay-id="${row.id}">Receber</button>`}
            </td>
        </tr>`;
    });
    html += '</table>';
    document.getElementById('mensalistasLista').innerHTML = html;

    document.querySelectorAll('#mensalistasLista [data-edit-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-edit-id');
            const row = lista.find(r => String(r.id) === String(id));
            if (row) preencherFormMensalista(row);
        });
    });

    document.querySelectorAll('#mensalistasLista [data-pay-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-pay-id');
            const row = lista.find(r => String(r.id) === String(id));
            if (row) abrirPagamentoMensalidade(row);
        });
    });

    document.querySelectorAll('#mensalistasLista [data-history-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-history-id');
            const row = lista.find(r => String(r.id) === String(id));
            if (row) carregarHistoricoMensalidade(row);
        });
    });
}

async function carregarHistoricoMensalidade(row) {
    const container = document.getElementById('mensalidadeHistoricoConteudo');
    if (!container) return;
    container.innerHTML = '<p>Carregando histórico...</p>';

    try {
        const res = await apiFetch(`${BACKEND_BASE}/mensalistas/${row.id}/pagamentos?limit=100`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Erro ao carregar histórico');

        const lista = data.dados || [];
        if (lista.length === 0) {
            container.innerHTML = '<p>Nenhum pagamento registrado para este mensalista.</p>';
            return;
        }

        let html = `<h5>${row.nome} - ${row.placa}</h5>`;
        html += '<table><tr><th>Data</th><th>Hora</th><th>Forma</th><th>Valor</th><th>Obs.</th></tr>';
        lista.forEach((item) => {
            html += `<tr>
                <td>${item.data_pagamento}</td>
                <td>${item.hora_pagamento}</td>
                <td>${item.forma_pagamento || '-'}</td>
                <td>R$ ${Number(item.valor_pago || 0).toFixed(2)}</td>
                <td>${item.observacao || '-'}</td>
            </tr>`;
        });
        html += '</table>';
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = '<p>Erro ao carregar histórico.</p>';
    }
}

function getMensalidadeTotal() {
    const meses = Math.max(1, parseInt(document.getElementById('mensalidadeMeses')?.value || '1', 10) || 1);
    const valor = parseFloat(document.getElementById('mensalidadeValor')?.value || '0');
    return meses * (Number.isNaN(valor) ? 0 : valor);
}

function atualizarResumoMensalidade() {
    const resumo = document.getElementById('mensalidadeResumo');
    const info = document.getElementById('mensalidadeVencimentoEstimado');
    if (!resumo || !window.mensalidadePagamento) return;

    const meses = Math.max(1, parseInt(document.getElementById('mensalidadeMeses')?.value || '1', 10) || 1);
    const total = getMensalidadeTotal();
    const now = new Date();
    const hoje = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let vencAtual = window.mensalidadePagamento.vencimento ? String(window.mensalidadePagamento.vencimento).slice(0, 10) : null;
    if (vencAtual && /^\d{4}-\d{2}-\d{2}$/.test(vencAtual)) {
        const ano = Number(vencAtual.slice(0, 4));
        if (!ano || ano < 2000) vencAtual = null;
    } else {
        vencAtual = null;
    }
    const baseVenc = vencAtual && vencAtual >= hoje ? vencAtual : hoje;
    const proxVenc = addMonthsToISODateFront(baseVenc, meses);

    resumo.innerHTML = `
        <h4>Resumo da Mensalidade</h4>
        <p><b>Mensalista:</b> <span>${window.mensalidadePagamento.nome}</span></p>
        <p><b>Placa:</b> <span>${window.mensalidadePagamento.placa}</span></p>
        <p><b>Vencimento atual:</b> <span>${formatBrDate(vencAtual)}</span></p>
        <p class="valor-total"><b>Total a Pagar:</b> <span>${formatCurrency(total)}</span></p>
    `;

    if (info) {
        info.textContent = `Próximo vencimento estimado: ${formatBrDate(proxVenc)}`;
    }

    updateSplitSummary('splitMensalidadeLista', 'splitMensalidadeTotal', 'splitMensalidadeRestante', total);
}

function abrirPagamentoMensalidade(row) {
    window.mensalidadePagamento = {
        id: row.id,
        placa: row.placa,
        nome: row.nome,
        vencimento: row.vencimento || null,
        ativo: row.ativo !== false
    };

    const valorMensal = parseFloat(localStorage.getItem('valorMensalidade') || '0');
    const inputValor = document.getElementById('mensalidadeValor');
    if (inputValor) inputValor.value = Number(valorMensal || 0).toFixed(2);
    const inputMeses = document.getElementById('mensalidadeMeses');
    if (inputMeses) inputMeses.value = '1';
    const inputObs = document.getElementById('mensalidadeObservacao');
    if (inputObs) inputObs.value = '';

    atualizarResumoMensalidade();
    resetSplitUI('splitMensalidadeLista', 'splitMensalidadeTotal', 'splitMensalidadeRestante', getMensalidadeTotal());
    openPopup('mensalidadePagamentoPopup');
}

async function confirmarPagamentoMensalidade() {
    if (!window.mensalidadePagamento) return;
    const total = getMensalidadeTotal();
    const pagamentos = getSplitPayments('splitMensalidadeLista');

    if (total <= 0) {
        alert('Informe um valor válido para a mensalidade');
        return;
    }

    if (pagamentos.length === 0) {
        alert('Informe ao menos uma forma de pagamento');
        return;
    }
    if (!validateSplitTotal(total, pagamentos)) {
        alert('A soma das formas de pagamento precisa fechar o total da mensalidade');
        return;
    }

    const meses = Math.max(1, parseInt(document.getElementById('mensalidadeMeses')?.value || '1', 10) || 1);
    const observacao = document.getElementById('mensalidadeObservacao')?.value?.trim() || '';

    try {
        const res = await apiFetch(`${BACKEND_BASE}/mensalistas/pagamentos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mensalista_id: window.mensalidadePagamento.id,
                placa: window.mensalidadePagamento.placa,
                nome: window.mensalidadePagamento.nome,
                meses,
                observacao,
                pagamentos
            })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Erro ao registrar pagamento');
        }

        closePopup('mensalidadePagamentoPopup');
        alert(`Mensalidade registrada. Novo vencimento: ${formatBrDate(data.novo_vencimento)}`);
        carregarMensalistas();
        carregarDashboardCaixa();
        carregarHistoricoMensalidade(window.mensalidadePagamento);
        window.mensalidadePagamento = null;
    } catch (err) {
        alert('Falha ao registrar mensalidade: ' + err.message);
    }
}

///////////////////////////
// histórico e relatórios
///////////////////////////
function carregarRelatorioResumo() {
    const tipo = document.getElementById('filtroTipo')?.value || '';
    const params = new URLSearchParams();
    if (tipo) params.append('tipo', tipo);
    const url = params.toString() ? `${BACKEND_BASE}/relatorio/resumo?${params}` : `${BACKEND_BASE}/relatorio/resumo`;
    apiFetch(url)
        .then(res => res.json())
        .then(data => {
            if (!data.success || !data.dados) {
                document.getElementById('historicoConteudo').innerHTML = '<p>Erro ao carregar relatório</p>';
                return;
            }
            const r = data.dados;
            document.getElementById('historicoConteudo').innerHTML = `
                <h4>Resumo Geral</h4>
                <p><b>Total de Movimentações:</b> ${r.total_movimentacoes || 0}</p>
                <p><b>Veículos no Pátio:</b> ${r.veiculos_no_patio || 0}</p>
                <p><b>Total de Saídas:</b> ${r.total_saidas || 0}</p>
                <p><b>Veículos Únicos:</b> ${r.total_veiculos_unicos || 0}</p>
                <hr>
                <p><b>Receita Total:</b> R$ ${Number(r.receita_total || 0).toFixed(2)}</p>
                <p><b>Valor Médio por Saída:</b> R$ ${Number(r.valor_medio || 0).toFixed(2)}</p>
            `;
        })
        .catch(err => {
            console.error('[front] erro ao carregar relatório:', err);
            document.getElementById('historicoConteudo').innerHTML = '<p>Erro ao conectar ao servidor</p>';
        });
}

function carregarHistoricoCompleto(filtros = {}) {
    let url = `${BACKEND_BASE}/historico`;
    const params = new URLSearchParams();
    
    if (filtros.dia) params.append('dia', filtros.dia);
    if (filtros.mes) params.append('mes', filtros.mes);
    if (filtros.ano) params.append('ano', filtros.ano);
    if (filtros.tipo) params.append('tipo', filtros.tipo);
    
    if (params.toString()) url += '?' + params.toString();
    
    apiFetch(url)
        .then(res => res.json())
        .then(data => {
            if (!data.success || !data.dados) {
                document.getElementById('historicoConteudo').innerHTML = '<p>Nenhum histórico encontrado</p>';
                return;
            }
            if (data.dados.length === 0) {
                document.getElementById('historicoConteudo').innerHTML = '<p>Nenhum registro no histórico</p>';
                return;
            }
            let html = '<h4>Histórico Completo</h4><table><tr><th>Placa</th><th>Tipo</th><th>Marca/Modelo</th><th>Entrada</th><th>Saída</th><th>Tempo</th><th>Valor</th><th>Status</th></tr>';
            data.dados.forEach(row => {
                html += `<tr>
                    <td>${row.placa}</td>
                    <td>${formatTipoRegistro(row)}</td>
                    <td>${row.marca} ${row.modelo}</td>
                    <td>${row.data_entrada} ${row.hora_entrada}</td>
                    <td>${row.data_saida || '-'} ${row.hora_saida || '-'}</td>
                    <td>${row.tempo_permanencia || '-'}</td>
                    <td>R$ ${Number(row.valor_pago || 0).toFixed(2)}</td>
                    <td>${row.status}</td>
                </tr>`;
            });
            html += '</table>';
            document.getElementById('historicoConteudo').innerHTML = html;
        })
        .catch(err => {
            console.error('[front] erro ao carregar histórico:', err);
            document.getElementById('historicoConteudo').innerHTML = '<p>Erro ao conectar ao servidor</p>';
        });
}

function aplicarFiltroData() {
    const dia = document.getElementById('filtroDia').value;
    const mes = document.getElementById('filtroMes').value;
    const ano = document.getElementById('filtroAno').value;
    const tipo = document.getElementById('filtroTipo').value;
    
    if (!dia && !mes && !ano && !tipo) {
        alert('Selecione pelo menos um filtro (dia, mês, ano ou tipo)');
        return;
    }
    
    const filtros = {};
    if (dia) filtros.dia = dia;
    if (mes) filtros.mes = mes;
    if (ano) filtros.ano = ano;
    if (tipo) filtros.tipo = tipo;
    
    carregarHistoricoCompleto(filtros);
}

function limparFiltro() {
    document.getElementById('filtroDia').value = '';
    document.getElementById('filtroMes').value = '';
    document.getElementById('filtroAno').value = '';
    document.getElementById('filtroTipo').value = '';
    carregarHistoricoCompleto();
}

function buscarPorPlaca() {
    const placa = prompt('Digite a placa para buscar:');
    if (!placa) return;
    
    const placaNorm = normalizePlaca(placa);
    apiFetch(`${BACKEND_BASE}/historico/${placaNorm}`)
        .then(res => res.json())
        .then(data => {
            if (!data.success || !data.dados) {
                document.getElementById('historicoConteudo').innerHTML = '<p>Erro ao buscar</p>';
                return;
            }
            if (data.dados.length === 0) {
                document.getElementById('historicoConteudo').innerHTML = '<p>Nenhum registro encontrado para placa: ' + placaNorm + '</p>';
                return;
            }
            let html = '<h4>Histórico da Placa: ' + placaNorm + '</h4><table><tr><th>Tipo</th><th>Data Entrada</th><th>Hora Entrada</th><th>Data Saída</th><th>Hora Saída</th><th>Tempo</th><th>Valor</th><th>Status</th></tr>';
            data.dados.forEach(row => {
                html += `<tr>
                    <td>${formatTipoRegistro(row)}</td>
                    <td>${row.data_entrada}</td>
                    <td>${row.hora_entrada}</td>
                    <td>${row.data_saida || '-'}</td>
                    <td>${row.hora_saida || '-'}</td>
                    <td>${row.tempo_permanencia || '-'}</td>
                    <td>R$ ${(row.valor_pago || 0).toFixed(2)}</td>
                    <td>${row.status}</td>
                </tr>`;
            });
            html += '</table>';
            document.getElementById('historicoConteudo').innerHTML = html;
        })
        .catch(err => {
            console.error('[front] erro ao buscar histórico:', err);
            document.getElementById('historicoConteudo').innerHTML = '<p>Erro ao conectar ao servidor</p>';
        });
}

///////////////////////////
// dashboard caixa
///////////////////////////
async function carregarDashboardCaixa() {
    try {
        const dados = await fetchDashboardCaixaData();
        const { total_recebido, total_dinheiro, total_credito, total_debito, total_pix, total_transacoes } = dados;
        const isMasked = document.getElementById('caixaTotalRecebido').classList.contains('masked');

        document.getElementById('caixaTotalRecebido').dataset.valor = total_recebido;
        document.getElementById('caixaDinheiro').dataset.valor = total_dinheiro;
        document.getElementById('caixaCredito').dataset.valor = total_credito;
        document.getElementById('caixaDebito').dataset.valor = total_debito;
        document.getElementById('caixaPix').dataset.valor = total_pix;

        if (!isMasked) {
            document.getElementById('caixaTotalRecebido').textContent = `R$ ${Number(total_recebido).toFixed(2)}`;
            document.getElementById('caixaDinheiro').textContent = `R$ ${Number(total_dinheiro).toFixed(2)}`;
            document.getElementById('caixaCredito').textContent = `R$ ${Number(total_credito).toFixed(2)}`;
            document.getElementById('caixaDebito').textContent = `R$ ${Number(total_debito).toFixed(2)}`;
            document.getElementById('caixaPix').textContent = `R$ ${Number(total_pix).toFixed(2)}`;
        }

        document.getElementById('caixaTransacoes').textContent = total_transacoes;
        return dados;
    } catch (err) {
        console.error('[front] Erro ao carregar dashboard de caixa:', err);
        return null;
    }
}

function toggleCaixaValores() {
    const elementos = document.querySelectorAll('.caixa-item .valor');
    
    elementos.forEach(el => {
        if (el.id === 'caixaTransacoes') return; // Não mascara o contador de transações
        
        if (el.classList.contains('masked')) {
            // Mostrar valores
            el.classList.remove('masked');
            const valor = parseFloat(el.dataset.valor || 0);
            el.textContent = `R$ ${valor.toFixed(2)}`;
        } else {
            // Ocultar valores
            el.classList.add('masked');
            el.textContent = 'R$ ••••••';
        }
    });
    
    // Alterna ícone do botão
    const btn = document.getElementById('toggleCaixaBtn');
    const icon = btn.querySelector('.icon-eye');
    icon.textContent = icon.textContent === '👁️' ? '🙈' : '👁️';
}

///////////////////////////
// relatórios de caixa
///////////////////////////
async function fetchDashboardCaixaData() {
    const res = await apiFetch(`${BACKEND_BASE}/caixa/dashboard`);
    if (!res.ok) throw new Error('Erro ao carregar dashboard de caixa');
    const data = await res.json();
    if (!data.success || !data.dados) throw new Error('Dados de caixa indisponíveis');
    return data.dados;
}

async function abrirFechamentoCaixa() {
    try {
        const dados = await fetchDashboardCaixaData();
        const resumo = document.getElementById('fechamentoResumo');
        if (resumo) {
            resumo.innerHTML = `
                <h4>Resumo do Dia</h4>
                <p><span>Total Recebido</span><strong>R$ ${Number(dados.total_recebido || 0).toFixed(2)}</strong></p>
                <p><span>Dinheiro</span><strong>R$ ${Number(dados.total_dinheiro || 0).toFixed(2)}</strong></p>
                <p><span>Crédito</span><strong>R$ ${Number(dados.total_credito || 0).toFixed(2)}</strong></p>
                <p><span>Débito</span><strong>R$ ${Number(dados.total_debito || 0).toFixed(2)}</strong></p>
                <p><span>Pix</span><strong>R$ ${Number(dados.total_pix || 0).toFixed(2)}</strong></p>
                <p><span>Transações</span><strong>${Number(dados.total_transacoes || 0)}</strong></p>
            `;
        }
        const forceEl = document.getElementById('fechamentoForce');
        if (forceEl) forceEl.checked = false;
        openPopup('fechamentoCaixaPopup');
    } catch (err) {
        console.error('[front] erro ao abrir fechamento:', err);
        notify('Falha ao carregar resumo do caixa.', 'error');
    }
}

async function confirmarFechamentoCaixa() {
    const observacao = document.getElementById('fechamentoObservacao')?.value?.trim() || '';
    const force = Boolean(document.getElementById('fechamentoForce')?.checked);
    if (force && !observacao) {
        notify('Informe uma observação para fechamento forçado.', 'error');
        return;
    }
    if (force && !confirm('Confirma o fechamento forçado? Esta ação sobrescreve o fechamento existente.')) {
        return;
    }
    try {
        const res = await apiFetch(`${BACKEND_BASE}/caixa/fechamento`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ observacao, force })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            const msg = data.error || data.mensagem || 'Erro ao fechar caixa';
            if (res.status === 409) {
                notify('Fechamento já existe para hoje. Use o admin para forçar, se necessário.', 'error');
            } else {
                notify(msg, 'error');
            }
            return;
        }
        closePopup('fechamentoCaixaPopup');
        document.getElementById('fechamentoObservacao').value = '';
        const forceEl = document.getElementById('fechamentoForce');
        if (forceEl) forceEl.checked = false;
        notify('Caixa fechado com sucesso.', 'success');
    } catch (err) {
        console.error('[front] erro ao fechar caixa:', err);
        notify('Falha ao fechar caixa.', 'error');
    }
}

///////////////////////////
// histórico de fechamentos
///////////////////////////
async function abrirHistoricoFechamentos() {
    await carregarHistoricoFechamentos();
    openPopup('fechamentosHistoricoPopup');
}

async function carregarHistoricoFechamentos() {
    const dataInicio = document.getElementById('dataInicioFechamentos')?.value || '';
    const dataFim = document.getElementById('dataFimFechamentos')?.value || '';
    const params = new URLSearchParams();
    if (dataInicio) params.append('dataInicio', dataInicio);
    if (dataFim) params.append('dataFim', dataFim);

    const container = document.getElementById('fechamentosConteudo');
    if (!container) return;
    container.innerHTML = '<p>Carregando...</p>';

    try {
        const res = await apiFetch(`${BACKEND_BASE}/caixa/fechamentos?${params.toString()}`);
        if (!res.ok) throw new Error('Erro ao buscar fechamentos');
        const data = await res.json();
        if (!data.success) throw new Error('Dados indisponíveis');
        renderHistoricoFechamentos(data.dados || []);
    } catch (err) {
        console.error('[front] erro ao carregar fechamentos:', err);
        container.innerHTML = '<p>Não foi possível carregar o histórico.</p>';
    }
}

function renderHistoricoFechamentos(dados) {
    const container = document.getElementById('fechamentosConteudo');
    if (!container) return;
    if (!dados.length) {
        container.innerHTML = '<p>Nenhum fechamento encontrado.</p>';
        return;
    }

    const rows = dados.map(item => `
        <tr>
            <td>${formatBrDate(item.data_ref)}</td>
            <td>${formatCurrency(item.total_recebido)}</td>
            <td>${formatCurrency(item.total_dinheiro)}</td>
            <td>${formatCurrency(item.total_credito)}</td>
            <td>${formatCurrency(item.total_debito)}</td>
            <td>${formatCurrency(item.total_pix)}</td>
            <td>${Number(item.total_transacoes || 0)}</td>
            <td>${item.observacao || '-'}</td>
            <td>${formatDateTimeBr(item.criado_em)}</td>
        </tr>
    `).join('');

    container.innerHTML = `
        <table>
            <thead>
                <tr>
                    <th>Data</th>
                    <th>Total</th>
                    <th>Dinheiro</th>
                    <th>Crédito</th>
                    <th>Débito</th>
                    <th>Pix</th>
                    <th>Transações</th>
                    <th>Observação</th>
                    <th>Criado em</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
}

///////////////////////////
// turnos de caixa
///////////////////////////
let turnoAtualCache = null;

async function carregarTurnoAtual() {
    try {
        const res = await apiFetch(`${BACKEND_BASE}/caixa/turnos/atual`);
        if (!res.ok) throw new Error('Erro ao buscar turno atual');
        const data = await res.json();
        turnoAtualCache = data?.dados || null;
        renderTurnoStatus(turnoAtualCache);
    } catch (err) {
        console.error('[front] erro ao carregar turno atual:', err);
        renderTurnoStatus(null, true);
    }
}

function renderTurnoStatus(turno, erro = false) {
    const statusEl = document.getElementById('turnoStatus');
    const inicioEl = document.getElementById('turnoInicio');
    if (!statusEl || !inicioEl) return;

    if (erro) {
        statusEl.textContent = 'Indisponível';
        inicioEl.textContent = 'Falha ao carregar turno';
        return;
    }

    if (!turno) {
        statusEl.textContent = 'Fechado';
        inicioEl.textContent = 'Sem turno aberto';
        return;
    }

    statusEl.textContent = 'Aberto';
    inicioEl.textContent = `Iniciado: ${formatDateTimeBr(turno.aberto_em)}`;
}

async function abrirTurnoCaixa() {
    await carregarTurnoAtual();
    renderTurnoPopup();
    openPopup('turnoCaixaPopup');
}

function renderTurnoPopup() {
    const resumo = document.getElementById('turnoResumo');
    const abrirBtn = document.getElementById('confirmarAberturaTurnoBtn');
    const fecharBtn = document.getElementById('confirmarFechamentoTurnoBtn');

    if (!resumo || !abrirBtn || !fecharBtn) return;

    if (turnoAtualCache) {
        resumo.innerHTML = `
            <h4>Turno Aberto</h4>
            <p><span>Início</span><strong>${formatDateTimeBr(turnoAtualCache.aberto_em)}</strong></p>
            <p><span>Data Ref</span><strong>${formatBrDate(turnoAtualCache.data_ref)}</strong></p>
        `;
        abrirBtn.disabled = true;
        fecharBtn.disabled = false;
    } else {
        resumo.innerHTML = `
            <h4>Turno Fechado</h4>
            <p>Nenhum turno aberto no momento.</p>
        `;
        abrirBtn.disabled = false;
        fecharBtn.disabled = true;
    }
}

async function confirmarAberturaTurno() {
    const observacao = document.getElementById('turnoObservacao')?.value?.trim() || '';
    if (turnoAtualCache) {
        notify('Já existe um turno aberto.', 'error');
        return;
    }

    try {
        const res = await apiFetch(`${BACKEND_BASE}/caixa/turnos/abrir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ observacao })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            notify(data.error || 'Erro ao abrir turno', 'error');
            return;
        }
        document.getElementById('turnoObservacao').value = '';
        await carregarTurnoAtual();
        renderTurnoPopup();
        notify('Turno aberto com sucesso.', 'success');
    } catch (err) {
        console.error('[front] erro ao abrir turno:', err);
        notify('Falha ao abrir turno.', 'error');
    }
}

async function confirmarFechamentoTurno() {
    const observacao = document.getElementById('turnoObservacao')?.value?.trim() || '';
    if (!turnoAtualCache) {
        notify('Nenhum turno aberto para fechar.', 'error');
        return;
    }
    if (!confirm('Confirma o fechamento do turno atual?')) return;

    try {
        const res = await apiFetch(`${BACKEND_BASE}/caixa/turnos/fechar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ turno_id: turnoAtualCache.id, observacao })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            notify(data.error || 'Erro ao fechar turno', 'error');
            return;
        }
        document.getElementById('turnoObservacao').value = '';
        closePopup('turnoCaixaPopup');
        await carregarTurnoAtual();
        notify('Turno fechado com sucesso.', 'success');
    } catch (err) {
        console.error('[front] erro ao fechar turno:', err);
        notify('Falha ao fechar turno.', 'error');
    }
}

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

async function gerarRelatorioCaixa() {
    const dataInicio = document.getElementById('dataInicioCaixa').value;
    const dataFim = document.getElementById('dataFimCaixa').value;
    
    if (!dataInicio && !dataFim) {
        alert('Selecione pelo menos uma data');
        return;
    }
    
    try {
        // Converte para formato brasileiro
        const params = new URLSearchParams();
        if (dataInicio) {
            const [ano, mes, dia] = dataInicio.split('-');
            params.append('dataInicio', `${dia}/${mes}/${ano}`);
        }
        if (dataFim) {
            const [ano, mes, dia] = dataFim.split('-');
            params.append('dataFim', `${dia}/${mes}/${ano}`);
        }
        
        const res = await apiFetch(`${BACKEND_BASE}/caixa/relatorio?${params}`);
        if (!res.ok) throw new Error('Erro ao gerar relatório');
        
        const data = await res.json();
        
        if (!data.success || !data.dados) {
            document.getElementById('relatorioCaixaConteudo').innerHTML = '<p>Erro ao gerar relatório</p>';
            return;
        }
        
        // Agrupa por data e calcula totais
        const porData = {};
        let totalGeral = 0;
        let totalDinheiro = 0;
        let totalCredito = 0;
        let totalDebito = 0;
        let totalPix = 0;
        let totalTransacoes = 0;
        
        data.dados.forEach(item => {
            if (!porData[item.data_saida]) {
                porData[item.data_saida] = { total: 0, formas: {} };
            }
            const itemTotal = Number(item.total || 0);
            const itemQtd = Number(item.quantidade || 0);
            const formaLabel = normalizeFormaPagamento(item.forma_pagamento) || 'Não informado';
            porData[item.data_saida].total += itemTotal;

            if (!porData[item.data_saida].formas[formaLabel]) {
                porData[item.data_saida].formas[formaLabel] = {
                    data_saida: item.data_saida,
                    forma_pagamento: formaLabel,
                    quantidade: 0,
                    total: 0
                };
            }
            porData[item.data_saida].formas[formaLabel].quantidade += itemQtd;
            porData[item.data_saida].formas[formaLabel].total += itemTotal;

            totalGeral += itemTotal;
            totalTransacoes += itemQtd;

            if (formaLabel === 'Dinheiro') totalDinheiro += itemTotal;
            if (formaLabel === 'Cartão de Crédito') totalCredito += itemTotal;
            if (formaLabel === 'Cartão de Débito') totalDebito += itemTotal;
            if (formaLabel === 'Pix') totalPix += itemTotal;
        });
        
        // Gera HTML do relatório
        let html = `
            <div class="resumo-financeiro">
                <div class="resumo-card">
                    <h4>Total Recebido</h4>
                    <p>R$ ${totalGeral.toFixed(2)}</p>
                </div>
                <div class="resumo-card">
                    <h4>Transações</h4>
                    <p>${totalTransacoes}</p>
                </div>
                <div class="resumo-card">
                    <h4>💵 Dinheiro</h4>
                    <p>R$ ${totalDinheiro.toFixed(2)}</p>
                </div>
                <div class="resumo-card">
                    <h4>💳 Crédito</h4>
                    <p>R$ ${totalCredito.toFixed(2)}</p>
                </div>
                <div class="resumo-card">
                    <h4>💳 Débito</h4>
                    <p>R$ ${totalDebito.toFixed(2)}</p>
                </div>
                <div class="resumo-card">
                    <h4>📱 Pix</h4>
                    <p>R$ ${totalPix.toFixed(2)}</p>
                </div>
            </div>
            
            <h4>Detalhamento por Data</h4>
            <table>
                <thead>
                    <tr>
                        <th>Data</th>
                        <th>Forma de Pagamento</th>
                        <th>Quantidade</th>
                        <th>Total (R$)</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        Object.keys(porData).sort().reverse().forEach(data => {
            const primeiro = true;
            Object.values(porData[data].formas).forEach(item => {
                html += `
                    <tr>
                        <td>${item.data_saida}</td>
                        <td>${item.forma_pagamento}</td>
                        <td style="text-align:center">${item.quantidade}</td>
                        <td style="text-align:right">R$ ${Number(item.total).toFixed(2)}</td>
                    </tr>
                `;
            });
        });
        
        html += `
                </tbody>
            </table>
        `;
        
        document.getElementById('relatorioCaixaConteudo').innerHTML = html;
        
    } catch (err) {
        console.error('[front] erro ao gerar relatório:', err);
        document.getElementById('relatorioCaixaConteudo').innerHTML = '<p>Erro ao conectar ao servidor</p>';
    }
}
