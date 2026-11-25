import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../pages/api/ppe.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/002_inventory_integrity.sql', import.meta.url), 'utf8');

test('admin manage form exposes the next automatic PPE code as read-only', () => {
  assert.match(html, /id="itemCode"[^>]*readonly[^>]*aria-readonly="true"/);
  assert.match(html, /id="itemCodeStatus"/);
  assert.match(html, /รหัสถัดไป/);
  assert.match(html, /function syncManageItemCode\(\)/);
});

test('server owns PPE code allocation and includes soft-deleted history', () => {
  assert.match(api, /function getNextAvailablePpeCode\(\)/);
  assert.match(api, /supabase\.rpc\('ppe_next_code'\)/);
  assert.match(migration, /SELECT max\(substring\(upper\(trim\(code\)\)[\s\S]{0,100}INTO max_value FROM public\.ppe_items;/);
  assert.match(migration, /code_number := nextval\('public\.ppe_code_seq'\)/);
  assert.doesNotMatch(migration, /UPDATE public\.ppe_items p SET code/);
});
