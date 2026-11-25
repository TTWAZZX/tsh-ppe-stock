export function parseVoucherItems(itemsJson) {
  if (Array.isArray(itemsJson)) return itemsJson;
  try {
    const parsed = JSON.parse(itemsJson || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getApprovedVoucherItems(voucher) {
  if (voucher?.approved_items != null) return parseVoucherItems(voucher.approved_items);
  if (!Object.hasOwn(voucher || {}, 'approved_items') && ['approved', 'completed'].includes(voucher?.status)) {
    return parseVoucherItems(voucher.itemsJson);
  }
  return null;
}

export function getVoucherFeedbackProgress(voucher, feedbackRows = []) {
  const approvedItems = getApprovedVoucherItems(voucher);
  const itemIds = [...new Set(
    (approvedItems || [])
      .map(item => Number(item?.itemId))
      .filter(itemId => Number.isInteger(itemId) && itemId > 0)
  )];
  const latestByItem = new Map();

  feedbackRows
    .filter(row => (
      String(row?.transaction_id) === String(voucher?.id)
      && (!row?.feedback_type || String(row.feedback_type) === 'issue')
    ))
    .forEach(row => {
      const itemId = Number(row?.item_id);
      if (!itemIds.includes(itemId) || latestByItem.has(itemId)) return;
      latestByItem.set(itemId, row);
    });

  const missingItemIds = itemIds.filter(itemId => !latestByItem.has(itemId));
  const ratings = [...latestByItem.values()]
    .map(row => Number(row?.rating))
    .filter(rating => Number.isFinite(rating) && rating >= 1 && rating <= 5);

  return {
    total: itemIds.length,
    ratedCount: itemIds.length - missingItemIds.length,
    missingItemIds,
    complete: itemIds.length > 0 && missingItemIds.length === 0,
    average: ratings.length
      ? Number((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length).toFixed(1))
      : null,
    latestByItem,
  };
}

export function findIncompleteReceivedVoucher(vouchers = [], feedbackRows = []) {
  return [...vouchers]
    .filter(voucher => (
      ['approved', 'partially_approved', 'completed'].includes(String(voucher?.status))
      && String(voucher?.status_received) === 'received'
    ))
    .sort((a, b) => new Date(a?.received_at || a?.timestamp || 0) - new Date(b?.received_at || b?.timestamp || 0))
    .map(voucher => ({ voucher, progress: getVoucherFeedbackProgress(voucher, feedbackRows) }))
    .find(entry => entry.progress.total > 0 && !entry.progress.complete) || null;
}
