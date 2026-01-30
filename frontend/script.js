// Configuração: endereço do backend
const IS_LOCAL_ENV = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:';
let BACKEND_BASE = window.BACKEND_BASE || (IS_LOCAL_ENV ? 'http://localhost:3000' : `${location.origin}/api`);

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
    StorageService.migrateLegacyEntries?.();
    bindUI();
    await loadConfig(); // Aguarda carregamento das configurações do banco
    carregarDashboard(); // Carrega dashboard de vagas
    carregarDashboardCaixa(); // Carrega dashboard de caixa
    updatePatioCarList();
    // atualiza tempos no pátio, dashboard vagas e caixa a cada 10s
    setInterval(() => {
        updatePatioCarList();
        carregarDashboard();
        carregarDashboardCaixa();
    }, 10000);
});

///////////////////////////
// util tempo
///////////////////////////
function diffMs(start, end) { return end.getTime() - start.getTime(); }
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2,'0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2,'0');
    const s = String(totalSeconds % 60).padStart(2,'0');
    return `${h}:${m}:${s}`;
}

function calcularValoresPermanencia(horaEntradaISO, horaSaida = new Date()) {
    const horaEntrada = new Date(horaEntradaISO);
    const ms = diffMs(horaEntrada, horaSaida);
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
    const { tempoFormatado, total, horaEntrada } = calcularValoresPermanencia(entry.horaEntrada, horaSaida);
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

///////////////////////////
// captura de placa via câmera
///////////////////////////
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
        await CameraService.startPreview(videoEl, { video: { facingMode: 'environment' } });
        statusEl.textContent = 'Centralize a placa e toque em Capturar.';
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

    statusEl.textContent = 'Capturando imagem...';
    try {
        const blob = await CameraService.captureBlob(videoEl);
        statusEl.textContent = 'Reconhecendo placa...';
        const placa = await PlateService.recognizePlateFromImage(blob);
        if (placa) {
            document.getElementById('placaEntrada').value = placa;
            statusEl.textContent = `Placa detectada: ${placa}`;
            autoFillVehicleDataAPI();
            setTimeout(fecharCameraEntrada, 600);
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

function tratarQrCodeSaida(payload) {
    let entryId = payload;
    let plateFromPayload = '';
    try {
        const parsed = JSON.parse(payload);
        entryId = parsed.entryId || parsed.id || parsed.entry_id || payload;
        plateFromPayload = parsed.placa || parsed.plate || '';
    } catch (e) {
        // payload não é JSON, usa texto puro
    }

    const entry = StorageService.getEntryById(entryId) || StorageService.getEntryByPlate(plateFromPayload);
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

    document.getElementById('registrarBtn').onclick = registrarEntrada;
    document.getElementById('calcularBtn').onclick = calcularPermanencia;
    document.getElementById('saveConfigBtn').onclick = saveConfig;

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
    document.getElementById('btnGerarRelatorioCaixa')?.addEventListener('click', gerarRelatorioCaixa);
    document.getElementById('confirmarPagamentoBtn')?.addEventListener('click', confirmarPagamento);

    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => closePopupByElement(e.target.closest('.popup'))));

    // input placa => autoFill
    document.getElementById('placaEntrada').addEventListener('input', autoFillVehicleDataAPI);

    const mensalistaCheck = document.getElementById('mensalistaCheck');
    const diaristaCheck = document.getElementById('diaristaCheck');
    const mensalistaFields = document.getElementById('mensalistaFields');

    const syncMensalistaUI = () => {
        if (mensalistaCheck?.checked) {
            if (diaristaCheck) diaristaCheck.checked = false;
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

///////////////////////////
// config
///////////////////////////
async function loadConfig() {
    try {
        // Carrega do banco de dados
        const res = await fetch(`${BACKEND_BASE}/configuracoes`);
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
        const res = await fetch(`${BACKEND_BASE}/configuracoes`, {
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
        const entradaAnterior = new Date(existingEntry.horaEntrada).toLocaleString();
        alert(`Este veículo já está no pátio desde ${entradaAnterior}. Não é possível registrar novamente.`);
        return;
    }

    const entrada = {
        entryId: StorageService.generateEntryId(),
        placa,
        marca,
        modelo,
        cor,
        horaEntrada: new Date().toISOString(),
        mensalista,
        diarista,
        cliente_nome: clienteNome,
        cliente_telefone: clienteTelefone,
        cliente_cpf: clienteCpf
    };

    // Salva no backend (banco de dados)
    fetch(`${BACKEND_BASE}/entrada`, {
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

        document.getElementById('comprovanteEntrada').innerHTML = `
            <h3>Comprovante de Entrada</h3>
            <p><b>ID da Entrada:</b> ${entrada.entryId}</p>
            <p><b>Placa:</b> ${placa}</p>
            <p><b>Marca:</b> ${marca}</p>
            <p><b>Modelo:</b> ${modelo}</p>
            <p><b>Cor:</b> ${cor}</p>
            <p><b>Tipo:</b> ${mensalista ? 'Mensalista' : diarista ? 'Diária' : 'Avulso'}</p>
            ${mensalista ? `<p><b>Cliente:</b> ${clienteNome}</p>` : ''}
            ${mensalista ? `<p><b>Telefone:</b> ${clienteTelefone}</p>` : ''}
            ${mensalista ? `<p><b>CPF:</b> ${clienteCpf}</p>` : ''}
            <p><b>Entrada:</b> ${new Date(entrada.horaEntrada).toLocaleString()}</p>
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
        openPopup('pagamentoPopup');
    } else {
        processarSaida(null);
    }
}

///////////////////////////
function calcularPermanencia() {
    const placa = normalizePlaca(document.getElementById('placaSaida').value);
    if (!placa) return alert('Informe a placa.');
    if (!isValidPlaca(placa)) return alert('Placa inválida. Use formato AAA1234 ou AAA1A23.');
    const entrada = StorageService.getEntryByPlate(placa);
    if (!entrada) return alert('Veículo não encontrado.');
    prepararPagamento(entrada);
}

///////////////////////////
// confirmar pagamento
///////////////////////////
function confirmarPagamento() {
    const formaPagamento = document.getElementById('formaPagamento').value;
    
    if (!formaPagamento) {
        alert('Selecione a forma de pagamento');
        return;
    }
    
    processarSaida(formaPagamento);
}

///////////////////////////
// processar saída (após pagamento)
///////////////////////////
function processarSaida(formaPagamento) {
    const dados = window.dadosPagamento;
    
    if (!dados) {
        alert('Dados de pagamento não encontrados');
        return;
    }
    
    // Registra saída no backend
    fetch(`${BACKEND_BASE}/saida`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            placa: dados.placa, 
            entryId: dados.entryId,
            valor_pago: dados.valor, 
            tempo_permanencia: dados.tempo,
            forma_pagamento: formaPagamento
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
            ${formaPagamento ? `<p><b>Forma de Pagamento:</b> ${formaPagamento}</p>` : ''}
            <p style="margin-top:20px;font-size:12px;color:#666;">Obrigado pela preferência!</p>
        `;
        
        // Fecha modal de pagamento e abre comprovante
        closePopup('pagamentoPopup');
        openPopup('comprovantePermanenciaPopup');
        
        // Limpa formulários
        document.getElementById('placaSaida').value = '';
        document.getElementById('formaPagamento').value = '';
        
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
        const res = await fetch(`${BACKEND_BASE}/dashboard`);
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
                         <button class="btn-saida-card" data-entry-id="${ent.entryId}">Registrar Saída</button>`;
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

function formatTipoRegistro(row) {
    if (row?.mensalista) return 'Mensalista';
    if (row?.diarista) return 'Diária';
    return 'Avulso';
}

///////////////////////////
// histórico e relatórios
///////////////////////////
function carregarRelatorioResumo() {
    const tipo = document.getElementById('filtroTipo')?.value || '';
    const params = new URLSearchParams();
    if (tipo) params.append('tipo', tipo);
    const url = params.toString() ? `${BACKEND_BASE}/relatorio/resumo?${params}` : `${BACKEND_BASE}/relatorio/resumo`;
    fetch(url)
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
                <p><b>Receita Total:</b> R$ ${(r.receita_total || 0).toFixed(2)}</p>
                <p><b>Valor Médio por Saída:</b> R$ ${(r.valor_medio || 0).toFixed(2)}</p>
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
    
    fetch(url)
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
                    <td>R$ ${(row.valor_pago || 0).toFixed(2)}</td>
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
    fetch(`${BACKEND_BASE}/historico/${placaNorm}`)
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
        const res = await fetch(`${BACKEND_BASE}/caixa/dashboard`);
        if (!res.ok) throw new Error('Erro ao carregar dashboard de caixa');
        
        const data = await res.json();
        if (data.success && data.dados) {
            const { total_recebido, total_dinheiro, total_credito, total_debito, total_pix, total_transacoes } = data.dados;
            
            // Atualiza valores no dashboard (mantém mascarados se estiver oculto)
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
        }
    } catch (err) {
        console.error('[front] Erro ao carregar dashboard de caixa:', err);
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
        
        const res = await fetch(`${BACKEND_BASE}/caixa/relatorio?${params}`);
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
            porData[item.data_saida].total += item.total;
            porData[item.data_saida].formas[item.forma_pagamento] = item;
            
            totalGeral += item.total;
            totalTransacoes += item.quantidade;
            
            if (item.forma_pagamento === 'Dinheiro') totalDinheiro += item.total;
            if (item.forma_pagamento === 'Cartão de Crédito') totalCredito += item.total;
            if (item.forma_pagamento === 'Cartão de Débito') totalDebito += item.total;
            if (item.forma_pagamento === 'Pix') totalPix += item.total;
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
