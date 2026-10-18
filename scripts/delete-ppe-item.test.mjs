import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../pages/api/ppe.js', import.meta.url), 'utf8');

test('PPE deletion checks active voucher references using the real schema', () => {
  const deleteFunction = api.match(/async function deletePpeItem\(payload\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(deleteFunction, /select\('id, itemsJson'\)/);
  assert.match(deleteFunction, /parseVoucherItems\(voucher\.itemsJson\)/);
  assert.doesNotMatch(deleteFunction, /select\('id, items'\)/);
});

test('PPE deletion reports expected conflicts without an internal server error', () => {
  const deleteFunction = api.match(/async function deletePpeItem\(payload\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(deleteFunction, /createHttpError\(400,/);
  assert.match(deleteFunction, /createHttpError\(404,/);
  assert.match(deleteFunction, /createHttpError\(409,/);
  assert.match(deleteFunction, /update\(\{ deleted_at:/);
});
