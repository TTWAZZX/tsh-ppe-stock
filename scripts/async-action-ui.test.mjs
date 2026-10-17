import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const apiClient = await readFile(new URL('../public/js/api-client.js', import.meta.url), 'utf8');

test('admin login prevents duplicate submits and exposes local progress', () => {
  assert.match(html, /let isAdminLoginSubmitting = false;/);
  assert.match(html, /if \(isAdminLoginSubmitting\) return;/);
  assert.match(html, /id="loginSubmitContent"/);
  assert.match(html, /กำลังเข้าสู่ระบบ…/);
});

test('return and voucher delete actions track pending rows', () => {
  assert.match(html, /const returningLoanIds = new Set\(\);/);
  assert.match(html, /returningLoanIds\.has\(pendingKey\)/);
  assert.match(html, /กำลังรับคืน…/);
  assert.match(html, /const deletingVoucherIds = new Set\(\);/);
  assert.match(html, /deletingVoucherIds\.has\(pendingKey\)/);
  assert.match(html, /isDeletingVoucher \? 'disabled aria-busy="true"'/);
});

test('category save and delete actions lock controls and recover in finally', () => {
  assert.match(html, /let isSavingCategory = false;/);
  assert.match(html, /const deletingCategoryIds = new Set\(\);/);
  assert.match(html, /function syncCategoryActionState\(\)/);
  assert.match(html, /กำลังบันทึก…/);
  assert.match(html, /finally \{\s*isSavingCategory = false;/);
  assert.match(html, /finally \{\s*deletingCategoryIds\.delete\(pendingKey\);/);
});

test('API client assigns independent loading keys and messages', () => {
  assert.match(apiClient, /deleteCategory:\s*\{ key: 'action\.deleteCategory'/);
  assert.match(apiClient, /deleteVoucher:\s*\{ key: 'action\.deleteVoucher'/);
  assert.match(apiClient, /saveCategory:\s*'กำลังบันทึกหมวดหมู่\.\.\.'/);
  assert.match(apiClient, /deleteCategory:\s*'กำลังลบหมวดหมู่\.\.\.'/);
  assert.match(apiClient, /deleteVoucher:\s*'กำลังลบใบเบิก\.\.\.'/);
});

test('Notification Center exposes loading states and duplicate-action guards', () => {
  assert.match(html, /let notificationCenterLoadPromise = null;/);
  assert.match(html, /function setNotificationCenterLoading\(isLoading\)/);
  assert.match(html, /let isSavingNotificationRecipient = false;/);
  assert.match(html, /const pendingNotificationRecipientIds = new Set\(\);/);
  assert.match(html, /const retryingNotificationIds = new Set\(\);/);
  assert.match(html, /if \(retryingNotificationIds\.has\(pendingKey\)\) return;/);
  assert.match(html, /if \(isRetryingDueNotifications \|\| isRunningLoanDueReminders\) return;/);
  assert.match(html, /if \(isRunningLoanDueReminders \|\| isRetryingDueNotifications\) return;/);
  assert.match(html, /กำลังโหลดผู้รับแจ้งเตือน\.\.\./);
  assert.match(html, /ลองโหลดอีกครั้ง/);
});

test('Matrix and document actions expose progress and duplicate-action guards', () => {
  assert.match(html, /let isSavingMatrixRule = false;/);
  assert.match(html, /const deletingMatrixRuleIds = new Set\(\);/);
  assert.match(html, /if \(isSavingMatrixRule \|\| deletingMatrixRuleIds\.size > 0\) return;/);
  assert.match(html, /aria-busy="\$\{isDeleting\}" class="p-1\.5 bg-white\/90 text-red-600/);
  assert.match(html, /let isUploadingDocument = false;/);
  assert.match(html, /const deletingDocumentIds = new Set\(\);/);
  assert.match(html, /function readDocumentAsBase64\(file\)/);
  assert.match(html, /timeoutMs: 90000/);
  assert.match(html, /function handlePdfFrameLoaded\(\)/);
  assert.match(html, /pdfViewerLoadTimeoutId = setTimeout/);
});

test('API client provides Matrix and document loading messages', () => {
  assert.match(apiClient, /saveMatrixRule:\s*'กำลังบันทึกมาตรฐาน PPE\.\.\.'/);
  assert.match(apiClient, /deleteMatrixRule:\s*'กำลังลบมาตรฐาน PPE\.\.\.'/);
  assert.match(apiClient, /deleteDocument:\s*'กำลังลบเอกสาร\.\.\.'/);
  assert.match(apiClient, /uploadDocument:\s*\{ key: 'action\.uploadDoc'.*timeoutMs: 90000/);
});
