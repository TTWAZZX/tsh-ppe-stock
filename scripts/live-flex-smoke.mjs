import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';
import { createPpeFlexMessage } from '../lib/line-flex.js';
import { createLineNotificationService } from '../lib/notification-service.js';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

if (!process.argv.includes('--confirm-live')) {
  throw new Error('คำสั่งนี้ส่ง LINE จริง กรุณารันพร้อม --confirm-live');
}

const required = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'ADMIN_LINE_USER_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const service = createLineNotificationService({
  supabase,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});
const recipient = process.env.ADMIN_LINE_USER_ID;
const { data: imageItems, error: imageError } = await supabase
  .from('ppe_items')
  .select('id,name,code,unit,image_url')
  .is('deleted_at', null)
  .not('image_url', 'is', null)
  .limit(2);
if (imageError) throw imageError;
if (!imageItems?.length) throw new Error('ไม่พบอุปกรณ์ที่มีรูปภาพสำหรับ Live Flex test');
const primaryItem = imageItems[0];
const secondaryItem = imageItems[1] || imageItems[0];
const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const liffId = process.env.LIFF_ID || '2007053300-JTSerFbF';
const link = (moduleName, params = {}) => {
  const query = new URLSearchParams({ module: moduleName, ...params });
  return `https://liff.line.me/${liffId}?${query.toString()}`;
};

const commonIssue = {
  fields: [
    { label: 'ผู้เบิก', value: 'Admin Flex Tester' },
    { label: 'แผนก', value: 'SAFETY HEALTH & ENVIRONMENT SEC.' },
  ],
  items: [
    { text: `${primaryItem.name} x 2 ${primaryItem.unit || 'หน่วย'}`, imageUrl: primaryItem.image_url },
    { text: `${secondaryItem.name} x 1 ${secondaryItem.unit || 'หน่วย'}`, imageUrl: secondaryItem.image_url },
  ],
};
const commonLoan = {
  fields: [
    { label: 'อุปกรณ์', value: primaryItem.name },
    { label: 'ผู้ยืม', value: 'Admin Flex Tester' },
    { label: 'แผนก', value: 'SAFETY HEALTH & ENVIRONMENT SEC.' },
    { label: 'กำหนดคืน', value: '18 ต.ค. 2569' },
  ],
  heroImageUrl: primaryItem.image_url,
};

const cases = [
  { key: 'issue-created-user', title: 'รับคำขอใบเบิก #TEST', status: 'รอผู้ดูแลตรวจสอบและอนุมัติ', theme: 'pending', url: link('allHistory', { voucherId: 'TEST' }), label: 'ติดตามสถานะ', ...commonIssue },
  { key: 'issue-created-admin', title: 'ใบเบิกใหม่ #TEST', status: 'มีคำขอใหม่รอการอนุมัติ', theme: 'pending', url: link('pending', { voucherId: 'TEST' }), label: 'ตรวจสอบคำขอ', ...commonIssue },
  { key: 'issue-approved', title: 'ใบเบิก #TEST', status: 'อนุมัติใบเบิกเรียบร้อยแล้ว', theme: 'success', url: link('allHistory', { mode: 'confirmReceive', voucherId: 'TEST' }), label: 'ยืนยันรับของ', ...commonIssue },
  { key: 'issue-partial', title: 'ใบเบิก #TEST', status: 'อนุมัติใบเบิกบางส่วน', summary: 'โปรดตรวจสอบจำนวนที่ได้รับอนุมัติ', theme: 'partial', url: link('allHistory', { mode: 'confirmReceive', voucherId: 'TEST' }), label: 'ดูรายละเอียด', ...commonIssue },
  { key: 'issue-rejected', title: 'ใบเบิก #TEST', status: 'ใบเบิกไม่ได้รับการอนุมัติ', summary: 'เหตุผล: สต็อกไม่เพียงพอ', theme: 'danger', url: link('allHistory', { voucherId: 'TEST' }), label: 'ดูรายละเอียด', ...commonIssue },
  { key: 'issue-received-admin', title: 'ใบเบิก #TEST', status: 'ผู้ใช้ยืนยันรับของแล้ว', theme: 'success', url: link('allHistory', { voucherId: 'TEST' }), label: 'ดูรายการ', fields: [{ label: 'ผู้รับ', value: 'Admin Flex Tester' }, { label: 'เวลา', value: '17 ต.ค. 2569 16:30' }], items: commonIssue.items },
  { key: 'loan-created-user', title: 'รายการยืม #TEST', status: 'บันทึกการยืมเรียบร้อยแล้ว', theme: 'info', url: link('loan', { loanId: 'TEST' }), label: 'เปิดรายการยืม', ...commonLoan },
  { key: 'loan-created-admin', title: 'มีรายการยืมใหม่ #TEST', status: 'บันทึกรายการยืมใหม่', theme: 'info', url: link('loan', { loanId: 'TEST' }), label: 'ตรวจสอบรายการ', ...commonLoan },
  { key: 'loan-returned', title: 'รายการยืม #TEST', status: 'รับคืนอุปกรณ์เรียบร้อยแล้ว', theme: 'success', url: link('allHistory', { loanId: 'TEST' }), label: 'ดูประวัติ', ...commonLoan },
  { key: 'loan-reminder-due-tomorrow-user', title: 'รายการยืม #TEST', status: 'ใกล้ครบกำหนดคืนพรุ่งนี้', theme: 'pending', url: link('loan', { loanId: 'TEST' }), label: 'เปิดรายการยืม', ...commonLoan },
  { key: 'loan-reminder-due-tomorrow-admin', title: 'ติดตามรายการยืม #TEST', status: 'ใกล้ครบกำหนดคืนพรุ่งนี้', theme: 'pending', url: link('loan', { loanId: 'TEST' }), label: 'ติดตามรายการ', ...commonLoan },
  { key: 'loan-reminder-due-today-user', title: 'รายการยืม #TEST', status: 'ครบกำหนดคืนวันนี้', theme: 'warning', url: link('loan', { loanId: 'TEST' }), label: 'เปิดรายการยืม', ...commonLoan },
  { key: 'loan-reminder-due-today-admin', title: 'ติดตามรายการยืม #TEST', status: 'ครบกำหนดคืนวันนี้', theme: 'warning', url: link('loan', { loanId: 'TEST' }), label: 'ติดตามรายการ', ...commonLoan },
  { key: 'loan-reminder-overdue-user', title: 'รายการยืม #TEST', status: 'เกินกำหนดคืนแล้ว', summary: 'กรุณาคืนอุปกรณ์โดยเร็วที่สุด', theme: 'danger', url: link('loan', { loanId: 'TEST' }), label: 'เปิดรายการยืม', ...commonLoan },
  { key: 'loan-reminder-overdue-admin', title: 'ติดตามรายการยืม #TEST', status: 'เกินกำหนดคืนแล้ว', summary: 'รายการนี้ต้องติดตามการคืนอุปกรณ์', theme: 'danger', url: link('loan', { loanId: 'TEST' }), label: 'ติดตามรายการ', ...commonLoan },
  { key: 'stock-low', title: 'อุปกรณ์ถึงจุดสั่งซื้อ', status: 'พบสต็อกต่ำ 2 รายการ', summary: 'กรุณาตรวจสอบและวางแผนสั่งซื้อเพิ่มเติม', theme: 'danger', url: link('manage'), label: 'จัดการอุปกรณ์', items: commonIssue.items },
];

const results = [];
for (const [index, sample] of cases.entries()) {
  const message = createPpeFlexMessage({
    eyebrow: `FLEX LIVE TEST ${index + 1}/${cases.length}`,
    title: sample.title,
    status: sample.status,
    summary: sample.summary || '',
    fields: sample.fields || [],
    items: sample.items || [],
    theme: sample.theme,
    actionLabel: sample.label,
    actionUrl: sample.url,
    heroImageUrl: sample.heroImageUrl || '',
    altText: `[FLEX TEST ${index + 1}/${cases.length}] ${sample.status}`,
  });
  const result = await service.send({
    recipient,
    messages: [message],
    eventKey: `flex-live-smoke:${runId}:${sample.key}`,
    notificationType: sample.key,
    entityType: sample.key.startsWith('loan') ? 'loan_transactions' : (sample.key.startsWith('stock') ? 'ppe_items' : 'issue_vouchers'),
    entityId: 'TEST',
    metadata: { liveSmoke: true, flow: sample.key },
  });
  results.push({ flow: sample.key, status: result.status, providerStatus: result.providerStatus, logId: result.logId, requestId: result.requestId });
  console.log(`${index + 1}/${cases.length} ${sample.key}: ${result.status} (HTTP ${result.providerStatus || '-'})`);
}

const failures = results.filter(result => result.status !== 'sent' && result.status !== 'duplicate');
console.log(JSON.stringify({ total: results.length, sent: results.length - failures.length, failed: failures.length, results }, null, 2));
if (failures.length) process.exitCode = 1;
