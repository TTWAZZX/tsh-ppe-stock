import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');

test('all transient toasts have bounded automatic dismissal', () => {
  assert.match(html, /success:\s*\{[^}]*duration:\s*4000/);
  assert.match(html, /warning:\s*\{[^}]*duration:\s*6500/);
  assert.match(html, /error:\s*\{[^}]*duration:\s*8000/);
  assert.match(html, /timeoutId = setTimeout\(dismiss, duration\)/);
  assert.doesNotMatch(html, /mouseenter[^\n]*clearTimeout/);
  assert.match(styles, /@keyframes toast-countdown/);
});

test('stock edit reveals and focuses the shared admin form', () => {
  const editFunction = html.match(/function editItem\(itemId\) \{[\s\S]*?\n    \}/)?.[0] || '';
  assert.match(editFunction, /showPage\('manage'\)/);
  assert.match(editFunction, /manageForm\?\.scrollIntoView/);
  assert.match(editFunction, /document\.getElementById\('itemName'\)\?\.focus/);
});
