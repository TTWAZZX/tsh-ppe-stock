import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('history rows keep details and action controls in separate interactive elements', () => {
  assert.doesNotMatch(html, /<div onclick="showVoucherDetails\(\$\{v\.id\}\)" class="bg-white p-4 rounded-xl border border-gray-200 shadow-sm/);
  assert.match(html, /<article class="bg-white p-4 rounded-xl border border-gray-200 shadow-sm/);
  assert.match(html, /<button type="button" onclick="showVoucherDetails\(\$\{v\.id\}\)" class="min-w-0 flex-1 text-left/);
  assert.match(html, /data-history-actions/);
  assert.match(html, /data-history-action="review"/);
  assert.match(html, /data-history-action="slip"/);
  assert.match(html, /data-history-action="details"/);
});

test('voucher cancellation and reversal have an explicit target and require a reason', () => {
  assert.match(html, /onclick="deleteVoucherById\(\$\{Number\(v\.id\)\}\)"/);
  assert.match(html, /data-delete-voucher-id="\$\{v\.id\}"/);
  assert.match(html, /data-history-action="delete"/);
  assert.match(html, /aria-label="\$\{getVoucherCorrectionAction\(v\) === 'reverseVoucher'/);
  assert.match(html, /callServerFunction\(action, \{ voucherId, reason \}/);
});

