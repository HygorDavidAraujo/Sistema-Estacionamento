// Configuração: endereço do backend
let BACKEND_BASE = 'http://localhost:3000';

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
    BACKEND_BASE = await detectBackendPort();
    bindUI();
    await loadConfig(); // Aguarda carregamento das configurações do banco
    updatePatioCarList();
    // atualiza tempos no pátio a cada 10s
    setInterval(updatePatioCarList, 10000);
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

///////////////////////////
// backend consulta (via backend com API gratuita)
///////////////////////////
async function consultarPlacaAPI(placa) {
    try {
        console.log('[front] consultando backend ->', `${BACKEND_BASE}/placa/${placa}`);
        const res = await fetch(`${BACKEND_BASE}/placa/${placa}`, { method: 'GET' });
        if (!res.ok) {
            console.error('[front] backend respondeu com erro', res.status);
            return null;
        }
        const data = await res.json();
        console.log('[front] resposta backend:', data);

        if (data.error) {
            console.warn('[front] backend error:', data.error);
            return null;
        }

        if (data.encontrado === false) {
            return {
                marca: data.marca || "Não encontrado",
                modelo: data.modelo || "Não encontrado",
                cor: data.cor || ""
            };
        }

        return {
            marca: data.marca || "",
            modelo: data.modelo || "",
            cor: data.cor || ""
        };

    } catch (e) {
        console.error('[front] erro ao acessar backend:', e);
        return null;
    }
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

    // Se a API encontrou dados, preenche
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

    document.getElementById('printEntradaBtn')?.addEventListener('click', () => printHtml(document.getElementById('comprovanteEntrada').innerHTML));
    document.getElementById('printPermanenciaBtn')?.addEventListener('click', () => printHtml(document.getElementById('comprovantePermanencia').innerHTML));

    document.getElementById('btnRelatorioResumo')?.addEventListener('click', carregarRelatorioResumo);
    document.getElementById('btnHistoricoCompleto')?.addEventListener('click', carregarHistoricoCompleto);
    document.getElementById('btnBuscaPlaca')?.addEventListener('click', buscarPorPlaca);
    document.getElementById('btnAplicarFiltro')?.addEventListener('click', aplicarFiltroData);
    document.getElementById('btnLimparFiltro')?.addEventListener('click', limparFiltro);

    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => closePopupByElement(e.target.closest('.popup'))));

    // input placa => autoFill
    document.getElementById('placaEntrada').addEventListener('input', autoFillVehicleDataAPI);

    document.querySelectorAll('.popup').forEach(p => p.addEventListener('click', e => { if (e.target === p) closePopupByElement(p); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll('.popup[aria-hidden="false"]').forEach(p => closePopupByElement(p)); toggleMenu(false); }});
}

///////////////////////////
// popups
///////////////////////////
function openPopup(id) { const el = document.getElementById(id); if (el) el.setAttribute('aria-hidden','false'); }
function closePopup(id) { const el = document.getElementById(id); if (el) el.setAttribute('aria-hidden','true'); }
function closePopupByElement(el) { if (!el) return; el.setAttribute('aria-hidden','true'); }
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
            
            console.log('[front] Configurações carregadas do banco de dados');
        }
    } catch (err) {
        console.error('[front] Erro ao carregar configurações, usando localStorage:', err);
        // Fallback para localStorage
        const v1 = localStorage.getItem('valorHora') || '5.00';
        const v2 = localStorage.getItem('valorHoraAdicional') || '2.50';
        const tol = localStorage.getItem('toleranciaHoraAdicional') || '15';
        
        document.getElementById('valorHora').value = v1;
        document.getElementById('valorHoraAdicional').value = v2;
        document.getElementById('toleranciaHoraAdicional').value = tol;
    }
}

async function saveConfig() {
    const v1 = document.getElementById('valorHora').value;
    const v2 = document.getElementById('valorHoraAdicional').value;
    const tol = document.getElementById('toleranciaHoraAdicional').value;
    
    if (!v1 || !v2 || !tol) return alert('Preencha todos os campos.');
    
    try {
        // Salva no banco de dados
        const res = await fetch(`${BACKEND_BASE}/configuracoes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                valor_hora_inicial: v1,
                valor_hora_adicional: v2,
                tempo_tolerancia: tol
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
        
        alert('Configurações salvas com sucesso no banco de dados!');
        console.log('[front] Configurações salvas:', data);
        toggleMenu(false);
        
        // Atualiza lista do pátio para refletir novos valores
        updatePatioCarList();
        
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
}

///////////////////////////
// registrar entrada
///////////////////////////
function registrarEntrada() {
    const placa = normalizePlaca(document.getElementById('placaEntrada').value);
    const marca = document.getElementById('marcaEntrada').value.trim();
    const modelo = document.getElementById('modeloEntrada').value.trim();
    const cor = document.getElementById('corEntrada').value.trim();

    if (!isValidPlaca(placa)) { alert('Placa inválida. Use formato AAA1234 ou AAA1A23.'); return; }
    if (!placa || !marca || !modelo) { alert('Placa, marca e modelo são obrigatórios.'); return; }

    const entrada = { placa, marca, modelo, cor, horaEntrada: new Date().toISOString() };

    // Salva no backend (banco de dados)
    fetch(`${BACKEND_BASE}/entrada`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placa, marca, modelo, cor })
    })
    .then(res => res.json())
    .then(data => {
        if (!data.success) {
            alert('Erro ao registrar entrada: ' + (data.error || 'Desconhecido'));
            return;
        }
        
        // salva cache local (vehicleDB) e entrada
        saveVehicleInfo(placa, marca, modelo, cor);
        localStorage.setItem(placa, JSON.stringify(entrada));

        updatePatioCarList();
        clearEntradaForm();
        closePopup('entradaPopup');

        // Busca valores atualizados do banco
        const valorHora = localStorage.getItem('valorHora') || "5.00";
        const valorHoraAdc = localStorage.getItem('valorHoraAdicional') || "2.50";
        const tolerancia = localStorage.getItem('toleranciaHoraAdicional') || "15";

        document.getElementById('comprovanteEntrada').innerHTML = `
            <h3>Comprovante de Entrada</h3>
            <p><b>Placa:</b> ${placa}</p>
            <p><b>Marca:</b> ${marca}</p>
            <p><b>Modelo:</b> ${modelo}</p>
            <p><b>Cor:</b> ${cor}</p>
            <p><b>Entrada:</b> ${new Date(entrada.horaEntrada).toLocaleString()}</p>
            <p><b>1ª Hora:</b> R$ ${valorHora}</p>
            <p><b>Hora Adicional:</b> R$ ${valorHoraAdc}</p>
            <p><b>Tolerância:</b> ${tolerancia} min</p>
        `;
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
function calcularPermanencia() {
    const placa = normalizePlaca(document.getElementById('placaSaida').value);
    if (!placa) return alert('Informe a placa.');
    if (!isValidPlaca(placa)) return alert('Placa inválida. Use formato AAA1234 ou AAA1A23.');
    const data = localStorage.getItem(placa);
    if (!data) return alert('Veículo não encontrado.');
    const entrada = JSON.parse(data);
    const horaEntrada = new Date(entrada.horaEntrada), horaSaida = new Date();
    const ms = diffMs(horaEntrada, horaSaida);
    const tempoFormatado = formatDuration(ms);
    const totalMin = Math.floor(ms / 60000);

    const valorHora = parseFloat(localStorage.getItem('valorHora')) || 0;
    const valorHoraAd = parseFloat(localStorage.getItem('valorHoraAdicional')) || 0;
    const tolerancia = parseInt(localStorage.getItem('toleranciaHoraAdicional')) || 0;

    let total = 0;
    if (totalMin <= 60) total = valorHora;
    else {
        const exced = totalMin - 60;
        if (exced <= tolerancia) total = valorHora;
        else total = valorHora + Math.ceil(exced/60) * valorHoraAd;
    }

    document.getElementById('comprovantePermanencia').innerHTML = `
      <h3>Comprovante de Permanência</h3>
      <p><b>Placa:</b> ${entrada.placa}</p>
      <p><b>Entrada:</b> ${horaEntrada.toLocaleString()}</p>
      <p><b>Saída:</b> ${horaSaida.toLocaleString()}</p>
      <p><b>Tempo:</b> ${tempoFormatado}</p>
      <p><b>Valor:</b> R$ ${Number(total).toFixed(2)}</p>
    `;
    
    // Registra saída no backend (banco de dados)
    fetch(`${BACKEND_BASE}/saida`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            placa, 
            valor_pago: total, 
            tempo_permanencia: tempoFormatado 
        })
    })
    .then(res => res.json())
    .then(data => {
        if (!data.success) {
            console.warn('[front] aviso ao registrar saída:', data.error);
        }
        localStorage.removeItem(placa);
        updatePatioCarList();
        openPopup('comprovantePermanenciaPopup');
        document.getElementById('placaSaida').value = '';
    })
    .catch(err => {
        console.error('[front] erro ao registrar saída:', err);
        alert('Erro ao registrar saída no servidor, mas comprovante foi gerado');
        localStorage.removeItem(placa);
        updatePatioCarList();
        openPopup('comprovantePermanenciaPopup');
        document.getElementById('placaSaida').value = '';
    });
}

///////////////////////////
// update list
///////////////////////////
function updatePatioCarList() {
    const patio = document.getElementById('patioCarList');
    if (!patio) return;
    patio.innerHTML = '';
    const ignore = ['valorHora','valorHoraAdicional','toleranciaHoraAdicional','vehicleDB'];
    Object.keys(localStorage).forEach(k => {
        if (ignore.includes(k)) return;
        try {
            const ent = JSON.parse(localStorage.getItem(k));
            if (!ent || !ent.horaEntrada) return;
            const inicio = new Date(ent.horaEntrada), agora = new Date();
            const ms = diffMs(inicio, agora);
            const tempo = formatDuration(ms);
            const totalMin = Math.floor(ms / 60000);
            
            // Calcula valor devido
            const valorHora = parseFloat(localStorage.getItem('valorHora')) || 0;
            const valorHoraAd = parseFloat(localStorage.getItem('valorHoraAdicional')) || 0;
            const tolerancia = parseInt(localStorage.getItem('toleranciaHoraAdicional')) || 0;
            
            let valorDevido = 0;
            if (totalMin <= 60) valorDevido = valorHora;
            else {
                const exced = totalMin - 60;
                if (exced <= tolerancia) valorDevido = valorHora;
                else valorDevido = valorHora + Math.ceil(exced/60) * valorHoraAd;
            }
            
            const div = document.createElement('div');
            div.className = 'car-item';
            div.innerHTML = `<p><b>Placa:</b> ${ent.placa}</p>
                             <p><b>Marca:</b> ${ent.marca}</p>
                             <p><b>Modelo:</b> ${ent.modelo}</p>
                             <p><b>Cor:</b> ${ent.cor}</p>
                             <p><b>Tempo no Pátio:</b> ${tempo}</p>
                             <p><b>Valor Devido:</b> <span class="valor-devido">R$ ${valorDevido.toFixed(2)}</span></p>`;
            patio.appendChild(div);
        } catch(e){ /* ignora chaves inválidas */ }
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

///////////////////////////
// histórico e relatórios
///////////////////////////
function carregarRelatorioResumo() {
    fetch(`${BACKEND_BASE}/relatorio/resumo`)
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
            let html = '<h4>Histórico Completo</h4><table><tr><th>Placa</th><th>Marca/Modelo</th><th>Entrada</th><th>Saída</th><th>Tempo</th><th>Valor</th><th>Status</th></tr>';
            data.dados.forEach(row => {
                html += `<tr>
                    <td>${row.placa}</td>
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
    
    if (!dia && !mes && !ano) {
        alert('Selecione pelo menos um filtro (dia, mês ou ano)');
        return;
    }
    
    const filtros = {};
    if (dia) filtros.dia = dia;
    if (mes) filtros.mes = mes;
    if (ano) filtros.ano = ano;
    
    carregarHistoricoCompleto(filtros);
}

function limparFiltro() {
    document.getElementById('filtroDia').value = '';
    document.getElementById('filtroMes').value = '';
    document.getElementById('filtroAno').value = '';
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
            let html = '<h4>Histórico da Placa: ' + placaNorm + '</h4><table><tr><th>Data Entrada</th><th>Hora Entrada</th><th>Data Saída</th><th>Hora Saída</th><th>Tempo</th><th>Valor</th><th>Status</th></tr>';
            data.dados.forEach(row => {
                html += `<tr>
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
