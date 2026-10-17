import test from 'node:test';
import assert from 'node:assert/strict';
import { createPpeFlexMessage } from '../lib/line-flex.js';

test('creates a valid PPE Flex bubble with a deep-link button', () => {
  const message = createPpeFlexMessage({
    title: 'ใบเบิก #118',
    status: 'รออนุมัติ',
    fields: [{ label: 'ผู้เบิก', value: 'Local Tester' }],
    items: ['ถุงมือ x 2 คู่'],
    theme: 'pending',
    actionLabel: 'ตรวจสอบคำขอ',
    actionUrl: 'https://liff.line.me/test-liff?module=pending&voucherId=118',
  });

  assert.equal(message.type, 'flex');
  assert.equal(message.contents.type, 'bubble');
  assert.ok(message.altText.length > 0 && message.altText.length <= 1500);
  assert.equal(message.contents.footer.contents[0].action.type, 'uri');
  assert.match(message.contents.footer.contents[0].action.uri, /module=pending/);
  assert.equal(message.contents.footer.contents[0].action.altUri.desktop, message.contents.footer.contents[0].action.uri);
  assert.doesNotMatch(JSON.stringify(message), /undefined/);
});

test('omits buttons for invalid URLs and truncates user supplied text safely', () => {
  const message = createPpeFlexMessage({
    title: 'x'.repeat(200),
    status: 'แจ้งเตือน',
    actionUrl: 'javascript:alert(1)',
    altText: 'a'.repeat(2000),
  });

  assert.equal(message.contents.footer, undefined);
  assert.equal(message.contents.header.contents[1].text.length, 120);
  assert.equal(message.altText.length, 1500);
});

test('limits visible equipment rows to keep Flex payload compact', () => {
  const message = createPpeFlexMessage({
    title: 'อุปกรณ์สต็อกต่ำ',
    status: 'ต้องดำเนินการ',
    items: Array.from({ length: 9 }, (_, index) => `อุปกรณ์ ${index + 1}`),
  });
  const serialized = JSON.stringify(message);
  assert.match(serialized, /และอีก 3 รายการ/);
  assert.doesNotMatch(serialized, /อุปกรณ์ 7/);
});
