import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.PPE_QA_URL || 'http://127.0.0.1:3000/index.html';
const browser = await chromium.launch({ headless: true });

try {
  for (const viewport of [
    { name: 'desktop', width: 1920, height: 1080 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}?visualReadiness=${viewport.width}#stock`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.getElementById('splashScreen')?.remove());

    const result = await page.evaluate(() => {
      const showOnly = id => {
        document.querySelectorAll('.page').forEach(element => element.classList.add('hidden'));
        document.getElementById(id)?.classList.remove('hidden');
      };
      showOnly('matrixPage');
      const hero = document.querySelector('#matrixPage .brand-hero');
      const heroTitle = hero?.querySelector('h2');
      const heroStyle = hero ? getComputedStyle(hero) : null;
      const titleStyle = heroTitle ? getComputedStyle(heroTitle) : null;

      showOnly('reportPage');
      const metrics = [...document.querySelectorAll('#reportPage .brand-gradient-card')].map(card => ({
        background: getComputedStyle(card).backgroundImage,
        color: getComputedStyle(card).color,
        labelColor: getComputedStyle(card.querySelector('.gradient-card-label')).color,
      }));

      showOnly('receivePage');
      window.applySharedComponentStyles?.(document.getElementById('receivePage'));
      const options = [...document.querySelectorAll('.receive-type-option')].map(option => ({
        width: option.getBoundingClientRect().width,
        cardWidth: option.querySelector('.receive-type-card').getBoundingClientRect().width,
        height: option.querySelector('.receive-type-card').getBoundingClientRect().height,
      }));
      const shell = document.querySelector('#receivePage .module-shell');
      return {
        heroBackground: heroStyle?.backgroundImage || '',
        heroTitleColor: titleStyle?.color || '',
        metrics,
        options,
        overflow: shell ? shell.scrollWidth - shell.clientWidth : 0,
      };
    });

    assert.match(result.heroBackground, /linear-gradient/);
    assert.equal(result.heroTitleColor, 'rgb(255, 255, 255)');
    assert.equal(result.metrics.length, 4);
    result.metrics.forEach(metric => {
      assert.match(metric.background, /linear-gradient/);
      assert.equal(metric.color, 'rgb(255, 255, 255)');
      assert.notEqual(metric.labelColor, 'rgb(255, 255, 255, 0)');
    });
    assert.equal(result.options.length, 3);
    result.options.forEach(option => {
      assert.ok(option.width > (viewport.width < 640 ? 280 : 160), `${viewport.name}: receive option should fill its grid track`);
      assert.ok(Math.abs(option.width - option.cardWidth) < 1, `${viewport.name}: card should fill label width`);
      assert.ok(option.height >= 100, `${viewport.name}: receive card should remain readable`);
    });
    assert.ok(result.overflow <= 1, `${viewport.name}: receive module must not overflow horizontally`);
    assert.deepEqual(errors, [], `${viewport.name}: console should remain clean`);
    if (process.env.PPE_QA_SCREENSHOTS === '1') {
      for (const [moduleId, fileLabel] of [['matrixPage', 'matrix'], ['reportPage', 'report'], ['receivePage', 'receive']]) {
        await page.evaluate(id => {
          document.querySelectorAll('.page').forEach(element => element.classList.add('hidden'));
          document.getElementById(id)?.classList.remove('hidden');
          document.getElementById('mainContent')?.scrollTo(0, 0);
        }, moduleId);
        await page.screenshot({ path: `.qa-${fileLabel}-${viewport.name}.png`, fullPage: false });
      }
    }
    console.log(`PASS ${viewport.name}: readable gradients and receive controls`);
    await page.close();
  }
} finally {
  await browser.close();
}
