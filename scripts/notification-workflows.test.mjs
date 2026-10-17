import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationWorkflows, notificationWorkflowInternals } from '../lib/notification-workflows.js';

const USER_ID = `U${'a'.repeat(32)}`;
const ADMIN_ID = `U${'b'.repeat(32)}`;

class ReadQuery {
  constructor(rows) { this.rows = rows; this.filters = []; }
  select() { return this; }
  eq(column, value) { this.filters.push(row => row[column] === value); return this; }
  lte(column, value) { this.filters.push(row => row[column] != null && row[column] <= value); return this; }
  in(column, values) { this.filters.push(row => values.includes(row[column])); return this; }
  order() { return this; }
  then(resolve, reject) {
    return Promise.resolve({ data: this.rows.filter(row => this.filters.every(filter => filter(row))), error: null }).then(resolve, reject);
  }
}

function fixture(fallbackAdminUserId = '') {
  const tables = {
    notification_recipients: [{ id: 1, label: 'Safety', line_user_id: ADMIN_ID, enabled: true, topics: ['loan'] }],
    loan_transactions: [
      { loanId: 10, itemId: 5, borrowerName: 'Tester', department: 'SHE', dueDate: '2026-10-17', userid: USER_ID, status: 'on_loan' },
      { loanId: 11, itemId: 5, borrowerName: 'Tester', department: 'SHE', dueDate: '2026-10-20', userid: USER_ID, status: 'on_loan' },
    ],
    ppe_items: [{ id: 5, name: 'Safety Harness', code: 'PPE005', image_url: 'https://example.com/harness.png' }],
  };
  const sent = [];
  const supabase = { from: table => new ReadQuery(tables[table] || []) };
  const notificationService = {
    send: async input => {
      sent.push(input);
      return { sent: true, accepted: true, status: 'sent' };
    },
  };
  return {
    sent,
    workflows: createNotificationWorkflows({ supabase, notificationService, liffId: 'test-liff', fallbackAdminUserId }),
  };
}

test('builds LIFF deep links with module and entity context', () => {
  const { workflows } = fixture();
  assert.equal(
    workflows.buildLiffLink('loan', { loanId: 10 }),
    'https://liff.line.me/test-liff?module=loan&loanId=10',
  );
});

test('uses Bangkok date keys consistently', () => {
  assert.equal(notificationWorkflowInternals.bangkokDateKey(new Date('2026-10-16T18:30:00Z')), '2026-10-17');
  assert.equal(notificationWorkflowInternals.addDays('2026-10-17', 1), '2026-10-18');
});

test('sends due reminders to borrower and configured admin with idempotent event keys', async () => {
  const { workflows, sent } = fixture();
  const result = await workflows.sendLoanDueReminders({ now: new Date('2026-10-17T02:00:00Z') });
  assert.equal(result.checked, 1);
  assert.equal(result.processed, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].recipient, USER_ID);
  assert.equal(sent[1].recipient, ADMIN_ID);
  assert.match(sent[0].eventKey, /^loan-reminder-due-today-user:10:2026-10-17$/);
  assert.equal(sent[0].messages[0].type, 'flex');
  assert.match(JSON.stringify(sent[0].messages[0]), /module=loan&loanId=10/);
  assert.equal(sent[0].messages[0].contents.hero.url, 'https://example.com/harness.png');
});

test('respects recipient topic preferences instead of falling back to the env recipient', async () => {
  const { workflows, sent } = fixture(`U${'c'.repeat(32)}`);
  const result = await workflows.sendToAdmins({
    topic: 'stock',
    messages: [{ type: 'text', text: 'low stock' }],
    eventKey: 'stock-low:test',
  });
  assert.equal(result.recipientCount, 0);
  assert.equal(sent.length, 0);
});
