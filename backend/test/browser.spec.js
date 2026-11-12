import { test, expect } from '@playwright/test';

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        console.log('Estado da consulta:', await page.evaluate(() => ({
            placa: document.getElementById('placaEntrada')?.value,
            status: document.getElementById('vehicleLookupStatus')?.textContent,
            modelo: document.getElementById('modeloEntrada')?.value,
            sequence: vehicleLookupSequence
        })).catch(() => ({})));
    }
});

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { window.BACKEND_BASE = 'http://127.0.0.1:3108'; });
    await page.goto('/');
    await expect(page.locator('#connectionStatus')).toHaveText('Sincronizado');
});

test('consulta preenche os três campos e mantém dados do veículo atual', async ({ page }) => {
    await expect(page.locator('#totalVagas')).toHaveText('50');
    await page.screenshot({ path: '../artifacts/central-operacao.png', animations: 'disabled', fullPage: true });
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'abc1d23');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO A');
    await expect(page.locator('#marcaEntrada')).toHaveValue('MARCA TESTE');
    await expect(page.locator('#corEntrada')).toHaveValue('Cinza');
    await page.fill('#placaEntrada', 'DEF4G56');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO B');
    await page.fill('#marcaEntrada', 'Revisado manualmente');
    await page.click('#refreshPlateBtn');
    await page.waitForTimeout(800);
    await expect(page.locator('#marcaEntrada')).toHaveValue('MARCA TESTE');
});

test('edição manual feita durante a consulta é preservada', async ({ page }) => {
    await page.route('**/placa/ABC1D23', async route => {
        await new Promise(resolve => setTimeout(resolve, 800));
        await route.fulfill({ json: { encontrado: true, marca: 'Fornecedor', modelo: 'Modelo', cor: 'Cinza' } });
    });
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'ABC1D23');
    await expect(page.locator('#vehicleLookupStatus')).toContainText('Consultando');
    await page.fill('#marcaEntrada', 'Marca revisada');
    await expect(page.locator('#modeloEntrada')).toHaveValue('Modelo');
    await expect(page.locator('#marcaEntrada')).toHaveValue('Marca revisada');
});

test('resposta antiga e fechamento do formulário não alteram cadastro atual', async ({ page }) => {
    let requested;
    const ready = new Promise(resolve => { requested = resolve; });
    await page.route('**/placa/ABC1D23', async route => {
        requested();
        await new Promise(resolve => setTimeout(resolve, 1600));
        await route.fulfill({ json: { encontrado: true, marca: 'ANTIGO', modelo: 'ANTIGO', cor: 'Azul' } }).catch(() => {});
    });
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'ABC1D23');
    await ready;
    await page.fill('#placaEntrada', 'DEF4G56');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO B');
    await page.waitForTimeout(1800);
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO B');
    await page.fill('#placaEntrada', 'GHI7J89');
    await page.locator('#entradaPopup [data-close]').click();
    await page.waitForTimeout(700);
    await expect(page.locator('#vehicleLookupStatus')).not.toHaveAttribute('data-state', 'loading');
});

test('cota indisponível permite atendimento manual sem alertas bloqueantes', async ({ page }) => {
    await page.route('**/placa/ABC1D23', route => route.fulfill({ status: 429, json: { status: 'quota_exceeded', mensagem: 'Cota esgotada. Preencha manualmente.' } }));
    await page.click('#btnEntrada');
    await page.fill('#placaEntrada', 'ABC1D23');
    await expect(page.locator('#vehicleLookupStatus')).toContainText('Cota esgotada');
    await expect(page.locator('#registrarBtn')).toBeEnabled();
});

test('câmera inicia, fecha e cancela leituras pendentes', async ({ page }) => {
    await page.evaluate(() => {
        window.__terminated = 0;
        window.__started = false;
        // Vídeo sintético local: não depende da câmera física do computador.
        navigator.mediaDevices.getUserMedia = async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 1280; canvas.height = 720;
            const context = canvas.getContext('2d');
            const draw = () => { context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000'; context.font = '100px monospace'; context.fillText('ABC1D23', 300, 400); };
            const stream = canvas.captureStream(10);
            const interval = setInterval(draw, 100);
            stream.getTracks()[0].addEventListener('ended', () => clearInterval(interval));
            draw();
            return stream;
        };
        window.Tesseract = { createWorker: async () => ({ setParameters: async () => {}, recognize: () => { window.__started = true; return new Promise(() => {}); }, terminate: async () => { window.__terminated++; } }) };
    });
    await page.click('#btnEntrada');
    await page.click('#scanPlacaBtn');
    await expect(page.locator('#entradaCameraStatus')).toContainText('Centralize');
    await page.click('#capturarPlacaBtn');
    await expect.poll(() => page.evaluate(() => window.__started)).toBe(true);
    await page.click('#fecharCameraEntradaBtn');
    await expect(page.locator('#cameraEntradaContainer')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.evaluate(() => document.getElementById('entradaCameraPreview').srcObject)).toBeNull();
    await expect.poll(() => page.evaluate(() => window.__terminated)).toBe(1);
});

test('OCR real lê foto de teste e exige confirmação antes de preencher a entrada', async ({ page }) => {
    await page.click('#btnEntrada');
    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1200; canvas.height = 260;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 1200, 260);
        context.fillStyle = '#000'; context.font = 'bold 150px monospace';
        context.textAlign = 'center'; context.fillText('ABC1D23', 600, 185);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#platePhotoInput', { name: 'placa-teste.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await expect(page.locator('#plateDetectedInput')).toHaveValue('ABC1D23', { timeout: 35000 });
    await expect(page.locator('#placaEntrada')).toHaveValue('');
    await page.click('#acceptPlateBtn');
    await expect(page.locator('#placaEntrada')).toHaveValue('ABC1D23');
    await expect(page.locator('#modeloEntrada')).toHaveValue('VEÍCULO A');
});

test('layout móvel mantém formulário e ações acessíveis sem rolagem horizontal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#btnEntrada');
    await expect(page.locator('#scanPlacaBtn')).toBeVisible();
    await expect(page.locator('label[for="platePhotoInput"]')).toBeVisible();
    const width = await page.evaluate(() => ({ screen: innerWidth, content: document.documentElement.scrollWidth }));
    expect(width.content).toBeLessThanOrEqual(width.screen);
    await page.screenshot({ path: '../artifacts/entrada-mobile.png', animations: 'disabled' });
});
