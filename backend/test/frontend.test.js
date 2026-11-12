import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../../frontend/js/${name}`, import.meta.url), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
function ocrContext(tesseract) {
    const context = vm.createContext({ window: { Tesseract: tesseract }, console: quiet, setTimeout, clearTimeout, DOMException });
    vm.runInContext(read('ocr.service.js'), context);
    return context.window.OcrService;
}

test('OCR reconhece minúsculas, placa antiga e placa de moto sem absorver palavras', () => {
    const service = ocrContext();
    assert.equal(service.extractCandidates('abc1d23')[0], 'ABC1D23');
    assert.equal(service.extractCandidates('ABC-1234')[0], 'ABC1234');
    assert.equal(service.extractCandidates('ABC\n1D23')[0], 'ABC1D23');
    assert.equal(service.extractCandidates('BRASIL ABC1D23')[0], 'ABC1D23');
    assert.equal(service.extractCandidates('XABC1D23Y').length, 0);
});

test('Tesseract recebe idioma correto, recupera falha e reaproveita worker', async () => {
    let calls = 0;
    const service = ocrContext({ createWorker: async (language, mode, options) => {
        assert.equal(language, 'eng');
        assert.equal(mode, 1);
        assert.equal(typeof options.logger, 'function');
        calls++;
        if (calls === 1) throw Error('offline');
        return { setParameters: async () => {}, recognize: async () => ({ data: { text: 'ABC1D23', confidence: 92 } }), terminate: async () => {} };
    } });
    await assert.rejects(service.recognizePlateFromImage({}), /offline/);
    assert.equal((await service.recognizePlateFromImage({})).placa, 'ABC1D23');
    assert.equal((await service.recognizePlateFromImage({})).confianca, 0.92);
    assert.equal(calls, 2);
});

test('cancelamento termina worker e libera o próximo reconhecimento', async () => {
    let terminated = 0;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const service = ocrContext({ createWorker: async () => ({
        setParameters: async () => {}, recognize: () => { started(); return new Promise(() => {}); }, terminate: async () => { terminated++; }
    }) });
    const controller = new AbortController();
    const pending = service.recognizePlateFromImage({}, { signal: controller.signal });
    await ready;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(terminated, 1);
});

test('fechar câmera durante autorização descarta o stream tardio', async () => {
    let grant;
    let stopped = 0;
    const context = vm.createContext({ window: { isSecureContext: true }, location: { hostname: 'localhost' },
        navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } }, DOMException, setTimeout, clearTimeout });
    vm.runInContext(read('camera.service.js'), context);
    const video = { setAttribute() {}, srcObject: null };
    const pending = context.window.CameraService.startPreview(video);
    context.window.CameraService.stopPreview(video);
    grant({ getTracks: () => [{ stop: () => stopped++ }] });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(video.srcObject, null);
    assert.equal(stopped, 1);
    context.window.CameraService.stopAll();
});

test('área da moldura é convertida para pixels originais com object-fit cover', () => {
    const context = vm.createContext({ window: {} });
    vm.runInContext(read('plate-camera.js'), context);
    const crop = context.window.PlateCamera.cropGeometry(
        { videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({ width: 480, height: 300, left: 0, top: 0 }) },
        { getBoundingClientRect: () => ({ width: 384, height: 80, left: 48, top: 110 }) }
    );
    assert.ok(crop.width > 1300);
    assert.ok(crop.width < 1500);
    assert.ok(crop.x >= 0 && crop.x + crop.width <= 1920);
});
