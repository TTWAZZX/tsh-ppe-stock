import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
const baseOrigin = new URL(baseUrl).origin;
const moduleIds = [
  'dashboardPage', 'stockPage', 'issuePage', 'loanPage', 'allHistoryPage',
  'pendingPage', 'managePage', 'receivePage', 'reportPage', 'notificationsPage', 'matrixPage',
];
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = [];
    const pageErrors = [];
    const failedFirstPartyRequests = [];
    const responses = [];

    page.on('console', message => {
      if (message.type() !== 'error') return;
      const sourceUrl = message.location().url || '';
      if (!sourceUrl || sourceUrl.startsWith(baseOrigin)) consoleErrors.push(message.text());
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => {
      if (request.url().startsWith(baseOrigin)) failedFirstPartyRequests.push(`${request.method()} ${request.url()}`);
    });
    page.on('response', response => responses.push({ url: response.url(), status: response.status() }));

    await page.goto(`${baseUrl}?productionQa=${viewport.width}#stock`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    const initialResources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    assert.ok(initialResources.some(url => url.endsWith('/css/app.css')), `${viewport.name} should load compiled CSS`);
    assert.ok(initialResources.some(url => url.includes('/vendor/fontawesome/css/all.min.css')), `${viewport.name} should load local icons`);
    assert.equal(initialResources.some(url => /cdn\.tailwindcss|fonts\.googleapis|cdnjs\.cloudflare|cdn\.jsdelivr/.test(url)), false, `${viewport.name} should not use presentation CDNs`);
    assert.equal(initialResources.some(url => url.includes('/vendor/chart/chart.umd.js')), false, `${viewport.name} stock should not preload Chart.js`);
    assert.equal(initialResources.some(url => url.includes('static.line-scdn.net/liff')), false, `${viewport.name} local mode should not load LIFF`);

    for (const moduleId of moduleIds) {
      const layout = await page.evaluate(id => {
        document.querySelectorAll('.page').forEach(module => module.classList.add('hidden'));
        const target = document.getElementById(id);
        target.classList.remove('hidden');
        target.style.position = 'relative';
        window.applySharedComponentStyles?.(target);
        const main = document.getElementById('mainContent');
        const shell = target.querySelector(':scope > .module-shell');
        return {
          found: Boolean(shell),
          viewportOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          mainOverflow: main.scrollWidth > main.clientWidth + 1,
          shellOverflow: shell ? shell.scrollWidth > shell.clientWidth + 1 : false,
        };
      }, moduleId);
      assert.equal(layout.found, true, `${viewport.name} ${moduleId} should retain module shell`);
      assert.equal(layout.viewportOverflow, false, `${viewport.name} ${moduleId} viewport overflow`);
      assert.equal(layout.mainOverflow, false, `${viewport.name} ${moduleId} main overflow`);
      assert.equal(layout.shellOverflow, false, `${viewport.name} ${moduleId} shell overflow`);
    }

    await page.evaluate(() => window.PpeVendorLoader.loadChart());
    await page.waitForFunction(() => typeof window.Chart === 'function');
    const finalResources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
    assert.equal(finalResources.filter(url => url.includes('/vendor/chart/chart.umd.js')).length, 1, `${viewport.name} should lazy-load Chart.js exactly once`);

    const badFirstPartyResponses = responses.filter(response => response.url.startsWith(baseOrigin) && response.status >= 400);
    assert.deepEqual(pageErrors, [], `${viewport.name} page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `${viewport.name} console errors: ${consoleErrors.join(' | ')}`);
    assert.deepEqual(failedFirstPartyRequests, [], `${viewport.name} failed requests: ${failedFirstPartyRequests.join(' | ')}`);
    assert.deepEqual(badFirstPartyResponses, [], `${viewport.name} bad responses: ${JSON.stringify(badFirstPartyResponses)}`);

    console.log(`PASS ${viewport.name}: ${moduleIds.length} modules, local assets, clean first-party console/network`);
    await page.close();
  }
} finally {
  await browser.close();
}
