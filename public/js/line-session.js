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

        if (isInLiffClient) {
            // liff.login() cannot be used inside the LIFF browser. Re-enter the
            // LIFF URL instead so liff.init() performs its automatic login and
            // token validation again. A nonce prevents LINE's recent-app resume
            // behavior from restoring the same stale page state.
            const restartUrlObject = new URL(buildLiffRestartUrl(liffId, currentUrl, moduleName));
            restartUrlObject.searchParams.set('reauth', String(Date.now()));
            const restartUrl = restartUrlObject.toString();
            navigate(restartUrl);
            return { method: 'liff-url', url: restartUrl };
        }

        if (liffSdk.isLoggedIn?.()) liffSdk.logout();
        liffSdk.login({ redirectUri: currentUrl });
        return { method: 'line-login', url: currentUrl };
    }

    global.PpeLineSession = Object.freeze({
        buildLiffRestartUrl,
        restartAuthentication,
    });
})(window);
