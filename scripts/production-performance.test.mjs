import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const designSystem = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const accessibilityManager = readFileSync(new URL('../public/js/accessibility-manager.js', import.meta.url), 'utf8');
const vendorLoader = readFileSync(new URL('../public/js/vendor-loader.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const vercelConfig = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');

test('production shell uses compiled local styles and local static assets', () => {
  assert.match(html, /href="\/css\/app\.css"/);
  assert.match(html, /href="\/vendor\/fontawesome\/css\/all\.min\.css"/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|fonts\.googleapis\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/);
  assert.match(designSystem, /@tailwind base;/);
  assert.match(designSystem, /font-display:\s*swap/);
  assert.equal(existsSync(new URL('../public/css/app.css', import.meta.url)), true);
  assert.equal(existsSync(new URL('../public/vendor/chart/chart.umd.js', import.meta.url)), true);
});

test('Chart.js and LIFF are requested through explicit lazy loaders', () => {
  assert.doesNotMatch(html, /<script[^>]+(?:chart\.js|static\.line-scdn\.net)/);
  assert.match(vendorLoader, /loadChart\(\)/);
  assert.match(vendorLoader, /loadLiff\(\)/);
  assert.match(vendorLoader, /\/vendor\/chart\/chart\.umd\.js/);
  assert.match(html, /else if \(!isAdmin\)/);
  assert.match(html, /if \(_activePage === 'dashboard'\)\s*\{\s*updateCategoryChart\(\);\s*updateTopIssuedItemsChart\(\);/);
});

test('shared architecture is externalized without changing the width contract', () => {
  assert.match(html, /src="\/js\/accessibility-manager\.js"/);
  assert.match(accessibilityManager, /function configureAccessibleDialog\(modal\)/);
  assert.match(designSystem, /\.page-container > \.page > \.module-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none !important;/);
  assert.match(designSystem, /\.app-main\s*\{[\s\S]*?padding-inline:\s*var\(--app-gutter\)/);
});

test('frontend assets are rebuilt for dev and production with safe cache rules', () => {
  assert.equal(packageJson.scripts.predev, 'npm run build:frontend');
  assert.equal(packageJson.scripts.prebuild, 'npm run build:frontend');
  assert.equal(packageJson.scripts['build:styles'], 'node scripts/build-styles.mjs');
  assert.match(vercelConfig, /"src": "\/api\/\(\.\*\)"[\s\S]*?"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(vercelConfig, /"src": "\/\(vendor\|fonts\)\/\(\.\*\)"[\s\S]*?max-age=31536000, immutable/);
  assert.match(vercelConfig, /"src": "\/\(\.\*\)\\\\\.\(js\|css\)\$"[\s\S]*?max-age=0, must-revalidate/);
});
