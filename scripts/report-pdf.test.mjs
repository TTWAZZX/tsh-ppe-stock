import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const designSystem = readFileSync(new URL('../styles/design-system.css', import.meta.url), 'utf8');
const source = `${html}\n${designSystem}`;

test('report PDF uses a dedicated A4 document instead of printing the live dashboard', () => {
  assert.match(source, /@page\s*{[\s\S]*?size:\s*A4 landscape/);
  assert.match(html, /<section id="reportPrintDocument" aria-hidden="true"><\/section>/);
  assert.match(html, /function buildReportPrintDocument\(\)/);
  assert.match(html, /const printDocument = buildReportPrintDocument\(\)/);
  assert.doesNotMatch(html, /renderReportTable\(true\)/);
});

test('print document contains filters, KPIs, rankings and every detail column', () => {
  assert.match(html, /report-print-filters/);
  assert.match(html, /report-print-kpis/);
  assert.match(html, /report-print-summary/);
  assert.match(html, /อุปกรณ์ที่เบิกสูงสุด/);
  assert.match(html, /การเบิกตามแผนก/);
  assert.match(html, /รายละเอียดรายการเบิก/);
  assert.match(html, /วันและเวลา/);
  assert.match(html, /ผู้เบิก \/ แผนก/);
  assert.match(html, /getReportPrintStatusLabel/);
});

test('print waits for fonts and resets its accessibility state after printing', () => {
  assert.match(html, /if \(document\.fonts\?\.ready\) await document\.fonts\.ready/);
  assert.match(html, /addEventListener\('afterprint',[\s\S]*?aria-hidden', 'true'/);
});
