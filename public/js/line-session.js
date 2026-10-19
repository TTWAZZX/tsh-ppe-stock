(function initializeLineSession(global) {
    'use strict';

    const PRESERVED_QUERY_KEYS = ['mode', 'voucherId', 'loanId', 'module'];

    function buildLiffRestartUrl(liffId, currentUrl, moduleName = 'dashboard') {
        const sourceUrl = new URL(currentUrl);
        const restartUrl = new URL(`https://liff.line.me/${encodeURIComponent(liffId)}`);

        PRESERVED_QUERY_KEYS.forEach(key => {
            const value = sourceUrl.searchParams.get(key);
            if (value) restartUrl.searchParams.set(key, value);
        });

        if (!restartUrl.searchParams.has('module') && moduleName) {
            restartUrl.searchParams.set('module', moduleName);
        }

        return restartUrl.toString();
    }

    function restartAuthentication({ liffSdk, liffId, currentUrl, moduleName, navigate }) {
        const isInLiffClient = Boolean(liffSdk.isInClient?.());

        if (liffSdk.isLoggedIn?.()) liffSdk.logout();

        if (isInLiffClient) {
            const restartUrl = buildLiffRestartUrl(liffId, currentUrl, moduleName);
            navigate(restartUrl);
            return { method: 'liff-url', url: restartUrl };
        }

        liffSdk.login({ redirectUri: currentUrl });
        return { method: 'line-login', url: currentUrl };
    }

    global.PpeLineSession = Object.freeze({
        buildLiffRestartUrl,
        restartAuthentication,
    });
})(window);
