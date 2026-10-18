import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
const browser = await chromium.launch({ headless: true });

try {
  for (const scenario of [
    { name: 'desktop dashboard', width: 1920, height: 1080, hash: 'dashboard' },
    { name: 'mobile stock', width: 390, height: 844, hash: 'stock' },
  ]) {
    const page = await browser.newPage({
      viewport: { width: scenario.width, height: scenario.height },
      deviceScaleFactor: 1,
    });

    await page.goto(`${baseUrl}?themeBrowserQa=${scenario.width}#${scenario.hash}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(7000);

    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const activeNavigation = [...document.querySelectorAll('.nav-item.active, .nav-item-mobile.active')]
        .filter(element => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });

      return {
        viewportWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        activeNavigationCount: activeNavigation.length,
        activeNavigationColors: activeNavigation.map(element => ({
          color: getComputedStyle(element).color,
          backgroundColor: getComputedStyle(element).backgroundColor,
        })),
      };
    });

    assert.ok(
      result.scrollWidth <= result.viewportWidth && result.bodyScrollWidth <= result.viewportWidth,
      `${scenario.name} must not have horizontal overflow: ${JSON.stringify(result)}`,
    );
    assert.ok(result.activeNavigationCount >= 1, `${scenario.name} should expose an active navigation state`);
    assert.ok(
      result.activeNavigationColors.some(item => item.backgroundColor === 'rgb(239, 247, 255)'),
      `${scenario.name} active navigation should use the pale Safety Blue surface`,
    );

    await page.close();
    console.log(`PASS ${scenario.name}: ${scenario.width}px, no overflow, active state visible`);
  }
} finally {
  await browser.close();
}
