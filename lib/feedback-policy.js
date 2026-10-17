export function parseVoucherItems(itemsJson) {
  if (Array.isArray(itemsJson)) return itemsJson;
  try {
    const parsed = JSON.parse(itemsJson || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getVoucherFeedbackProgress(voucher, feedbackRows = []) {
  const itemIds = [...new Set(
    parseVoucherItems(voucher?.itemsJson)
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
      ['approved', 'partially_approved'].includes(String(voucher?.status))
      && String(voucher?.status_received) === 'received'
    ))
    .sort((a, b) => new Date(a?.received_at || a?.timestamp || 0) - new Date(b?.received_at || b?.timestamp || 0))
    .map(voucher => ({ voucher, progress: getVoucherFeedbackProgress(voucher, feedbackRows) }))
    .find(entry => !entry.progress.complete) || null;
}
