import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
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
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    await page.goto(`${baseUrl}?accessibilityQa=${viewport.width}#dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    for (const moduleId of moduleIds) {
      const result = await page.evaluate(({ moduleId, isMobile }) => {
        document.querySelectorAll('.page').forEach(module => module.classList.add('hidden'));
        const target = document.getElementById(moduleId);
        target.classList.remove('hidden');
        target.style.position = 'relative';
        window.applySharedComponentStyles?.(target);

        const visible = element => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const accessibleName = element => (
          element.getAttribute('aria-label') ||
          document.getElementById(element.getAttribute('aria-labelledby') || '')?.textContent ||
          element.labels?.[0]?.textContent ||
          element.textContent ||
          element.getAttribute('title') ||
          element.getAttribute('alt') || ''
        ).replace(/\s+/g, ' ').trim();

        const controls = [...target.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea')]
          .filter(element => visible(element) && !element.disabled);
        const unnamed = controls.filter(element => !accessibleName(element)).map(element => `${element.tagName}#${element.id}.${element.className}`);
        const smallTargets = isMobile
          ? controls.filter(element => {
              const rect = element.getBoundingClientRect();
              return element.matches('button, [role="button"], input[type="button"], input[type="submit"]') && (rect.width < 43.5 || rect.height < 43.5);
            }).map(element => `${element.tagName}#${element.id}:${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`)
          : [];
        const tables = [...target.querySelectorAll('table')];
        const uncontainedTables = tables.filter(table => !table.parentElement?.classList.contains('ui-table-container')).length;
        const main = document.getElementById('mainContent');

        return {
          unnamed,
          smallTargets,
          uncontainedTables,
          viewportOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          mainOverflow: main.scrollWidth > main.clientWidth + 1,
        };
      }, { moduleId, isMobile: viewport.name === 'mobile' });

      assert.deepEqual(result.unnamed, [], `${viewport.name} ${moduleId} has unnamed controls: ${result.unnamed.join(', ')}`);
      assert.deepEqual(result.smallTargets, [], `${viewport.name} ${moduleId} has small touch targets: ${result.smallTargets.join(', ')}`);
      assert.equal(result.uncontainedTables, 0, `${viewport.name} ${moduleId} tables should use contained scrolling`);
      assert.equal(result.viewportOverflow, false, `${viewport.name} ${moduleId} should not overflow viewport`);
      assert.equal(result.mainOverflow, false, `${viewport.name} ${moduleId} should not overflow main content`);
    }

    await page.evaluate(() => window.showLoginModal());
    await page.waitForTimeout(100);
    const dialogResult = await page.evaluate(() => {
      const modal = document.getElementById('loginModal');
      return {
        role: modal.getAttribute('role'),
        ariaModal: modal.getAttribute('aria-modal'),
        labelled: Boolean(modal.getAttribute('aria-labelledby') || modal.getAttribute('aria-label')),
        focusInside: modal.contains(document.activeElement),
      };
    });
    assert.deepEqual(dialogResult, { role: 'dialog', ariaModal: 'true', labelled: true, focusInside: true }, `${viewport.name} login dialog semantics/focus`);

    const lastFocusableId = await page.evaluate(() => {
      const modal = document.getElementById('loginModal');
      const focusable = [...modal.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.disabled && getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0);
      if (!focusable.at(-1).id) focusable.at(-1).id = 'qa-last-dialog-focus';
      focusable.at(-1).focus();
      return focusable[0].id;
    });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), lastFocusableId, `${viewport.name} dialog should trap forward focus`);

    await page.evaluate(() => document.getElementById('loginForm').reportValidity());
    await page.waitForTimeout(50);
    const validationResult = await page.evaluate(() => ({
      invalid: document.getElementById('loginUsername').getAttribute('aria-invalid'),
      hasError: Boolean(document.querySelector('#loginForm .ui-form-error')),
    }));
    assert.equal(validationResult.invalid, 'true', `${viewport.name} should expose invalid field state`);
    assert.equal(validationResult.hasError, true, `${viewport.name} should expose inline error text`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => document.getElementById('loginModal').classList.contains('hidden')), true, `${viewport.name} Escape should close dialog`);

    const reducedMotion = await page.evaluate(() => getComputedStyle(document.querySelector('#loadingOverlay .animate-spin')).animationDuration);
    assert.ok(['0s', '0.00001s', '1e-05s'].includes(reducedMotion), `${viewport.name} should honor reduced motion; got ${reducedMotion}`);

    console.log(`PASS ${viewport.name}: ${moduleIds.length} modules responsive and accessible`);
    await page.close();
  }
} finally {
  await browser.close();
}
