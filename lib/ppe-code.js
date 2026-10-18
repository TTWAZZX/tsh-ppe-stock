const PPE_CODE_PATTERN = /^PPE(\d+)$/i;

export function getPpeCodeSequence(value) {
  const match = String(value || '').trim().match(PPE_CODE_PATTERN);
  if (!match) return null;

  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

export function getNextPpeCode(items = []) {
  const highestSequence = items.reduce((highest, item) => {
    const code = typeof item === 'string' ? item : item?.code;
    const sequence = getPpeCodeSequence(code);
    return sequence === null ? highest : Math.max(highest, sequence);
  }, 0);

  return `PPE${String(highestSequence + 1).padStart(3, '0')}`;
}
