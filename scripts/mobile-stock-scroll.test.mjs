import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('stock toolbar scrolls with catalog content on mobile', () => {
  const toolbar = html.match(/<div id="stockToolbar"([^>]*)>/)?.[1] || '';
  assert.ok(toolbar || html.includes('<div id="stockToolbar">'));
  assert.doesNotMatch(toolbar, /\bsticky\b/);
  assert.doesNotMatch(toolbar, /\btop-0\b/);
  assert.doesNotMatch(toolbar, /backdrop-blur/);
});
