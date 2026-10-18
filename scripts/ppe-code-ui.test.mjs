import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../pages/api/ppe.js', import.meta.url), 'utf8');

test('admin manage form exposes the next automatic PPE code as read-only', () => {
  assert.match(html, /id="itemCode"[^>]*readonly[^>]*aria-readonly="true"/);
  assert.match(html, /id="itemCodeStatus"/);
  assert.match(html, /รหัสถัดไป/);
  assert.match(html, /function syncManageItemCode\(\)/);
});

test('server owns PPE code allocation and includes soft-deleted history', () => {
  assert.match(api, /function getNextAvailablePpeCode\(\)/);
  assert.match(api, /\.from\('ppe_items'\)[\s\S]*?\.select\('code'\)[\s\S]*?\.ilike\('code', 'PPE%'\)/);
  assert.doesNotMatch(api, /\.select\('code'\)[\s\S]{0,160}\.is\('deleted_at', null\)/);
  assert.match(api, /existingItem[\s\S]*?await getNextAvailablePpeCode\(\)/);
});
