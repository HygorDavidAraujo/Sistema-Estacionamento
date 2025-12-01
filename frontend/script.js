document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    loadConfig();
    updatePatioCarList();
});

/////////////////////////////////////////////////////
// FUNÇÕES DE TEMPO
/////////////////////////////////////////////////////

function diffMs(start, end) {
    return end.getTime() - start.getTime();
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);

    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');

    return `${h}:${m}:${s}`;
}

/////////////////////////////////////////////////////
// CONSULTA AO BACKEND (BRASILAPI)
/////////////////////////////////////////////////////

async function consultarPlacaAPI(placa) {
    try {
        const response = await fetch(`http://localhost:3000/placa/${placa}`);
        const data = await response.json();

        // Se placa não foi encontrada na BrasilAPI
        if (!data.encontrado) {
            return {
                marca: "Não encontrado",
                modelo: "Não encontrado",
                cor: ""
            };
        }

        return {
            marca: data.marca || "",
            modelo: data.modelo || "",
            cor: data.cor || ""
        };

    } catch (e) {
        console.error("Erro ao acessar backend:", e);
        return null;
    }
}

/////////////////////////////////////////////////////
// BANCO INTERNO EM LOCALSTORAGE
/////////////////////////////////////////////////////

function saveVehicleInfo(placa, marca, modelo, cor) {
    const dbRaw = localStorage.getItem('vehicleDB');
    let db = dbRaw ? JSON.parse(dbRaw) : {};

    db[placa] = { marca, modelo, cor };

    localStorage.setItem('vehicleDB', JSON.stringify(db));
}

function getVehicleInfo(placa) {
    const dbRaw = localStorage.getItem('vehicleDB');
    if (!dbRaw) return null;
    const db = JSON.parse(dbRaw);
    return db[placa] || null;
}

/////////////////////////////////////////////////////
// AUTOPREENCHIMENTO DE DADOS DO VEÍCULO
/////////////////////////////////////////////////////

async function autoFillVehicleDataAPI() {
    const placa = normalizePlaca(document.getElementById('placaEntrada').value);

    if (placa.length < 7) return;

    // Primeiro tenta o banco interno
    const localInfo = getVehicleInfo(placa);
    if (localInfo) {
        document.getElementById('marcaEntrada').value = localInfo.marca;
        document.getElementById('modeloEntrada').value = localInfo.modelo;
        document.getElementById('corEntrada').value = localInfo.cor;
        return;
    }

    // Depois tenta a API
    const apiInfo = await consultarPlacaAPI(placa);

    if (apiInfo) {
        document.getElementById('marcaEntrada').value = apiInfo.marca;
        document.getElementById('modeloEntrada').value = apiInfo.modelo;
        document.getElementById('corEntrada').value = apiInfo.cor;

        // Mesmo se for "Não encontrado", salva para não consultar novamente
        saveVehicleInfo(placa, apiInfo.marca, apiInfo.modelo, apiInfo.cor);
    }
}

/////////////////////////////////////////////////////
// INTERFACE E EVENTOS
/////////////////////////////////////////////////////

function bindUI() {
    document.getElementById('btnEntrada').onclick = () => openPopup('entradaPopup');
    document.getElementById('btnSaida').onclick = () => openPopup('saidaPopup');
    document.getElementById('btnMenu').onclick = () => toggleMenu(true);

    document.getElementById('registrarBtn').onclick = registrarEntrada;
    document.getElementById('calcularBtn').onclick = calcularPermanencia;
    document.getElementById('saveConfigBtn').onclick = saveConfig;

    document.getElementById('printEntradaBtn').onclick = () =>
        printHtml(document.getElementById('comprovanteEntrada').innerHTML);

    document.getElementById('printPermanenciaBtn').onclick = () =>
        printHtml(document.getElementById('comprovantePermanencia').innerHTML);

    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.onclick = e => closePopupByElement(e.target.closest('.popup'));
    });

    document.getElementById('placaEntrada')
        .addEventListener('input', autoFillVehicleDataAPI);

    document.querySelectorAll('.popup').forEach(p => {
        p.onclick = e => {
            if (e.target === p) closePopupByElement(p);
        };
    });

    document.onkeydown = e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.popup[aria-hidden="false"]')
                .forEach(p => closePopupByElement(p));
            toggleMenu(false);
        }
    };
}

/////////////////////////////////////////////////////
// POPUPS E MENU
/////////////////////////////////////////////////////

function openPopup(id) {
    document.getElementById(id).setAttribute('aria-hidden', 'false');
}

function closePopup(id) {
    document.getElementById(id).setAttribute('aria-hidden', 'true');
}

function closePopupByElement(el) {
    el.setAttribute('aria-hidden', 'true');
}

function toggleMenu(show) {
    document.getElementById('menu')
        .setAttribute('aria-hidden', show ? 'false' : 'true');
}

/////////////////////////////////////////////////////
// CONFIGURAÇÕES
/////////////////////////////////////////////////////

function loadConfig() {
    const v1 = localStorage.getItem('valorHora');
    const v2 = localStorage.getItem('valorHoraAdicional');
    const tol = localStorage.getItem('toleranciaHoraAdicional');

    if (v1) document.getElementById('valorHora').value = v1;
    if (v2) document.getElementById('valorHoraAdicional').value = v2;
    if (tol) document.getElementById('toleranciaHoraAdicional').value = tol;
}

function saveConfig() {
    const v1 = document.getElementById('valorHora').value.trim();
    const v2 = document.getElementById('valorHoraAdicional').value.trim();
    const tol = document.getElementById('toleranciaHoraAdicional').value.trim();

    if (!v1 || !v2 || !tol) return alert("Preencha todos os campos.");

    localStorage.setItem('valorHora', v1);
    localStorage.setItem('valorHoraAdicional', v2);
    localStorage.setItem('toleranciaHoraAdicional', tol);

    alert("Configurações salvas.");
    toggleMenu(false);
}

/////////////////////////////////////////////////////
// UTILITÁRIOS
/////////////////////////////////////////////////////

function normalizePlaca(p) {
    return p.replace(/\s+/g, '').toUpperCase();
}

/////////////////////////////////////////////////////
// REGISTRO DE ENTRADA
/////////////////////////////////////////////////////

function registrarEntrada() {
    const placa = normalizePlaca(document.getElementById('placaEntrada').value);
    const marca = document.getElementById('marcaEntrada').value.trim();
    const modelo = document.getElementById('modeloEntrada').value.trim();
    const cor = document.getElementById('corEntrada').value.trim();

    if (!placa || !marca || !modelo || !cor)
        return alert("Preencha todos os campos corretamente.");

    const entrada = {
        placa,
        marca,
        modelo,
        cor,
        horaEntrada: new Date().toISOString()
    };

    saveVehicleInfo(placa, marca, modelo, cor);

    localStorage.setItem(placa, JSON.stringify(entrada));

    updatePatioCarList();
    closePopup('entradaPopup');

    const valorHora = localStorage.getItem('valorHora') || "0";
    const valorHoraAdc = localStorage.getItem('valorHoraAdicional') || "0";
    const tolerancia = localStorage.getItem('toleranciaHoraAdicional') || "0";

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
}

/////////////////////////////////////////////////////
// CÁLCULO DE PERMANÊNCIA
/////////////////////////////////////////////////////

function calcularPermanencia() {
    const placa = normalizePlaca(document.getElementById('placaSaida').value);

    if (!placa) return alert("Informe a placa.");

    const data = localStorage.getItem(placa);
    if (!data) return alert("Veículo não encontrado.");

    const entrada = JSON.parse(data);

    const horaEntrada = new Date(entrada.horaEntrada);
    const horaSaida = new Date();

    const ms = diffMs(horaEntrada, horaSaida);
    const tempoFormatado = formatDuration(ms);

    const totalMin = Math.floor(ms / 60000);

    const valorHora = parseFloat(localStorage.getItem('valorHora')) || 0;
    const valorHoraAdc = parseFloat(localStorage.getItem('valorHoraAdicional')) || 0;
    const tolerancia = parseInt(localStorage.getItem('toleranciaHoraAdicional')) || 0;

    let total = 0;

    if (totalMin <= 60) {
        total = valorHora;
    } else {
        const exced = totalMin - 60;

        if (exced <= tolerancia) {
            total = valorHora;
        } else {
            const horasExtras = Math.ceil(exced / 60);
            total = valorHora + horasExtras * valorHoraAdc;
        }
    }

    document.getElementById('comprovantePermanencia').innerHTML = `
        <h3>Comprovante de Permanência</h3>
        <p><b>Placa:</b> ${entrada.placa}</p>
        <p><b>Entrada:</b> ${horaEntrada.toLocaleString()}</p>
        <p><b>Saída:</b> ${horaSaida.toLocaleString()}</p>
        <p><b>Tempo Total:</b> ${tempoFormatado}</p>
        <p><b>Valor Pago:</b> R$ ${total.toFixed(2)}</p>
    `;

    openPopup('comprovantePermanenciaPopup');

    localStorage.removeItem(placa);

    updatePatioCarList();
}

/////////////////////////////////////////////////////
// LISTA DE CARROS NO PÁTIO
/////////////////////////////////////////////////////

function updatePatioCarList() {
    const patio = document.getElementById('patioCarList');
    patio.innerHTML = "";

    const ignore = ["valorHora", "valorHoraAdicional", "toleranciaHoraAdicional", "vehicleDB"];

    Object.keys(localStorage).forEach(key => {
        if (ignore.includes(key)) return;

        try {
            const entrada = JSON.parse(localStorage.getItem(key));

            if (!entrada.horaEntrada) return;

            const inicio = new Date(entrada.horaEntrada);
            const agora = new Date();
            const ms = diffMs(inicio, agora);
            const tempo = formatDuration(ms);

            const div = document.createElement('div');
            div.className = "car-item";
            div.innerHTML = `
                <p><b>Placa:</b> ${entrada.placa}</p>
                <p><b>Marca:</b> ${entrada.marca}</p>
                <p><b>Modelo:</b> ${entrada.modelo}</p>
                <p><b>Cor:</b> ${entrada.cor}</p>
                <p><b>Tempo no Pátio:</b> ${tempo}</p>
            `;
            patio.appendChild(div);

        } catch {}
    });
}

/////////////////////////////////////////////////////
// IMPRESSÃO
/////////////////////////////////////////////////////

function printHtml(html) {
    const w = window.open("", "_blank", "width=600,height=600");
    w.document.write(`
        <html>
        <head><title>Impressão</title></head>
        <body>${html}</body>
        </html>
    `);
    w.document.close();
    setTimeout(() => {
        w.print();
        w.close();
    }, 300);
}
