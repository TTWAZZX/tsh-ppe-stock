import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../pages/api/ppe.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/002_inventory_integrity.sql', import.meta.url), 'utf8');
const deleteBranch = migration.match(/WHEN 'deletePpeItem' THEN[\s\S]*?(?=WHEN 'addNewVoucher' THEN)/)?.[0] || '';

test('PPE deletion checks active voucher references using the real schema', () => {
  assert.match(deleteBranch, /v\."itemsJson"/);
  assert.match(deleteBranch, /'pending', 'processing'/);
  assert.match(deleteBranch, /v\.status_received IS DISTINCT FROM 'received'/);
  assert.match(deleteBranch, /l\.status = 'on_loan'/);
  assert.match(deleteBranch, /FOR UPDATE/);
});

test('PPE deletion reports expected conflicts without an internal server error', () => {
  assert.match(api, /runInventoryMutation\('deletePpeItem', \{ id: itemId \}, actor, requestId\)/);
  assert.match(api, /createHttpError\(Number\(error.code.slice\(2\)\), error.message\)/);
  assert.match(deleteBranch, /SQLSTATE 'PT404'/);
  assert.match(deleteBranch, /SQLSTATE 'PT409'/);
  assert.match(deleteBranch, /SET deleted_at = now\(\)/);
});
