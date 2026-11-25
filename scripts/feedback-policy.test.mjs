import test from 'node:test';
import assert from 'node:assert/strict';
import { findIncompleteReceivedVoucher, getVoucherFeedbackProgress } from '../lib/feedback-policy.js';

const voucher = {
  id: 117,
  status: 'approved',
  status_received: 'received',
  received_at: '2026-10-17T08:00:00.000Z',
  itemsJson: JSON.stringify([{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 2 }]),
};

test('tracks rating progress and average per voucher', () => {
  const progress = getVoucherFeedbackProgress(voucher, [
    { transaction_id: 117, item_id: 1, rating: 4 },
    { transaction_id: 999, item_id: 2, rating: 5 },
  ]);
  assert.equal(progress.ratedCount, 1);
  assert.deepEqual(progress.missingItemIds, [2]);
  assert.equal(progress.complete, false);
  assert.equal(progress.average, 4);
});

test('finds an incomplete received voucher but ignores pending vouchers', () => {
  const pending = { ...voucher, id: 118, status: 'pending' };
  const result = findIncompleteReceivedVoucher([pending, voucher], [
    { transaction_id: 117, item_id: 1, rating: 5 },
  ]);
  assert.equal(result.voucher.id, 117);
  assert.deepEqual(result.progress.missingItemIds, [2]);
});

test('returns no blocker after every item is rated', () => {
  const feedback = [
    { transaction_id: 117, item_id: 1, rating: 5 },
    { transaction_id: 117, item_id: 2, rating: 4 },
  ];
  assert.equal(findIncompleteReceivedVoucher([voucher], feedback), null);
  assert.equal(getVoucherFeedbackProgress(voucher, feedback).average, 4.5);
});

test('requires ratings only for approved items on partial vouchers', () => {
  const partial = { ...voucher, status: 'partially_approved', approved_items: [{ itemId: 2, quantity: 1 }] };
  assert.deepEqual(getVoucherFeedbackProgress(partial).missingItemIds, [2]);
  assert.equal(findIncompleteReceivedVoucher([partial], [{ transaction_id: 117, item_id: 2, rating: 5 }]), null);
});

test('does not treat an unreconciled legacy voucher as received stock', () => {
  const unreconciled = { ...voucher, status: 'partially_approved', approved_items: null };
  assert.equal(getVoucherFeedbackProgress(unreconciled).total, 0);
  assert.equal(findIncompleteReceivedVoucher([unreconciled]), null);
});
