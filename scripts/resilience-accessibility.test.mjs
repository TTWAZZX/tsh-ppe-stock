import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('shared refresh flow deduplicates work and exposes accessible busy state', () => {
  assert.match(html, /let refreshDataPromise = null;/);
  assert.match(html, /if \(refreshDataPromise\) return refreshDataPromise;/);
  assert.match(html, /function syncRefreshControls\(isBusy, extraButton = null\)/);
  assert.match(html, /button\.setAttribute\('aria-busy', String\(isBusy\)\)/);
  assert.match(html, /showPage\(canAccessModule\(_activePage\)/);
});

test('offline state fails visibly while preserving read-only and export guidance', () => {
  assert.match(html, /id="networkStatusBanner"/);
  assert.match(html, /function setupConnectivityStatus\(\)/);
  assert.match(html, /window\.addEventListener\('offline'/);
  assert.match(html, /window\.addEventListener\('online'/);
  assert.match(html, /ยังดูข้อมูลที่เปิดไว้และ Export ได้/);
});

test('history and report exports lock duplicate actions and announce progress', () => {
  assert.match(html, /let isHistoryExporting = false;/);
  assert.match(html, /if \(isHistoryExporting\) return;/);
  assert.match(html, /let reportExportAction = '';/);
  assert.match(html, /if \(reportExportAction\) return;/);
  assert.match(html, /function downloadCsvFile\(content, fileName\)/);
  assert.match(html, /กำลังสร้างไฟล์…/);
  assert.match(html, /กำลังเตรียม…/);
});

test('global accessibility includes skip navigation, live status, dialog semantics and Escape', () => {
  assert.match(html, /href="#mainContent" class="skip-link/);
  assert.match(html, /id="appStatusAnnouncer".*role="status".*aria-live="polite"/);
  assert.match(html, /id="mainContent" tabindex="-1"/);
  assert.match(html, /id="matrixRuleModal".*role="dialog".*aria-modal="true"/);
  assert.match(html, /id="uploadDocModal".*role="dialog".*aria-modal="true"/);
  assert.match(html, /if \(event\.key !== 'Escape'\) return;/);
  assert.match(html, /:focus-visible/);
});
