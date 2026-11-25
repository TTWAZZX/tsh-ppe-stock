import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readInventoryPages } from '../lib/inventory-read.js';

test('reads all ordered inventory pages even if PostgREST caps each response below the requested size', async () => {
  const source = Array.from({ length: 1003 }, (_, index) => ({ loanId: index + 1 }));
  const cursors = [];
  function makeQuery() {
    let cursor = 0;
    const query = {
      order(key, options) {
        assert.equal(key, 'loanId');
        assert.equal(options.ascending, true);
        return query;
      },
      limit() { return query; },
      gt(key, value) {
        assert.equal(key, 'loanId');
        cursor = value;
        return query;
      },
      then(resolve) {
        cursors.push(cursor);
        return Promise.resolve({ data: source.filter(row => row.loanId > cursor).slice(0, 75) }).then(resolve);
      },
    };
    return query;
  }
  assert.deepEqual(await readInventoryPages(makeQuery, 'loanId'), source);
  assert.equal(cursors.at(-1), 1003);
});

test('propagates a database read error instead of presenting an empty list', async () => {
  const error = new Error('fixture database unavailable');
  const makeQuery = () => ({ order: () => ({ limit: async () => ({ data: null, error }) }) });
  await assert.rejects(readInventoryPages(makeQuery), error);
});
