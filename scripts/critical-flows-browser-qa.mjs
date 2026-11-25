import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

    if (isLocalQa) {
      await checkApprovalNotifications(viewport);
      await checkMyTasks(viewport);
      await checkStockCounts(viewport);
      await checkIssueKits(viewport);
      await checkLoanAssetQr(viewport);
      await checkPurchasePlan(viewport);
    }
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

async function checkMyTasks(viewport) {
  const page = await browser.newPage({ viewport, timezoneId: 'UTC' });
  const owner = 'local-development-user';
  const item = { id: 1, code: 'PPE001', name: 'QA Helmet', stock: 5, unit: 'ชิ้น' };
  const voucher = (id, status, fields = {}) => ({
    id, status, userid: owner, user: 'Name saved before LINE rename', timestamp: '2025-11-20T10:00:00Z',
    itemsJson: [{ itemId: item.id, quantity: 3 }], ...fields,
  });
  const partial = voucher(12, 'partially_approved', { approved_items: [{ itemId: item.id, quantity: 1 }] });
  const loan = (loanId, dueDate, fields = {}) => ({
    loanId, dueDate, userid: owner, status: 'on_loan', borrowerName: 'Previous name',
    itemId: item.id, borrowDate: '2025-11-20', ...fields,
  });
  const actions = [];
  let registration;
  await page.clock.setFixedTime(new Date('2025-11-24T18:00:00Z'));
  await page.route(origin + '/api/ppe', async route => {
    const { action, payload } = route.request().postDataJSON();
    actions.push(action);
    if (action === 'confirmReceive') {
      assert.equal(payload.voucherId, partial.id);
      partial.status_received = 'received';
    }
    const responses = {
      getAdminSession: { authenticated: false },
      getInitialData: {
        accessStatus: registration ? 'employee_required' : 'authorized', registration,
        ppeItems: [item], issueVouchers: [voucher(11, 'pending'), partial,
          voucher(13, 'approved'), voucher(99, 'pending', { userid: 'another-user', user: 'Local Tester' })],
        loanTransactions: [loan(21, '2025-11-24'), loan(22, '2025-11-25'), loan(23, '2025-11-28'),
          loan(24, '2025-11-29'), loan(25, '2025-11-24', { status: 'returned' })],
      },
      confirmReceive: { status: 'received', voucherId: partial.id },
    };
    await route.fulfill({ json: { status: 'success', data: responses[action] ?? {} } });
  });
  try {
    await page.goto(baseUrl + '#dashboard');
    const tasks = page.locator('#myTasks');
    await tasks.waitFor();
    const initial = await tasks.innerText();
    for (const text of ['เกินกำหนด 1 วัน', 'ครบกำหนดวันนี้', 'เหลือ 3 วัน', 'อนุมัติบางส่วน', 'รอผู้ดูแลอนุมัติ']) {
      assert.ok(initial.includes(text), `Task text should include ${text}`);
    }
    assert.doesNotMatch(initial, /#13|#99|เหลือ 4 วัน/);
    const widths = [];
    for (const module of ['dashboard', 'loan', 'notifications']) {
      if (module === 'notifications') {
        await page.evaluate(() => { isAdmin = true; showPage('notifications'); isAdmin = false; });
      } else await page.evaluate(name => showPage(name), module);
      const shell = page.locator(`#${module}Page > .module-shell`);
      widths.push((await shell.boundingBox()).width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    }
    assert.equal(widths.every(width => width === widths[0]), true, `Module widths ${widths.join(', ')}`);
    await page.evaluate(() => showPage('dashboard'));
    await tasks.getByRole('button', { name: /ดูกำหนดคืน/ }).first().click();
    await page.waitForFunction(() => document.activeElement?.dataset.loanId === '21');
    assert.equal(await page.locator('#loanPage').isVisible(), true);
    await page.evaluate(() => showPage('dashboard'));
    await tasks.getByRole('button', { name: /ยอดอนุมัติและรับของ/ }).click();
    await page.locator('#voucherModal').getByText(/ขอ 3 · อนุมัติ 1/).waitFor();
    await page.locator('#voucherModal').getByRole('button', { name: 'ยืนยันรับของ' }).click();
    await page.locator('#confirmCancelBtn').click();
    assert.equal(actions.includes('confirmReceive'), false);
    await page.locator('#voucherModal').getByRole('button', { name: 'ยืนยันรับของ' }).click();
    await page.locator('#confirmProceedBtn').click();
    await page.locator('#rateItemSelectorModal').waitFor();
    assert.equal(actions.filter(action => action === 'confirmReceive').length, 1);
    await page.reload();
    await page.evaluate(() => showPage('dashboard'));
    await tasks.getByRole('button', { name: /ประเมินอุปกรณ์.*#12/ }).waitFor();
    registration = { status: 'rejected', reason: 'ข้อมูลไม่ตรง', departments: [{ id: 1, name: 'QA' }] };
    await page.goto(baseUrl + '#dashboard');
    await page.reload();
    await page.locator('#employeeRegistrationTitle').getByText('แก้ข้อมูลลงทะเบียนพนักงาน').waitFor();
    assert.equal(await page.locator('#registrationSubmit').innerText(), 'ส่งคำขอใหม่');
    assert.equal(await tasks.isVisible(), false);
    console.log(`PASS ${viewport.name}: employee tasks, Bangkok deadlines, partial receipt and review, registration gate, module widths ${widths.join(', ')}`);
  } finally {
    await page.close();
  }
}

async function checkStockCounts(viewport) {
  const page = await browser.newPage({ viewport });
  const items = [
    { id: 41, code: 'PPE041', name: 'QA Helmet', stock: 10, unit: 'ชิ้น' },
    { id: 42, code: 'PPE042', name: 'QA Gloves', stock: 4, unit: 'คู่' },
  ];
  const openedAt = '2025-11-25T02:00:00Z';
  let round = null;
  let conflicted = false;
  const writes = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(origin + '/api/ppe', async route => {
    const { action, payload } = route.request().postDataJSON();
    if (action === 'mutateStockCount') {
      writes.push(payload);
      if (payload.operation === 'start') {
        assert.deepEqual(payload.itemIds, [41, 42]);
        round = {
          id: 51, revision: 1, status: 'open', title: payload.title, opened_at: openedAt,
          lines: items.map(item => ({
            item_id: item.id, code: item.code, name: item.name, unit: item.unit,
            expected_stock: item.stock, counted_stock: null, state: 'ready',
          })),
        };
      } else {
        assert.equal(payload.revision, round.revision);
        if (payload.operation === 'save') {
          for (const line of payload.counts) Object.assign(round.lines.find(entry => entry.item_id === line.item_id), line);
        }
        if (payload.operation === 'apply' && !conflicted) {
          conflicted = true;
          round.lines[0].state = 'changed';
          return route.fulfill({ status: 409, json: { status: 'error', message: 'สต็อกเปลี่ยนระหว่างรอบ' } });
        }
        if (payload.operation === 'recount') {
          assert.equal(payload.itemId, 41);
          Object.assign(round.lines[0], { expected_stock: 8, state: 'ready', counted_stock: null });
        }
        if (payload.operation === 'apply') {
          Object.assign(round, { status: 'applied', reason: payload.reason, closed_at: openedAt, closed_by: 'admin:QA' });
          round.lines.forEach(line => { line.state = 'closed'; });
        }
        round.revision++;
      }
    }
    const responses = {
      getAdminSession: { authenticated: true },
      getInitialData: { isAdmin: true, ppeItems: items, accessStatus: 'authorized' },
      getAdminNotificationCounts: { issues: 0, employees: 0, messages: 0 },
      getNotificationLogs: [],
      getNotificationRecipients: { recipients: [] },
      listStockCounts: { rounds: round ? [round] : [], nextBefore: null },
      getStockCount: round,
      mutateStockCount: { id: round?.id, status: round?.status, revision: round?.revision },
    };
    await route.fulfill({ json: { status: 'success', data: responses[action] ?? {} } });
  });
  const module = page.locator('#stockCountPage');
  const button = name => module.getByRole('button', { name, exact: true });
  const save = () => button('บันทึกยอดที่นับ');
  const apply = () => button('ยืนยันปรับยอดและปิดรอบ');
  async function confirm(reason) {
    const dialog = page.locator('#confirmationModal');
    if (reason) await dialog.locator('textarea').fill(reason);
    await dialog.locator('#confirmProceedBtn').click();
  }
  try {
    await page.goto(baseUrl + '#dashboard');
    await page.waitForFunction(() => document.getElementById('splashScreen').classList.contains('hidden'));
    if (viewport.width < 768) await page.locator('#adminMoreTrigger').click();
    await page.getByRole('link', { name: 'ตรวจนับสต็อก', exact: true }).click();
    await button('เปิดรอบใหม่').click();
    await module.getByLabel('ชื่อรอบ').fill('QA count');
    await module.getByLabel('เลือกอุปกรณ์ในรอบนี้').fill('PPE04');
    await module.getByLabel('เลือกทั้งหมดที่แสดง').check();
    await button('เริ่มตรวจนับ').click();
    await page.locator('#stockCountItem41').waitFor();
    assert.equal(await apply().isDisabled(), true);
    const helmet = page.locator('#stockCountItem41');
    await helmet.fill('-1');
    await save().click();
    await page.locator('#stockCountStatus').getByText(/จำนวนเต็ม/).waitFor();
    assert.equal(writes.length, 1);
    await helmet.fill('9');
    const search = module.getByLabel('ค้นหาในรอบนี้');
    await search.fill('PPE042');
    assert.equal(await helmet.isVisible(), false);
    await page.locator('#stockCountItem42').fill('0');
    await search.fill('');
    assert.equal(await helmet.inputValue(), '9');
    assert.equal(await page.locator('#stockCountDifference41').innerText(), '-1');
    assert.equal(await page.locator('#stockCountDifference42').innerText(), '-4');
    await save().click();
    await page.locator('#stockCountProgress').getByText(/2\/2/).waitFor();
    await apply().click();
    await confirm('QA before movement');
    await button('เริ่มนับใหม่').waitFor();
    assert.equal(await apply().isDisabled(), true);
    await button('เริ่มนับใหม่').click();
    await confirm();
    await helmet.waitFor();
    assert.equal(await helmet.inputValue(), '');
    await helmet.fill('7');
    await save().click();
    await page.locator('#stockCountProgress').getByText(/2\/2/).waitFor();
    await apply().click();
    await confirm('QA confirmed discrepancy');
    await module.getByText(/เหตุผล QA confirmed discrepancy/).waitFor();
    assert.equal(await apply().count(), 0);
    assert.equal(await helmet.count(), 0);
    assert.equal(writes.at(-1).reason, 'QA confirmed discrepancy');

    const widths = [];
    for (const name of ['stockCount', 'receive', 'stock']) {
      await page.evaluate(moduleName => showPage(moduleName, { restoring: true }), name);
      const shell = page.locator(`#${name}Page > .module-shell`);
      widths.push((await shell.boundingBox()).width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    }
    assert.equal(widths.every(width => width === widths[0]), true, `Module widths ${widths.join(', ')}`);
    await page.evaluate(() => showPage('stockCount'));
    await button('กลับไปรอบตรวจนับ').click();
    await module.getByRole('button', { name: /QA count.*ปิดรอบแล้ว/ }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.name}: cycle opening, draft validation, zero counts, movement conflict, recount, close history, module widths ${widths.join(', ')}`);
  } finally {
    await page.close();
  }
}

async function checkIssueKits(viewport) {
  const page = await browser.newPage({ viewport });
  const items = [
    { id: 1, code: 'PPE001', name: 'Gloves S', stock: 0, unit: 'pair' },
    { id: 2, code: 'PPE002', name: 'Gloves M', stock: 6, unit: 'pair' },
    { id: 3, code: 'PPE003', name: 'Safety glasses', stock: 8, unit: 'pcs' },
    { id: 4, code: 'PPE004', name: 'Gloves L', stock: 3, unit: 'pair' },
    { id: 5, code: 'PPE005', name: 'Ear plugs', stock: 0, unit: 'pair' },
  ];
  const kit = { id: 61, job_function: 'Grinding', department: 'QA', items_json: [
    { id: 1, name: 'Gloves', quantity: 3, alternativeIds: [2, 4] },
    { id: 3, name: 'Safety glasses' },
    { id: 5, name: 'Ear plugs' },
  ] };
  let admin = false;
  let saved;
  let vouchers = 0;
  await page.route(origin + '/api/ppe', async route => {
    const { action, payload } = route.request().postDataJSON();
    if (action === 'addNewVoucher') vouchers++;
    if (action === 'saveMatrixRule') saved = payload.itemsJson;
    const responses = {
      getAdminSession: { authenticated: admin },
      getInitialData: { isAdmin: admin, accessStatus: 'authorized', ppeItems: items, ppeMatrix: [kit],
        employee: { employeeId: 'QA1', name: 'QA Employee', department: 'QA' }, departments: [{ id: 1, name: 'QA' }] },
      getAdminNotificationCounts: { issues: 0, employees: 0, messages: 0 },
      getNotificationLogs: [],
      getNotificationRecipients: { recipients: [] },
      saveMatrixRule: { id: 61 },
    };
    await route.fulfill({ json: { status: 'success', data: responses[action] ?? {} } });
  });
  try {
    await page.goto(baseUrl + '#issue');
    await page.locator('#issueKit option[value="61"]').waitFor({ state: 'attached' });
    const width = async name => (await page.locator(`#${name}Page > .module-shell`).boundingBox()).width;
    const issueWidth = await width('issue');
    await page.evaluate(() => addIssueRow(currentData.ppeItems.find(item => item.id === 3), 4));
    await page.locator('#issueKit').selectOption('61');
    await page.locator('#issueKitPreview').click();
    const dialog = page.locator('#matrixDetailModal');
    await dialog.waitFor();
    assert.equal(await page.locator('#kitChoice0').inputValue(), '2');
    assert.equal(await page.locator('#kitQuantity0').inputValue(), '3');
    assert.equal(await page.locator('#kitQuantity1').inputValue(), '1');
    assert.equal(await page.locator('#kitQuantity2').isDisabled(), true);
    await page.locator('#kitChoice0').selectOption('4');
    await page.locator('#kitQuantity0').fill('4');
    assert.equal(await page.locator('#matrixIssueBtn').isDisabled(), true);
    await page.locator('#kitQuantity0').fill('2');
    await page.locator('#matrixIssueBtn').click();
    const formRows = page.locator('#issueItemsContainer .issue-item');
    assert.equal(await formRows.count(), 2);
    assert.deepEqual(await formRows.locator('.item-quantity').evaluateAll(fields => fields.map(field => field.value)), ['4', '2']);
    assert.deepEqual(await formRows.locator('.item-select-value').evaluateAll(fields => fields.map(field => field.value)), ['3', '4']);
    assert.equal(vouchers, 0);
    await page.evaluate(() => showPage('stock'));
    assert.equal(await width('stock'), issueWidth);

    admin = true;
    await page.reload();
    await page.waitForFunction(() => document.getElementById('splashScreen').classList.contains('hidden'));
    await page.evaluate(() => showPage('receive'));
    assert.equal(await width('receive'), issueWidth);
    await page.evaluate(() => showPage('matrix'));
    await page.getByRole('button', { name: 'แก้ไขมาตรฐาน', exact: true }).click();
    await page.locator('#matrixKitQuantity0').fill('2');
    const editor = page.locator('#matrixRuleModal');
    await editor.getByText('ไซซ์หรือรุ่นที่เลือกแทนได้', { exact: true }).first().click();
    await editor.getByRole('button', { name: /ลบตัวเลือก PPE002/ }).click();
    await page.locator('#matrixAlternate0').selectOption('2');
    await editor.getByRole('button', { name: 'เพิ่มตัวเลือก', exact: true }).click();
    await editor.getByRole('button', { name: 'บันทึกข้อมูล' }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(saved[0].quantity, 2);
    assert.deepEqual(saved[0].alternativeIds, [4, 2]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    console.log(`PASS ${viewport.name}: kit variants, stock limits, legacy defaults, draft merge, admin editor, module width ${issueWidth}`);
  } finally {
    await page.close();
  }
}

async function checkLoanAssetQr(viewport) {
  const page = await browser.newPage({ viewport });
  const token = 'ae000000-1111-4000-8000-000000000001';
  const item = { id: 23, code: 'PPE023', name: 'QA Harness', stock: 2, unit: 'ชุด' };
  const asset = { id: 71, item_id: item.id, label: 'HARNESS-01', available: true, retired_at: null };
  const scanUrl = `${baseUrl}?module=loan&asset=${token}`;
  let admin = true;
  let registered = false;
  let loan = null;
  let ownLoan = true;
  const errors = [];
  const mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(origin + '/api/ppe', async route => {
    const { action, payload } = route.request().postDataJSON();
    if (action === 'checkAdminCredentials') admin = true;
    if (action === 'mutateLoanAsset') {
      mutations.push(payload);
      assert.equal(payload.label, asset.label);
      registered = true;
    }
    if (action === 'borrowItem') {
      assert.equal(payload.itemId, item.id);
      assert.equal(payload.assetToken, token);
      mutations.push(payload);
      asset.available = false;
      loan = {
        loanId: 91, itemId: item.id, userid: 'local-development-user', borrowerName: 'QA Employee', status: 'on_loan',
        dueDate: payload.dueDate, borrowDate: payload.dueDate, loan_asset_label: asset.label,
      };
    }
    if (action === 'returnItem') {
      assert.deepEqual(payload, { loanId: loan.loanId, assetToken: token });
      mutations.push(payload);
      asset.available = true;
      loan.status = 'returned';
    }
    const responses = {
      getAdminSession: { authenticated: admin },
      checkAdminCredentials: { authenticated: admin },
      getInitialData: { isAdmin: admin, accessStatus: 'authorized', ppeItems: [item],
        employee: { employeeId: 'QA1', name: 'QA Employee', department: 'QA' }, departments: [{ id: 1, name: 'QA' }],
        loanTransactions: loan && (admin || ownLoan) ? [loan] : [] },
      getAdminNotificationCounts: { issues: 0, employees: 0, messages: 0 },
      getNotificationLogs: [],
      getNotificationRecipients: { recipients: [] },
      listLoanAssets: { assets: registered ? [asset] : [], nextBefore: null },
      mutateLoanAsset: { id: asset.id },
      getLoanAssetQr: { label: asset.label, url: scanUrl, image: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' },
      getScannedLoanAsset: { itemId: item.id, label: asset.label, available: asset.available,
        loan: loan && loan.status === 'on_loan' && (admin || ownLoan) ? { loanId: loan.loanId } : null },
      borrowItem: { newLoan: loan, updatedItem: { ...item, stock: 1 } },
      returnItem: { returnedLoanId: loan?.loanId },
    };
    await route.fulfill({ json: { status: 'success', data: responses[action] ?? {} } });
  });

  try {
    await page.goto(baseUrl + '#dashboard');
    await page.waitForFunction(() => document.getElementById('splashScreen').classList.contains('hidden'));
    if (viewport.width < 768) await page.locator('#adminMoreTrigger').click();
    await page.getByRole('link', { name: 'ป้าย QR อุปกรณ์', exact: true }).click();
    await page.locator('#loanAssetItem').selectOption(String(item.id));
    await page.locator('#loanAssetLabel').fill(asset.label);
    await page.locator('#loanAssetRegister').click();
    await page.locator('#loanAssetPreview').waitFor();
    assert.equal(await page.locator('#loanAssetLink').getAttribute('href'), scanUrl);
    assert.equal(await page.locator('#loanAssetDownload').getAttribute('download'), 'ppe-qr-71.svg');
    const width = async name => (await page.locator(`#${name}Page > .module-shell`).boundingBox()).width;
    const adminWidth = await width('loanAssets');
    await page.evaluate(() => showPage('receive'));
    assert.equal(await width('receive'), adminWidth);

    admin = false;
    await page.goto(scanUrl);
    const panel = page.locator('#scannedLoanAsset');
    await panel.getByText(/HARNESS-01.*พร้อมยืม/).waitFor();
    assert.equal(await width('loan'), adminWidth);
    assert.equal(await page.locator('#loanItemId').inputValue(), String(item.id));
    await page.locator('#loanDueDate').fill(await page.locator('#loanDueDate').getAttribute('min'));
    await page.locator('#loanSubmitButton').click();
    await page.locator('#confirmationMessage').getByText(/HARNESS-01/).waitFor();
    await page.locator('#confirmProceedBtn').click();
    await panel.getByRole('button', { name: 'ดูรายการยืมของชิ้นนี้' }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'รับคืนชิ้นนี้' }).count(), 0);
    ownLoan = false;
    await page.reload();
    await panel.getByText(/กำลังถูกยืม/).waitFor();
    assert.equal(await panel.getByRole('button').count(), 0);

    await page.evaluate(() => showLoginModal());
    await page.locator('#loginUsername').fill('qa');
    await page.locator('#loginPassword').fill('qa');
    await page.locator('#loginForm button[type="submit"]').click();
    await panel.getByRole('button', { name: 'รับคืนชิ้นนี้' }).click();
    await page.locator('#confirmProceedBtn').click();
    await panel.getByText(/พร้อมยืม/).waitFor();
    assert.equal(mutations.length, 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.name}: QR registration, label preview, scanned borrow, privacy, scanned admin return, module width ${adminWidth}`);
  } finally {
    await page.close();
  }
}

async function checkPurchasePlan(viewport) {
  const page = await browser.newPage({ viewport });
  const issues = [];
  page.on('pageerror', error => issues.push(error.message));
  const calculations = [];
  const base = { category: 'Safety', unit: 'pcs', stock: 10, available_stock: 8, tagged_stock: 2,
    reorder_point: 8, issued: 90, daily_usage: 1, target_stock: 30, suggested: 22, at_reorder_point: true };
  await page.route(origin + '/api/ppe', async route => {
    const { action, payload } = route.request().postDataJSON();
    if (action === 'getPurchasePlan') calculations.push(payload);
    const coverage = payload?.coverageDays ?? 30;
    const responses = {
      getAdminSession: { authenticated: true },
      getInitialData: { isAdmin: true, accessStatus: 'authorized', ppeItems: [] },
      getAdminNotificationCounts: { issues: 0, employees: 0, messages: 0 },
      getNotificationLogs: [],
      getNotificationRecipients: { recipients: [] },
      getIssueReport: { totalRows: 0, voucherCount: 0, confirmedVoucherCount: 0, totalQuantity: 0, departments: [], items: [], rows: [] },
      getPurchasePlan: {
        historyDays: payload?.historyDays ?? 90, coverageDays: coverage,
        startDate: '2025-09-01', endDate: '2025-11-29', asOf: '2025-11-29T02:00:00Z', unreconciledCount: 2,
        rows: [
          { ...base, id: 22, code: 'PPE022', name: ' =QA markup', target_stock: coverage, suggested: coverage - base.available_stock },
          { ...base, id: 23, code: 'PPE023', name: 'On threshold', tagged_stock: 0, stock: 8,
            issued: 0, daily_usage: 0, target_stock: 8, suggested: 0 },
          { ...base, id: 24, code: 'PPE024', name: 'Loan-only harness', stock: 1, tagged_stock: 1, available_stock: 0,
            issued: 0, daily_usage: 0, target_stock: 0, suggested: 0, at_reorder_point: false, loan_only: true },
        ],
      },
    };
    await route.fulfill({ json: { status: 'success', data: responses[action] ?? {} } });
  });

  try {
    await page.goto(baseUrl + '#dashboard');
    await page.waitForFunction(() => document.getElementById('splashScreen').classList.contains('hidden'));
    if (viewport.width < 768) await page.locator('#adminMoreTrigger').click();
    await page.getByRole('link', { name: 'เตรียมสั่งซื้อ', exact: true }).click();
    const module = page.locator('#purchasePlanPage');
    const row = module.locator('[data-purchase-row="22"]');
    const exportButton = module.getByRole('button', { name: 'ดาวน์โหลด CSV' });
    await row.getByText('แนะนำ 22').waitFor();
    assert.deepEqual(calculations[0], { historyDays: 90, coverageDays: 30 });
    await module.getByText(/ใบเบิกเก่า 2 ใบ/).waitFor();
    assert.equal(await module.getByText('Loan-only harness', { exact: true }).count(), 0);
    assert.equal(await exportButton.isDisabled(), true);
    await module.getByLabel('เลือกทั้งหน้าที่มียอดสั่ง').check();
    assert.equal(await module.locator('[data-purchase-row="23"] input[type="checkbox"]').isChecked(), false);
    await row.locator('input[type="number"]').fill('35');
    await module.getByRole('searchbox').fill('PPE023');
    assert.equal(await row.count(), 0);
    assert.equal(await exportButton.isDisabled(), false);
    await module.getByRole('searchbox').clear();
    assert.equal(await row.locator('input[type="number"]').inputValue(), '35');
    await module.getByLabel('เป้าหมายให้สต็อกพอใช้ (วัน)').fill('45');
    assert.equal(await exportButton.isDisabled(), true);
    await module.getByRole('button', { name: 'คำนวณใหม่' }).click();
    await row.getByText('แนะนำ 37').waitFor();
    assert.deepEqual(calculations.at(-1), { historyDays: 90, coverageDays: 45 });
    assert.equal(await row.locator('input[type="number"]').inputValue(), '35');
    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'ppe-purchase-plan-2025-11-29.csv');
    const csv = await readFile(await download.path(), 'utf8');
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.match(csv, /"PPE022","' =QA markup"/);
    assert.match(csv, /"37","35","2025-09-01","2025-11-29","45"/);
    assert.doesNotMatch(csv, /PPE023|PPE024/);
    await module.getByLabel('แสดงรายการ').selectOption('all');
    await module.getByText('อุปกรณ์ติดป้ายสำหรับยืม', { exact: true }).waitFor();

    const widths = [];
    for (const name of ['purchasePlan', 'report', 'stock']) {
      await page.evaluate(value => showPage(value, { restoring: true }), name);
      widths.push((await page.locator(`#${name}Page > .module-shell`).boundingBox()).width);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
    }
    assert.equal(widths.every(width => width === widths[0]), true, `Module widths ${widths.join(', ')}`);
    assert.deepEqual(issues, []);
    console.log(`PASS ${viewport.name}: purchase plan preview, settings, selection, safe CSV export, module widths ${widths.join(', ')}`);
  } finally {
    await page.close();
  }
}
