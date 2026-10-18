import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
const moduleIds = [
  'dashboardPage',
  'stockPage',
  'issuePage',
  'loanPage',
  'allHistoryPage',
  'pendingPage',
  'managePage',
  'receivePage',
  'reportPage',
  'notificationsPage',
  'matrixPage',
];

const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${baseUrl}?sharedComponentsQa=${viewport.width}#dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    for (const moduleId of moduleIds) {
      const result = await page.evaluate(id => {
        document.querySelectorAll('.page').forEach(module => module.classList.add('hidden'));
        const target = document.getElementById(id);
        target.classList.remove('hidden');
        target.style.position = 'relative';

        const shell = target.querySelector(':scope > .module-shell');
        const controls = [...target.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="range"]), select, textarea')];
        const tables = [...target.querySelectorAll('table')];
        const main = document.getElementById('mainContent');

        return {
          found: Boolean(target && shell),
          shellStandardized: shell?.classList.contains('ui-component-scope') || false,
          hasTitle: Boolean(target.querySelector('.ui-page-title')),
          controlsStandardized: controls.every(control => control.classList.contains('ui-control')),
          tablesStandardized: tables.every(table => table.classList.contains('ui-table')),
          viewportOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          mainOverflow: main.scrollWidth > main.clientWidth + 1,
        };
      }, moduleId);

      assert.equal(result.found, true, `${viewport.name} ${moduleId} should have a module shell`);
      assert.equal(result.shellStandardized, true, `${viewport.name} ${moduleId} should use the shared component scope`);
      assert.equal(result.hasTitle, true, `${viewport.name} ${moduleId} should use the shared page title`);
      assert.equal(result.controlsStandardized, true, `${viewport.name} ${moduleId} controls should be standardized`);
      assert.equal(result.tablesStandardized, true, `${viewport.name} ${moduleId} tables should be standardized`);
      assert.equal(result.viewportOverflow, false, `${viewport.name} ${moduleId} should not overflow the viewport`);
      assert.equal(result.mainOverflow, false, `${viewport.name} ${moduleId} should not overflow main content`);
    }

    if (process.env.PPE_QA_SCREENSHOTS === '1') {
      const previewModuleId = viewport.name === 'desktop' ? 'reportPage' : 'issuePage';
      await page.evaluate(id => {
        document.querySelectorAll('.page').forEach(module => module.classList.add('hidden'));
        const target = document.getElementById(id);
        target.classList.remove('hidden');
        target.style.position = 'relative';
        document.getElementById('adminSidebar')?.classList.toggle('hidden', id !== 'reportPage');
      }, previewModuleId);
      await page.screenshot({
        path: `.qa-shared-${viewport.width}.png`,
        fullPage: false,
      });
    }

    console.log(`PASS ${viewport.name}: ${moduleIds.length} modules standardized without horizontal overflow`);
    await page.close();
  }
} finally {
  await browser.close();
}
