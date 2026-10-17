import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const api = await readFile(new URL('../pages/api/ppe.js', import.meta.url), 'utf8');

test('admin dashboard exposes action-first operational sections', () => {
  assert.match(html, /id="adminUrgentActions"/);
  assert.match(html, /id="overdueLoansList"/);
  assert.match(html, /id="recentActivityFeed"/);
  assert.match(html, /งานเร่งด่วน/);
  assert.match(html, /รายการยืมเกินกำหนด/);
  assert.match(html, /LINE รอส่งซ้ำ\/ไม่สำเร็จ/);
  assert.match(html, /ความเคลื่อนไหวล่าสุด/);
});

test('urgent dashboard counts aged approvals, overdue loans and LINE failures', () => {
  assert.match(html, /function getAgedPendingVouchers\(hours = 24\)/);
  assert.match(html, /function getDashboardOverdueLoans\(\)/);
  assert.match(html, /function updateUrgentActions\(\)/);
  assert.match(html, /notificationFailures/);
  assert.match(html, /updateUrgentActions\(\);/);
});

test('dashboard actions route to their owning modules', () => {
  assert.match(html, /onclick="showPage\('pending'\)"/);
  assert.match(html, /onclick="showPage\('loan'\)"/);
  assert.match(html, /onclick="openFailedNotifications\(\)"/);
  assert.match(html, /statusFilter\.value = 'attention'/);
  assert.match(html, /statusFilter === 'attention'/);
  assert.match(html, /function openDashboardActivity\(type, id\)/);
});

test('initial admin data includes a bounded and recoverable notification failure summary', () => {
  assert.match(api, /let notificationFailures = \{ count: 0, recent: \[\], available: true \};/);
  assert.match(api, /\.in\('status', \['failed', 'retry_scheduled'\]\)/);
  assert.match(api, /\.limit\(5\)/);
  assert.match(api, /failedNotifications\.error/);
  assert.match(api, /notificationFailures,/);
});

