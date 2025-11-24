document.addEventListener('DOMContentLoaded', (event) => {
    loadConfig();
    updatePatioCarList();
});

// Handle opening and closing of popups
function openEntradaPopup() {
    document.getElementById('entradaPopup').style.display = 'block';
}

function openSaidaPopup() {
    document.getElementById('saidaPopup').style.display = 'block';
}

function closePopup(popupId) {
    document.getElementById(popupId).style.display = 'none';
}

// Handle opening and closing of menu
function openMenu() {
    document.getElementById('menu').style.display = 'block';
}

function closeMenu() {
    document.getElementById('menu').style.display = 'none';
}

// Save configurations
function saveConfig() {
    const valorHora = parseFloat(document.getElementById('valorHora').value.replace(',', '.'));
    const valorHoraAdicional = parseFloat(document.getElementById('valorHoraAdicional').value.replace(',', '.'));
    const toleranciaHoraAdicional = parseInt(document.getElementById('toleranciaHoraAdicional').value, 10);

    if (isNaN(valorHora) || isNaN(valorHoraAdicional) || isNaN(toleranciaHoraAdicional)) {
        alert('Por favor, insira valores válidos nas configurações.');
        return;
    }

    localStorage.setItem('valorHora', valorHora);
    localStorage.setItem('valorHoraAdicional', valorHoraAdicional);
    localStorage.setItem('toleranciaHoraAdicional', toleranciaHoraAdicional);

    alert('Configurações salvas com sucesso!');
    closeMenu();
}

// Load configurations
function loadConfig() {
    const valorHora = localStorage.getItem('valorHora');
    const valorHoraAdicional = localStorage.getItem('valorHoraAdicional');
    const toleranciaHoraAdicional = localStorage.getItem('toleranciaHoraAdicional');

    if (valorHora !== null) {
        document.getElementById('valorHora').value = valorHora.replace('.', ',');
    }
    if (valorHoraAdicional !== null) {
        document.getElementById('valorHoraAdicional').value = valorHoraAdicional.replace('.', ',');
    }
    if (toleranciaHoraAdicional !== null) {
        document.getElementById('toleranciaHoraAdicional').value = toleranciaHoraAdicional;
    }
}

// Register vehicle entry
function registrarEntrada() {
    const placa = document.getElementById('placaEntrada').value;
    const marca = document.getElementById('marcaEntrada').value;
    const modelo = document.getElementById('modeloEntrada').value;
    const cor = document.getElementById('corEntrada').value;

    if (!placa || !marca || !modelo || !cor) {
        alert('Por favor, preencha todos os campos para registrar a entrada.');
        return;
    }

    const entrada = {
        placa,
        marca,
        modelo,
        cor,
        horaEntrada: new Date().toISOString()
    };

    localStorage.setItem(placa, JSON.stringify(entrada));

    alert('Entrada registrada com sucesso!');
    closePopup('entradaPopup');
    updatePatioCarList();

    // Gerar o comprovante de entrada
    const valorHora = parseFloat(localStorage.getItem('valorHora')) || 0;
    const valorHoraAdicional = parseFloat(localStorage.getItem('valorHoraAdicional')) || 0;
    const toleranciaHoraAdicional = parseInt(localStorage.getItem('toleranciaHoraAdicional'), 10) || 0;

    const comprovanteHTML = `
        <p>Placa: ${placa}</p>
        <p>Marca: ${marca}</p>
        <p>Modelo: ${modelo}</p>
        <p>Cor: ${cor}</p>
        <p>Data de Entrada: ${new Date(entrada.horaEntrada).toLocaleString()}</p>
        <p>Valor da Primeira Hora: R$ ${valorHora.toFixed(2)}</p>
        <p>Valor da Hora Adicional: R$ ${valorHoraAdicional.toFixed(2)}</p>
        <p>Tolerância para Hora Adicional: ${toleranciaHoraAdicional > 0 ? toleranciaHoraAdicional + ' minutos' : 'Sem tolerância'}</p>
    `;

    document.getElementById('comprovanteEntrada').innerHTML = comprovanteHTML;
    document.getElementById('comprovanteEntradaPopup').style.display = 'block';
}

function printComprovante() {
    const printContents = document.getElementById('comprovanteEntrada').innerHTML;
    const originalContents = document.body.innerHTML;

    document.body.innerHTML = printContents;
    window.print();
    document.body.innerHTML = originalContents;
    location.reload();  // Reload the page to restore event listeners
}

// Calculate parking duration and cost
function calcularPermanencia() {
    const placa = document.getElementById('placaSaida').value;

    const entrada = JSON.parse(localStorage.getItem(placa));
    if (!entrada) {
        alert('Nenhuma entrada encontrada para a placa fornecida.');
        return;
    }

    const horaEntrada = new Date(entrada.horaEntrada);
    const horaSaida = new Date();
    const diffMs = horaSaida - horaEntrada;
    const diffHrs = diffMs / 3600000;

    const valorHora = parseFloat(localStorage.getItem('valorHora'));
    const valorHoraAdicional = parseFloat(localStorage.getItem('valorHoraAdicional'));
    const toleranciaHoraAdicional = parseInt(localStorage.getItem('toleranciaHoraAdicional'), 10);

    let valorTotal;
    if (diffHrs <= 1) {
        valorTotal = valorHora;
    } else {
        const additionalHours = Math.ceil(diffHrs - 1);
        valorTotal = valorHora + additionalHours * valorHoraAdicional;
    }

    document.getElementById('dadosVeiculo').innerHTML = `
        <p>Placa: ${entrada.placa}</p>
        <p>Marca: ${entrada.marca}</p>
        <p>Modelo: ${entrada.modelo}</p>
        <p>Cor: ${entrada.cor}</p>
    `;
    document.getElementById('permanenciaValor').innerHTML = `
        <p>Hora de Entrada: ${horaEntrada.toLocaleString()}</p>
        <p>Hora de Saída: ${horaSaida.toLocaleString()}</p>
        <p>Total de Horas: ${diffHrs.toFixed(2)}</p>
        <p>Valor a Pagar: R$ ${valorTotal.toFixed(2)}</p>
    `;

    // Gerar o comprovante de permanência
    const comprovanteHTML = `
        <p>Placa: ${entrada.placa}</p>
        <p>Marca: ${entrada.marca}</p>
        <p>Modelo: ${entrada.modelo}</p>
        <p>Cor: ${entrada.cor}</p>
        <p>Hora de Entrada: ${horaEntrada.toLocaleString()}</p>
        <p>Hora de Saída: ${horaSaida.toLocaleString()}</p>
        <p>Tempo de Permanência: ${(diffMs / 3600000).toFixed(2)} horas</p>
        <p>Valor Total a Pagar: R$ ${valorTotal.toFixed(2)}</p>
    `;

    document.getElementById('comprovantePermanencia').innerHTML = comprovanteHTML;
    document.getElementById('comprovantePermanenciaPopup').style.display = 'block';

    document.getElementById('imprimirPopup').style.display = 'block';
    closePopup('saidaPopup');

    // Remove car from local storage after calculating permanência
    localStorage.removeItem(placa);
    updatePatioCarList();
}

function printComprovantePermanencia() {
    const printContents = document.getElementById('comprovantePermanencia').innerHTML;
    const originalContents = document.body.innerHTML;

    document.body.innerHTML = printContents;
    window.print();
    document.body.innerHTML = originalContents;
    location.reload();  // Reload the page to restore event listeners
}

// Update the list of cars in the patio
function updatePatioCarList() {
    const patioCarList = document.getElementById('patioCarList');
    patioCarList.innerHTML = ''; // Clear current list

    Object.keys(localStorage).forEach(key => {
        const entrada = JSON.parse(localStorage.getItem(key));
        if (entrada && entrada.horaEntrada) {
            const horaEntrada = new Date(entrada.horaEntrada);
            const horaAtual = new Date();
            const diffMs = horaAtual - horaEntrada;
            const diffHrs = diffMs / 3600000;

            const carInfo = document.createElement('div');
            carInfo.innerHTML = `
                <p>Placa: ${entrada.placa}</p>
                <p>Marca: ${entrada.marca}</p>
                <p>Modelo: ${entrada.modelo}</p
                <p>Cor: ${entrada.cor}</p>
                <p>Horas no Pátio: ${diffHrs.toFixed(2)}</p>
            `;
            patioCarList.appendChild(carInfo);
        }
    });
}
