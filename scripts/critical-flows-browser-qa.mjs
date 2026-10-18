import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
const origin = new URL(baseUrl).origin;
const userModules = ['dashboard', 'stock', 'issue', 'loan', 'allHistory', 'matrix'];
const adminModules = ['pending', 'manage', 'receive', 'report', 'notifications'];
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && (!message.location().url || message.location().url.startsWith(origin))) {
        consoleErrors.push(message.text());
      }
    });
    page.on('requestfailed', request => {
      if (request.url().startsWith(origin)) failedRequests.push(`${request.method()} ${request.url()}`);
    });

    await page.goto(`${baseUrl}?criticalFlowQa=${viewport.width}#dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('splashScreen')?.classList.contains('hidden'), null, { timeout: 20000 });

    for (const moduleName of userModules) {
      await page.evaluate(name => window.showPage(name), moduleName);
      await page.waitForTimeout(120);
      const state = await page.evaluate(name => {
        const pageNode = document.getElementById(`${name}Page`);
        const target = name === 'allHistory' ? document.getElementById('allHistoryPage') : pageNode;
        return {
          visible: Boolean(target && !target.classList.contains('hidden')),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      }, moduleName);
      assert.equal(state.visible, true, `${viewport.name} ${moduleName} should be visible`);
      assert.equal(state.overflow, false, `${viewport.name} ${moduleName} should not overflow`);
    }

    for (const moduleName of adminModules) {
      await page.evaluate(name => {
        document.querySelectorAll('.page').forEach(node => node.classList.add('hidden'));
        document.getElementById(`${name}Page`)?.classList.remove('hidden');
      }, moduleName);
      await page.waitForTimeout(120);
      const state = await page.evaluate(name => {
        const target = document.getElementById(`${name}Page`);
        return {
          visible: Boolean(target && !target.classList.contains('hidden') && getComputedStyle(target).display !== 'none'),
          shell: Boolean(target?.querySelector(':scope > .module-shell')),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      }, moduleName);
      assert.equal(state.visible, true, `${viewport.name} ${moduleName} should be visible`);
      assert.equal(state.shell, true, `${viewport.name} ${moduleName} should keep module shell`);
      assert.equal(state.overflow, false, `${viewport.name} ${moduleName} should not overflow`);
    }

    await page.evaluate(() => {
      document.querySelectorAll('.page').forEach(node => node.classList.add('hidden'));
      document.getElementById('receivePage')?.classList.remove('hidden');
    });
    await page.evaluate(() => document.querySelector('input[name="receiveTypeOption"][value="return"]')?.click());
    assert.equal(await page.locator('#receiveType').inputValue(), 'return', `${viewport.name} receive type should be keyboard/click operable`);

    await page.evaluate(() => {
      document.querySelectorAll('.page').forEach(node => node.classList.add('hidden'));
      document.getElementById('reportPage')?.classList.remove('hidden');
    });
    await page.locator('#reportTabTransactions').click();
    assert.equal(await page.locator('#reportTransactionsPanel').isVisible(), true, `${viewport.name} report tab should switch panels`);

    await page.evaluate(() => {
      isAdmin = true;
      updateAdminUI();
      showPage('stock');
      filterStock();
    });
    const editStockButton = page.locator('#stockGrid button[onclick^="editItem"]').first();
    await editStockButton.click();
    assert.equal(await page.locator('#managePage').isVisible(), true, `${viewport.name} stock edit should open manage page`);
    assert.notEqual(await page.locator('#editItemId').inputValue(), '', `${viewport.name} stock edit should select an item`);
    assert.notEqual(await page.locator('#itemName').inputValue(), '', `${viewport.name} stock edit should populate the form`);
    assert.equal(await page.locator('#itemCode').isEditable(), false, `${viewport.name} PPE code should be read-only`);
    assert.match(await page.locator('#itemCodeStatus').innerText(), /^รหัสเดิม PPE\d+$/i, `${viewport.name} edit mode should identify the locked code`);

    await page.evaluate(() => resetManageForm());
    assert.match(await page.locator('#itemCode').inputValue(), /^PPE\d{3,}$/i, `${viewport.name} create mode should preview the next PPE code`);
    assert.match(await page.locator('#itemCodeStatus').innerText(), /^รหัสถัดไป PPE\d+$/i, `${viewport.name} create mode should expose code progress to admin`);

    await page.evaluate(() => window.showToast('QA auto-dismiss', 'success', { duration: 120 }));
    assert.equal(await page.getByText('QA auto-dismiss').isVisible(), true, `${viewport.name} toast should be visible initially`);
    await page.waitForTimeout(550);
    assert.equal(await page.getByText('QA auto-dismiss').count(), 0, `${viewport.name} toast should dismiss automatically`);

    await page.evaluate(() => window.PpeObservability.showFatal(new Error('QA synthetic failure')));
    assert.equal(await page.locator('#fatalErrorFallback').isVisible(), true, `${viewport.name} fatal fallback should be visible`);
    assert.equal(await page.locator('#fatalErrorFallback button').evaluate(element => element === document.activeElement), true, `${viewport.name} fatal fallback should move focus`);
    await page.evaluate(() => {
      const fallback = document.getElementById('fatalErrorFallback');
      fallback.classList.add('hidden');
      fallback.setAttribute('aria-hidden', 'true');
    });

    assert.deepEqual(pageErrors, [], `${viewport.name} page errors: ${pageErrors.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `${viewport.name} console errors: ${consoleErrors.join(' | ')}`);
    assert.deepEqual(failedRequests, [], `${viewport.name} failed requests: ${failedRequests.join(' | ')}`);
    console.log(`PASS ${viewport.name}: critical user/admin navigation, controls, fallback, no overflow`);
    await page.close();
  }
} finally {
  await browser.close();
}
