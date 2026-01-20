(function() {
    function resolveElement(target) {
        if (!target) return null;
        if (typeof target === 'string') return document.getElementById(target);
        return target;
    }

    function render(target, payload, options = {}) {
        const el = resolveElement(target);
        if (!el) throw new Error('Elemento de QR Code não encontrado');
        if (!window.QRCode) throw new Error('Biblioteca QRCode.js não carregada');
        el.innerHTML = '';
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const size = options.size || 180;
        new QRCode(el, {
            text,
            width: size,
            height: size,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
        return text;
    }

    function clear(target) {
        const el = resolveElement(target);
        if (!el) return;
        el.innerHTML = '';
    }

    window.QRCodeService = { render, clear };
})();
