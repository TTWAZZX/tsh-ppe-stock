(function initializeVendorLoader(global) {
    'use strict';

    const pending = new Map();

    function loadScriptOnce(key, source, ready, timeoutMs = 15000) {
        if (ready()) return Promise.resolve();
        if (pending.has(key)) return pending.get(key);

        const promise = new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-ppe-vendor="${key}"]`);
            const script = existing || document.createElement('script');
            let timeoutId;

            const cleanup = () => {
                clearTimeout(timeoutId);
                script.removeEventListener('load', handleLoad);
                script.removeEventListener('error', handleError);
            };
            const handleLoad = () => {
                cleanup();
                if (ready()) resolve();
                else reject(new Error(`${key} loaded without exposing its API`));
            };
            const handleError = () => {
                cleanup();
                reject(new Error(`Unable to load ${key}`));
            };

            script.addEventListener('load', handleLoad, { once: true });
            script.addEventListener('error', handleError, { once: true });
            timeoutId = setTimeout(handleError, timeoutMs);

            if (!existing) {
                script.src = source;
                script.async = true;
                script.dataset.ppeVendor = key;
                document.head.appendChild(script);
            }
        }).catch(error => {
            pending.delete(key);
            throw error;
        });

        pending.set(key, promise);
        return promise;
    }

    global.PpeVendorLoader = Object.freeze({
        async loadChart() {
            await loadScriptOnce('chart', '/vendor/chart/chart.umd.js', () => typeof global.Chart === 'function');
            return global.Chart;
        },
        async loadLiff() {
            await loadScriptOnce('liff', 'https://static.line-scdn.net/liff/edge/2/sdk.js', () => Boolean(global.liff));
            return global.liff;
        },
        isLoaded(key) {
            return key === 'chart' ? typeof global.Chart === 'function' : key === 'liff' ? Boolean(global.liff) : false;
        },
    });
})(window);
