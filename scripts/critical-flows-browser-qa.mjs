import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
const origin = new URL(baseUrl).origin;
const isLocalQa = ['localhost', '127.0.0.1'].includes(new URL(baseUrl).hostname);
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
    if (isLocalQa) {
      await page.route(origin + '/api/ppe', async route => {
        const { action } = route.request().postDataJSON();
        if (action !== 'getInitialData') return route.continue();
        // Local browser QA has no LINE login. Supply a verified employee fixture
        // at the browser boundary without enabling an authorization bypass in the app.
        await route.fulfill({ json: { status: 'success', data: {
          isAdmin: false,
          accessStatus: 'authorized',
          employee: { employeeId: 'QA-001', name: 'QA Employee', department: 'QA' },
          ppeItems: [{ id: 1, code: 'PPE001', name: 'QA Helmet', stock: 5, reorderPoint: 1, unit: 'unit', category: 'Safety' }],
          categories: [{ id: 1, name: 'Safety' }],
          departments: [{ id: 1, name: 'QA' }],
          nextPpeCode: 'PPE002',
        } } });
      });
    }
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

    if (isLocalQa) await checkApprovalNotifications(viewport);
  }
} finally {
  await browser.close();
}

async function checkApprovalNotifications(viewport) {
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const counts = { issues: 2, employees: 1, messages: 1 };
  let admin = true;
  const actions = [];
  await page.clock.install();
  await page.route(origin + '/api/ppe', async route => {
    const { action } = route.request().postDataJSON();
    actions.push(action);
    const responses = {
      getAdminSession: { authenticated: admin },
      getInitialData: {
        isAdmin: admin, accessStatus: 'authorized', nextPpeCode: 'PPE001',
        issueVouchers: Array.from({ length: counts.issues }, (_, index) => ({
          id: index + 1, status: 'pending', user: 'QA Employee', timestamp: '2025-06-01T10:00:00Z', itemsJson: [],
        })),
        dashboardMetrics: { notificationFailures: { available: true, count: counts.messages, recent: [] } },
      },
      getAdminNotificationCounts: counts,
      getNotificationLogs: [],
      getNotificationRecipients: { recipients: [] },
      listEmployeeRegistrations: counts.employees
        ? [{ id: 1, revision: 1, employee_name: 'QA Employee', employee_id: 'QA-1', department: 'QA' }]
        : [],
      reviewEmployeeRegistrations: { reviewed: 1 },
    };
    if (action === 'reviewEmployeeRegistrations') counts.employees = 0;
    if (action === 'logoutAdmin') admin = false;
    await route.fulfill({ json: { status: 'success', data: responses[action] ?? {} } });
  });
  const waitForCount = (id, value) => page.waitForFunction(
    ([id, value]) => document.getElementById(id).textContent === value, [id, value]
  );
  try {
    await page.goto(baseUrl + '#dashboard');
    await page.waitForFunction(() => document.getElementById('splashScreen').classList.contains('hidden'));
    const mobile = viewport.width < 768;
    const issueBadge = mobile ? 'pendingBadge' : 'pendingBadgeDesktop';
    const employeeBadge = mobile ? 'employeeBadgeMobile' : 'employeeBadgeDesktop';
    const notificationBadge = mobile ? 'notificationBadgeMobile' : 'notificationBadgeDesktop';
    await waitForCount(issueBadge, '2');
    if (mobile) {
      await waitForCount('adminMoreBadge', '2');
      await page.locator('#adminMoreTrigger').click();
    }
    await waitForCount(employeeBadge, '1');
    await waitForCount(notificationBadge, '4');
    assert.equal(await page.locator('#' + employeeBadge).isVisible(), true);
    await page.locator('#' + notificationBadge).locator('..').click();
    await waitForCount('notificationPendingIssues', '2');
    await waitForCount('notificationPendingEmployees', '1');

    const widths = [];
    for (const module of ['notifications', 'pending', 'stock']) {
      await page.evaluate(name => showPage(name), module);
      const shell = page.locator(`#${module}Page > .module-shell`);
      assert.equal(await shell.isVisible(), true);
      widths.push((await shell.boundingBox()).width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    }
    assert.equal(widths.every(width => width === widths[0]), true, `Module widths ${widths.join(', ')}`);

    await page.evaluate(() => showPage('notifications'));
    await page.locator('#notificationPendingEmployees').locator('..').click();
    await page.locator('#employeeApprovalsList input').check();
    await page.locator('#employeeApprove').click();
    await page.locator('#confirmProceedBtn').click();
    await waitForCount(employeeBadge, '');
    await waitForCount(notificationBadge, '3');
    await waitForCount('notificationPendingEmployees', '0');

    counts.issues = 0;
    counts.messages = 0;
    await page.clock.fastForward(31000);
    await waitForCount(issueBadge, '');
    await waitForCount(notificationBadge, '');
    await page.evaluate(() => showPage('notifications'));
    await page.locator('#notificationPendingIssues').locator('..').click();
    await page.waitForFunction(() => !document.getElementById('pendingEmptyState').classList.contains('hidden'));
    assert.equal(await page.locator('#pendingPage').isVisible(), true);

    await page.evaluate(() => logout());
    await page.waitForFunction(() => document.getElementById('adminMenu').classList.contains('hidden'));
    const requestsBefore = actions.filter(action => action === 'getAdminNotificationCounts').length;
    await page.clock.fastForward(31000);
    assert.equal(actions.filter(action => action === 'getAdminNotificationCounts').length, requestsBefore);
    assert.deepEqual(pageErrors, []);
    console.log(`PASS ${viewport.name}: approval badges, summary links, review updates, polling, logout, module widths ${widths.join(', ')}`);
  } finally {
    await page.close();
  }
}
