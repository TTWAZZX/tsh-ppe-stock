import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const designSystem = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const source = `${html}\n${designSystem}`;

function readPngDimensions(relativePath) {
  const buffer = readFileSync(new URL(relativePath, import.meta.url));
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('brand assets and install metadata use the compact mark', () => {
  for (const asset of [
    '../public/brand-logo.png',
    '../public/brand-mark.png',
    '../public/favicon-32.png',
    '../public/apple-touch-icon.png',
    '../public/icon-192.png',
    '../public/icon-512.png',
    '../public/site.webmanifest',
  ]) assert.equal(existsSync(new URL(asset, import.meta.url)), true, `${asset} should exist`);

  assert.deepEqual(readPngDimensions('../public/favicon-32.png'), { width: 32, height: 32 });
  assert.deepEqual(readPngDimensions('../public/icon-192.png'), { width: 192, height: 192 });
  assert.deepEqual(readPngDimensions('../public/icon-512.png'), { width: 512, height: 512 });
  assert.match(html, /href="\/favicon-32\.png"/);
  assert.match(html, /src="\/brand-mark\.png" alt="PPE Stock"/);
});

test('shared design tokens and accessible navigation states are present', () => {
  for (const token of [
    '--brand-600',
    '--surface-page',
    '--text-primary',
    '--status-danger',
    '--radius-card',
    '--shadow-card',
    '--font-size-body',
  ]) assert.match(source, new RegExp(token));

  assert.match(source, /\.nav-item\.active/);
  assert.match(source, /\.nav-item-mobile\.active/);
  assert.match(html, /setAttribute\('aria-current', 'page'\)/);
  assert.match(html, /id="pendingBadgeDesktop"/);
  assert.match(html, /id="notificationBadgeDesktop"/);
});

test('Safety Blue brand palette is centralized without replacing semantic statuses', () => {
  for (const token of [
    '--brand-50: #eff7ff',
    '--brand-600: #1261a6',
    '--brand-800: #0b3d73',
    '--brand-900: #0b1f3a',
    '--accent-cyan-500: #21b8d5',
  ]) assert.ok(source.includes(token), `${token} should be defined`);

  assert.match(source, /--status-success: #059669/);
  assert.match(source, /--status-warning: #d97706/);
  assert.match(source, /--status-danger: #dc2626/);
  assert.doesNotMatch(source, /(?:text|bg|border|ring|from|to|via)-teal-/);
  assert.match(html, /radial-gradient\(circle at 82% 18%, rgba\(33,184,213,.34\), transparent 30%\)/);
  assert.match(html, /linear-gradient\(155deg, #0b1f3a 0%, #0b3d73 48%, #1261a6 100%\)/);
  assert.match(html, /success: \{ icon: 'fa-check-circle',\s+bg: 'bg-emerald-700'/);
  assert.match(html, /warning: \{ icon: 'fa-triangle-exclamation',\s+bg: 'bg-amber-700'/);
});

test('floating action is contextual and labelled', () => {
  assert.match(html, /id="fabRequestBtn"[\s\S]*?aria-label="สร้างคำขอเบิกอุปกรณ์"/);
  assert.match(html, /<span>ขอเบิกอุปกรณ์<\/span>/);
  assert.match(html, /fab\.classList\.toggle\('hidden', isAdmin \|\| pageName !== 'dashboard'\)/);
});

test('locked shared-width contract remains in place', () => {
  assert.match(source, /\.page-container > \.page > \.module-shell\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none !important;/);
  assert.match(source, /\.app-main\s*\{[\s\S]*?padding-inline:\s*var\(--app-gutter\)/);
});
