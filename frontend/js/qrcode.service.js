(function() {
    let loadPromise = null;
    const CDN_PRIMARY = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    const CDN_FALLBACK = 'https://unpkg.com/qrcodejs@1.0.0/qrcode.min.js';

    function resolveElement(target) {
        if (!target) return null;
        if (typeof target === 'string') return document.getElementById(target);
        return target;
    }

    function injectScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Falha ao carregar ' + src));
            document.head.appendChild(s);
        });
    }

    function ensureLibLoaded() {
        if (window.QRCode) return Promise.resolve();
        if (!loadPromise) {
            loadPromise = injectScript(CDN_PRIMARY).catch(() => injectScript(CDN_FALLBACK));
        }
        return loadPromise.then(() => {
            if (!window.QRCode) throw new Error('Biblioteca QRCode.js não carregada');
        });
    }

    function render(target, payload, options = {}) {
        const el = resolveElement(target);
        if (!el) return Promise.reject(new Error('Elemento de QR Code não encontrado'));
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const size = options.size || 180;
        el.innerHTML = '';

        return ensureLibLoaded()
            .then(() => {
                new QRCode(el, {
                    text,
                    width: size,
                    height: size,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
                return text;
            })
            .catch(err => {
                console.error('[QRCodeService] Erro ao gerar QR:', err);
                el.innerHTML = '<small>QR Code indisponível</small>';
                return null;
            });
    }

    function clear(target) {
        const el = resolveElement(target);
        if (!el) return;
        el.innerHTML = '';
    }

    window.QRCodeService = { render, clear };
})();
