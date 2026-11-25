import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineNotificationService } from '../lib/notification-service.js';

const RECIPIENT = `U${'a'.repeat(32)}`;

class Query {
  constructor(store, operation, values = null) {
    this.store = store;
    this.operation = operation;
    this.values = values;
    this.filters = [];
    this.ignoreDuplicates = false;
    this.returnRows = false;
    this.head = false;
    this.rowLimit = Infinity;
  }

  select(_columns, options = {}) { this.returnRows = true; this.head = options.head === true; return this; }
  eq(column, value) { this.filters.push(row => row[column] === value); return this; }
  in(column, values) { this.filters.push(row => values.includes(row[column])); return this; }
  lte(column, value) { this.filters.push(row => row[column] != null && row[column] <= value); return this; }
  lt(column, value) { this.filters.push(row => row[column] != null && row[column] < value); return this; }
  is(column, value) { this.filters.push(row => row[column] === value); return this; }
  order() { return this; }
  limit(value) { this.rowLimit = value; return this; }
  upsert(values, options = {}) { this.operation = 'upsert'; this.values = values; this.ignoreDuplicates = options.ignoreDuplicates; return this; }
  update(values) { this.operation = 'update'; this.values = values; return this; }
  single() { return this.execute(true, true); }
  maybeSingle() { return this.execute(true, false); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }

  matching() {
    return this.store.rows.filter(row => this.filters.every(filter => filter(row)));
  }

  async execute(single, required = false) {
    if (this.operation === 'upsert') {
      const duplicate = this.store.rows.find(row => row.channel === this.values.channel && row.event_key === this.values.event_key && row.recipient === this.values.recipient);
      if (duplicate && this.ignoreDuplicates) return { data: null, error: null };
      const row = { id: this.store.nextId++, attempts: [], provider_response: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...structuredClone(this.values) };
      this.store.rows.push(row);
      return { data: structuredClone(row), error: null };
    }
    if (this.operation === 'update') {
      if (this.store.failUpdates) return { data: null, error: new Error('Update unavailable') };
      const rows = this.matching();
      for (const row of rows) Object.assign(row, structuredClone(this.values));
      const data = single ? (rows[0] || null) : this.returnRows ? rows : null;
      return required && !data ? { data: null, error: new Error('Expected one row') } : { data: structuredClone(data), error: null };
    }
    const rows = this.matching().slice(0, this.rowLimit).map(row => structuredClone(row));
    if (this.head) return { data: null, count: rows.length, error: null };
    const data = single ? (rows[0] || null) : rows;
    return required && !data ? { data: null, error: new Error('Expected one row') } : { data, error: null };
  }
}

class FakeSupabase {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }
  from(table) {
    assert.equal(table, 'notification_log');
    return new Query(this, 'select');
  }
}

function response(status, body = {}, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function serviceWith(responses, options = {}) {
  const supabase = new FakeSupabase();
  let calls = 0;
  const fetchImpl = async () => {
    const current = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (current instanceof Error) throw current;
    return current.clone();
  };
  const service = createLineNotificationService({
    supabase,
    channelAccessToken: 'test-channel-token',
    fetchImpl,
    maxAttempts: options.maxAttempts || 5,
    inlineAttempts: options.inlineAttempts || 3,
    requestTimeoutMs: 1000,
  });
  return { service, supabase, calls: () => calls };
}

function messageInput(eventKey = 'issue-approved:101') {
  return { recipient: RECIPIENT, messages: [{ type: 'text', text: 'test' }], eventKey };
}

test('cron delivers due pending and stale processing entries and keeps future entries queued', async () => {
  const fixture = serviceWith([response(200)]);
  for (const key of ['pending-due', 'pending-unscheduled', 'stale', 'future']) {
    await fixture.service.send(messageInput(key));
  }
  const [pending, unscheduled, stale, future] = fixture.supabase.rows;
  const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
  Object.assign(pending, { status: 'pending', next_attempt_at: longAgo, attempt_count: 0 });
  Object.assign(unscheduled, { status: 'pending', next_attempt_at: null, attempt_count: 0 });
  Object.assign(stale, { status: 'processing', updated_at: longAgo });
  Object.assign(future, { status: 'retry_scheduled', next_attempt_at: new Date(Date.now() + 60_000).toISOString() });

  const result = await fixture.service.retryDue();
  assert.equal(result.recovered, 1);
  assert.equal(result.processed, 3);
  assert.equal(result.sent, 3);
  assert.equal(result.overdue, 0);
  assert.equal(future.status, 'retry_scheduled');
  assert.equal((await fixture.service.retryDue()).processed, 0);
});

test('cron surfaces a failed recovery write', async () => {
  const fixture = serviceWith([response(200)]);
  fixture.supabase.failUpdates = true;
  await assert.rejects(fixture.service.retryDue(), /Update unavailable/);
});

test('retries retryable LINE response and records the accepted request', async () => {
  const fixture = serviceWith([
    response(500, { message: 'temporary' }),
    response(200, {}, { 'x-line-request-id': 'req-123' }),
  ]);
  const result = await fixture.service.send(messageInput());
  assert.equal(result.sent, true);
  assert.equal(result.status, 'sent');
  assert.equal(result.attemptCount, 2);
  assert.equal(result.requestId, 'req-123');
  assert.equal(fixture.calls(), 2);
  assert.equal(fixture.supabase.rows[0].attempts.length, 2);
});

test('uses the durable event key idempotently and does not send twice', async () => {
  const fixture = serviceWith([response(200, {}, { 'x-line-request-id': 'req-once' })]);
  const first = await fixture.service.send(messageInput());
  const second = await fixture.service.send(messageInput());
  assert.equal(first.sent, true);
  assert.equal(second.sent, true);
  assert.equal(second.idempotent, true);
  assert.equal(fixture.calls(), 1);
});

test('does not retry a permanent 400 response', async () => {
  const fixture = serviceWith([response(400, { message: 'invalid recipient' })]);
  const result = await fixture.service.send(messageInput('issue-rejected:102'));
  assert.equal(result.sent, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.providerStatus, 400);
  assert.equal(result.attemptCount, 1);
  assert.equal(fixture.calls(), 1);
});

test('schedules a later retry after inline network retries are exhausted', async () => {
  const fixture = serviceWith([new Error('network down')]);
  const result = await fixture.service.send(messageInput('loan-created-user:103'));
  assert.equal(result.sent, false);
  assert.equal(result.status, 'retry_scheduled');
  assert.equal(result.attemptCount, 3);
  assert.ok(result.nextRetryAt);
  assert.equal(fixture.calls(), 3);
});

test('treats LINE 409 retry-key response as an accepted duplicate', async () => {
  const fixture = serviceWith([response(409, {}, { 'x-line-accepted-request-id': 'accepted-123' })]);
  const result = await fixture.service.send(messageInput('issue-received-admin:104'));
  assert.equal(result.sent, true);
  assert.equal(result.status, 'duplicate');
  assert.equal(result.duplicatePrevented, true);
  assert.equal(result.requestId, 'accepted-123');
});
