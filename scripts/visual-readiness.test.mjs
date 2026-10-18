import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const api = readFileSync(new URL('../pages/api/ppe.js', import.meta.url), 'utf8');

test('prominent gradient surfaces use semantic high-contrast tokens', () => {
  assert.match(css, /\.brand-hero\s*\{/);
  assert.match(css, /\.brand-gradient-card\s*\{/);
  assert.match(css, /color:\s*rgba\(255, 255, 255, \.9\)\s*!important/);
  assert.match(html, /class="brand-hero rounded-xl/);
  assert.equal((html.match(/class="brand-gradient-card/g) || []).length, 4);
});

test('receive types render as full-width accessible decision cards', () => {
  assert.match(html, /role="radiogroup" aria-label="ประเภทการรับเข้าสต็อก"/);
  assert.equal((html.match(/class="receive-type-option/g) || []).length, 3);
  assert.match(css, /#receiveForm \.receive-type-option\.ui-choice-label/);
  assert.match(css, /input:focus-visible \+ \.receive-type-card/);
});

test('receive history resolves and presents equipment identity', () => {
  assert.match(html, /function getReceiveTransactionItem\(tx\)/);
  assert.match(html, /receive-history-item-image/);
  assert.match(html, /ไม่พบชื่ออุปกรณ์ในข้อมูลเดิม/);
  assert.match(api, /\.eq\('action', 'addReceiveTransaction'\)/);
  assert.match(api, /itemImageUrl: item\?\.image_url/);
});

test('production-facing headings avoid development-style mixed labels', () => {
  assert.doesNotMatch(html, /รายงานสรุป \(Report\)/);
  assert.doesNotMatch(html, /มาตรฐาน PPE \(PPE Matrix\)/);
  assert.doesNotMatch(html, /ระเบียบและประกาศ \(SHE Documents\)/);
  assert.match(html, /บันทึก PDF \/ พิมพ์/);
  assert.match(html, /ดาวน์โหลด Excel/);
});
