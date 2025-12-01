document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    loadConfig();
    updatePatioCarList();
});

//////////////////////////////
// FUNÇÕES BASE DE TEMPO
//////////////////////////////

// Diferença precisa em ms
function diffMs(start, end) {
    return end.getTime() - start.getTime();
}

// Converte ms → HH:MM:SS
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);

    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');

    return `${h}:${m}:${s}`;
}

//////////////////////////////
// INTERFACE
//////////////////////////////

function bindUI() {
    document.getElementById('btnEntrada').onclick = () => openPopup('entradaPopup');
    document.getElementById('btnSaida').onclick = () => openPopup('saidaPopup');
    document.getElementById('btnMenu').onclick = () => toggleMenu(true);

    document.getElementById('registrarBtn').onclick = registrarEntrada;
    document.getElementById('calcularBtn').onclick = calcularPermanencia;

    document.getElementById('saveConfigBtn').onclick = saveConfig;

    document.getElementById('printEntradaBtn').onclick = () => printHtml(document.getElementById('comprovanteEntrada').innerHTML);
    document.getElementById('printPermanenciaBtn').onclick = () => printHtml(document.getElementById('comprovantePermanencia').innerHTML);

    document.getElementById('imprimirComprovanteBtn').onclick = () => {
        const html =
            document.getElementById('dadosVeiculo').innerHTML +
            document.getElementById('permanenciaValor').innerHTML;
        printHtml(html);
    };

    document.querySelectorAll('[data-close]').forEach(btn => {
        btn.onclick = (e) => {
            closePopupByElement(e.target.closest('.popup'));
        };
    });

    document.querySelectorAll('.popup').forEach(p => {
        p.onclick = (e) => {
            if (e.target === p) closePopupByElement(p);
        };
    });

    document.onkeydown = (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.popup[aria-hidden="false"]').forEach(p => closePopupByElement(p));
            toggleMenu(false);
        }
    };
}

//////////////////////////////
// POPUPS
//////////////////////////////

function openPopup(id) {
    const p = document.getElementById(id);
    p.setAttribute('aria-hidden', 'false');
}

function closePopup(id) {
    document.getElementById(id).setAttribute('aria-hidden', 'true');
}

function closePopupByElement(el) {
    el.setAttribute('aria-hidden', 'true');
}

function toggleMenu(show) {
    const menu = document.getElementById('menu');
    menu.setAttribute('aria-hidden', show ? 'false' : 'true');
}

//////////////////////////////
// CONFIGURAÇÕES
//////////////////////////////

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

//////////////////////////////
// NORMALIZAÇÃO
//////////////////////////////

function normalizePlaca(p) {
    return p.replace(/\s+/g, '').toUpperCase();
}

//////////////////////////////
// REGISTRAR ENTRADA
//////////////////////////////

function registrarEntrada() {
    const placa = normalizePlaca(document.getElementById('placaEntrada').value);
    const marca = document.getElementById('marcaEntrada').value;
    const modelo = document.getElementById('modeloEntrada').value.trim();
    const cor = document.getElementById('corEntrada').value.trim();

    if (!placa || !marca || !modelo || !cor) {
        return alert("Preencha todos os campos.");
    }

    const entrada = {
        placa,
        marca,
        modelo,
        cor,
        horaEntrada: new Date().toISOString()
    };

    localStorage.setItem(placa, JSON.stringify(entrada));

    updatePatioCarList();
    closePopup('entradaPopup');

    const valorHora = localStorage.getItem('valorHora') || "0";
    const valorHoraAdicional = localStorage.getItem('valorHoraAdicional') || "0";
    const tolerancia = localStorage.getItem('toleranciaHoraAdicional') || "0";

    document.getElementById('comprovanteEntrada').innerHTML = `
        <div>
            <h3>Comprovante de Entrada</h3>
            <p><b>Placa:</b> ${placa}</p>
            <p><b>Marca:</b> ${marca}</p>
            <p><b>Modelo:</b> ${modelo}</p>
            <p><b>Cor:</b> ${cor}</p>
            <p><b>Entrada:</b> ${new Date(entrada.horaEntrada).toLocaleString()}</p>
            <p><b>1ª Hora:</b> R$ ${valorHora}</p>
            <p><b>Hora Adicional:</b> R$ ${valorHoraAdicional}</p>
            <p><b>Tolerância:</b> ${tolerancia} min</p>
        </div>
    `;

    openPopup('comprovanteEntradaPopup');
}

//////////////////////////////
// CÁLCULO PERMANÊNCIA
//////////////////////////////

function calcularPermanencia() {
    const placa = normalizePlaca(document.getElementById('placaSaida').value);

    if (!placa) return alert("Informe a placa.");

    const data = localStorage.getItem(placa);
    if (!data) return alert("Nenhum registro encontrado.");

    const entrada = JSON.parse(data);

    const horaEntrada = new Date(entrada.horaEntrada);
    const horaSaida = new Date();

    const ms = diffMs(horaEntrada, horaSaida);
    const tempoFormatado = formatDuration(ms);

    const totalMinutos = Math.floor(ms / 60000);

    const valorHora = parseFloat(localStorage.getItem('valorHora')) || 0;
    const valorHoraAdicional = parseFloat(localStorage.getItem('valorHoraAdicional')) || 0;
    const tolerancia = parseInt(localStorage.getItem('toleranciaHoraAdicional')) || 0;

    let valorTotal = 0;

    if (totalMinutos <= 60) {
        valorTotal = valorHora;
    } else {
        const excedentes = totalMinutos - 60;

        if (excedentes <= tolerancia) {
            valorTotal = valorHora;
        } else {
            const horasExtras = Math.ceil(excedentes / 60);
            valorTotal = valorHora + horasExtras * valorHoraAdicional;
        }
    }

    document.getElementById('dadosVeiculo').innerHTML = `
        <p><b>Placa:</b> ${entrada.placa}</p>
        <p><b>Marca:</b> ${entrada.marca}</p>
        <p><b>Modelo:</b> ${entrada.modelo}</p>
        <p><b>Cor:</b> ${entrada.cor}</p>
    `;

    document.getElementById('permanenciaValor').innerHTML = `
        <p><b>Entrada:</b> ${horaEntrada.toLocaleString()}</p>
        <p><b>Saída:</b> ${horaSaida.toLocaleString()}</p>
        <p><b>Tempo Total:</b> ${tempoFormatado}</p>
        <p><b>Valor a Pagar:</b> R$ ${valorTotal.toFixed(2)}</p>
    `;

    document.getElementById('comprovantePermanencia').innerHTML = `
        <div>
            <h3>Comprovante de Permanência</h3>
            <p><b>Placa:</b> ${entrada.placa}</p>
            <p><b>Tempo Total:</b> ${tempoFormatado}</p>
            <p><b>Valor Pago:</b> R$ ${valorTotal.toFixed(2)}</p>
        </div>
    `;

    openPopup('imprimirPopup');
    openPopup('comprovantePermanenciaPopup');

    localStorage.removeItem(placa);

    updatePatioCarList();
}

//////////////////////////////
// LISTAGEM PÁTIO
//////////////////////////////

function updatePatioCarList() {
    const patio = document.getElementById('patioCarList');
    patio.innerHTML = "";

    const configKeys = ["valorHora", "valorHoraAdicional", "toleranciaHoraAdicional"];

    Object.keys(localStorage).forEach(key => {
        if (configKeys.includes(key)) return;

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

        } catch (e) {}
    });
}

//////////////////////////////
// IMPRESSÃO
//////////////////////////////

function printHtml(html) {
    const w = window.open("", "PRINT", "width=400,height=600");
    w.document.write(`
        <html><head><title>Imprimir</title></head>
        <body>${html}</body></html>
    `);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
}
