// pages/api/ppe.js
// API เวอร์ชัน Supabase ที่เลียนแบบ Code.gs และรับ text/plain แบบเดิมจาก index.html

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { createLineNotificationService } from '../../lib/notification-service.js';
import { createNotificationWorkflows } from '../../lib/notification-workflows.js';
import { createPpeFlexMessage } from '../../lib/line-flex.js';

// สร้าง client ไปยัง Supabase ของคุณ
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ตั้งค่า admin จาก env (แทน ScriptProperties)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_BASE64 = process.env.ADMIN_PASSWORD_BASE64 || null;
const ADMIN_PASSWORD_SCRYPT = process.env.ADMIN_PASSWORD_SCRYPT || null; // ใหม่: scrypt hash
// SESSION_SECRET ต้องตั้งค่าใน Vercel Environment Variables ด้วย (สุ่ม string ยาวๆ)
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID || '2007053300';
const LIFF_ID = process.env.LIFF_ID || '2007053300-JTSerFbF';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const ADMIN_LINE_USER_ID = process.env.ADMIN_LINE_USER_ID || '';
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 นาที
const MAX_LOGIN_FAILURES = 5;
const notificationService = createLineNotificationService({
  supabase,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});
const notificationWorkflows = createNotificationWorkflows({
  supabase,
  notificationService,
  liffId: LIFF_ID,
  fallbackAdminUserId: ADMIN_LINE_USER_ID,
});

// Actions ที่ต้องเป็น Admin เท่านั้น
const ADMIN_ONLY_ACTIONS = new Set([
  'saveCategory', 'deleteCategory', 'savePpeItem', 'deletePpeItem',
  'approveVoucher', 'approvePartialVoucher', 'rejectVoucher',
  'addReceiveTransaction', 'saveMatrixRule', 'deleteMatrixRule',
  'uploadDocument', 'deleteDocument', 'deleteVoucher', 'returnItem',
  'checkLineStatus', 'getNotificationLogs', 'retryNotification', 'retryDueNotifications',
  'getNotificationRecipients', 'saveNotificationRecipient', 'toggleNotificationRecipient',
  'runLoanDueReminders',
]);

const LINE_OR_ADMIN_ACTIONS = new Set([
  'addNewVoucher', 'borrowItem', 'confirmReceive', 'saveFeedback',
]);

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
const lineIdentityCache = new Map();

// ปิด bodyParser เดิมของ Next.js เพื่อให้เราอ่าน text/plain เอง
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const rawBody = await getRawBody(req);
    const { action, payload } = JSON.parse(rawBody || '{}');
    const requestPayload = payload && typeof payload === 'object' ? payload : {};
    const auth = action === 'checkAdminCredentials'
      ? { isAdmin: false, adminUsername: null, lineUser: null }
      : await authenticateRequest(requestPayload);

    if (ADMIN_ONLY_ACTIONS.has(action) && !auth.isAdmin) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized' });
    }
    if (LINE_OR_ADMIN_ACTIONS.has(action) && !auth.isAdmin && !auth.lineUser) {
      return res.status(401).json({ status: 'error', message: 'กรุณาเข้าสู่ระบบผ่าน LINE ใหม่อีกครั้ง' });
    }

    const actor = auth.isAdmin ? `admin:${auth.adminUsername}` : (auth.lineUser?.userId || 'anonymous');

    let result;

    switch (action) {
      case 'getInitialData':
        result = await getInitialData(auth);
        break;

      case 'saveCategory':
        result = await saveCategory(payload);
        await writeAuditLog(actor, 'saveCategory', 'categories', result?.id, { name: payload.name });
        break;

      case 'deleteCategory':
        result = await deleteCategory(payload.categoryId);
        await writeAuditLog(actor, 'deleteCategory', 'categories', payload.categoryId);
        break;

      case 'savePpeItem':
        result = await savePpeItem(payload);
        await writeAuditLog(actor, 'savePpeItem', 'ppe_items', result?.item?.id, { name: payload.name, isNew: result?.isNew });
        break;

      case 'addNewVoucher':
        result = await addNewVoucher(requestPayload, auth);
        await writeAuditLog(actor, 'addNewVoucher', 'issue_vouchers', result?.id, { department: requestPayload.department, itemCount: requestPayload.items?.length });
        break;

      case 'approveVoucher':
        result = await approveVoucher(requestPayload);
        await writeAuditLog(actor, 'approveVoucher', 'issue_vouchers', requestPayload.voucherId);
        break;

      case 'approvePartialVoucher':
        result = await approvePartialVoucher(requestPayload);
        await writeAuditLog(actor, 'approvePartialVoucher', 'issue_vouchers', requestPayload.voucherId, { items: requestPayload.items });
        break;

      case 'rejectVoucher':
        result = await rejectVoucher(requestPayload);
        await writeAuditLog(actor, 'rejectVoucher', 'issue_vouchers', requestPayload.voucherId);
        break;

      case 'confirmReceive':
        result = await confirmReceive(requestPayload, auth);
        await writeAuditLog(actor, auth.isAdmin ? 'adminConfirmReceive' : 'confirmReceive', 'issue_vouchers', requestPayload.voucherId, { receivedBy: result?.receivedBy });
        break;

      case 'borrowItem':
        result = await borrowItem(requestPayload, auth);
        await writeAuditLog(actor, 'borrowItem', 'loan_transactions', result?.newLoan?.loanId, { itemId: requestPayload.itemId, department: requestPayload.department });
        break;

      case 'returnItem':
        result = await returnItem(requestPayload.loanId);
        await writeAuditLog(actor, 'returnItem', 'loan_transactions', requestPayload.loanId);
        break;

      case 'addReceiveTransaction':
        result = await addReceiveTransactionAndUpdateStock(payload);
        await writeAuditLog(actor, 'addReceiveTransaction', 'receive_transactions', result?.transaction?.id, {
          itemId: payload.itemId,
          quantity: payload.quantity,
          type: payload.type,
          department: payload.department,
          receiver: payload.user,
        });
        break;

      case 'checkAdminCredentials': {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
        result = await handleLoginWithLockout(payload.username, payload.password, ip);
        break;
      }

      case 'deletePpeItem':
        result = await deletePpeItem(payload);
        await writeAuditLog(actor, 'deletePpeItem', 'ppe_items', payload.id);
        break;

      case 'saveFeedback':
        result = await saveFeedback(requestPayload, auth);
        break;

      case 'saveMatrixRule':
        result = await saveMatrixRule(payload);
        await writeAuditLog(actor, 'saveMatrixRule', 'ppe_matrix', result?.id, { jobFunction: payload.jobFunction });
        break;

      case 'deleteMatrixRule':
        result = await deleteMatrixRule(payload);
        await writeAuditLog(actor, 'deleteMatrixRule', 'ppe_matrix', payload.id);
        break;

      case 'uploadDocument':
        result = await uploadDocument(payload);
        await writeAuditLog(actor, 'uploadDocument', 'ppe_documents', result?.id, { title: payload.title });
        break;

      case 'deleteDocument':
        result = await deleteDocument(payload);
        await writeAuditLog(actor, 'deleteDocument', 'ppe_documents', payload.id);
        break;

      case 'deleteVoucher':
        result = await deleteVoucher(payload.voucherId);
        await writeAuditLog(actor, 'deleteVoucher', 'issue_vouchers', payload.voucherId);
        break;

      case 'checkLineStatus':
        result = await checkLineIntegrationStatus();
        break;

      case 'getNotificationLogs':
        result = await notificationService.list({ limit: requestPayload.limit, status: requestPayload.status });
        break;

      case 'retryNotification':
        result = await notificationService.retryById(requestPayload.notificationId);
        await writeAuditLog(actor, 'retryNotification', 'notification_log', requestPayload.notificationId, { resultStatus: result?.status });
        break;

      case 'retryDueNotifications':
        result = await notificationService.retryDue({ limit: requestPayload.limit });
        await writeAuditLog(actor, 'retryDueNotifications', 'notification_log', '', { processed: result?.processed, sent: result?.sent });
        break;

      case 'getNotificationRecipients':
        result = await notificationWorkflows.listRecipients();
        break;

      case 'saveNotificationRecipient':
        result = await notificationWorkflows.saveRecipient(requestPayload);
        await writeAuditLog(actor, 'saveNotificationRecipient', 'notification_recipients', result?.id, { label: result?.label, topics: result?.topics });
        break;

      case 'toggleNotificationRecipient':
        result = await notificationWorkflows.setRecipientEnabled(requestPayload);
        await writeAuditLog(actor, 'toggleNotificationRecipient', 'notification_recipients', result?.id, { enabled: result?.enabled });
        break;

      case 'runLoanDueReminders':
        result = await notificationWorkflows.sendLoanDueReminders();
        await writeAuditLog(actor, 'runLoanDueReminders', 'loan_transactions', '', { checked: result?.checked, processed: result?.processed });
        break;

      default:
        return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }

    return res.status(200).json({ status: 'success', data: result, version: '2.0-enterprise' });
  } catch (err) {
    if (!Number.isInteger(err.statusCode) || err.statusCode >= 500) console.error('API Error:', err);
    // ส่งเฉพาะ error message ที่เป็น Thai (business logic) กลับไป frontend
    // ป้องกัน Supabase internals / schema info หลุดออกไป
    const isSafeMessage = !/supabase|postgres|connection|ECONN|ETIMED|permission denied|relation|column|syntax/i.test(err.message);
    const clientMessage = isSafeMessage ? err.message : 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง';
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    return res.status(statusCode).json({ status: 'error', message: clientMessage });
  }
}

// ------------------------- Enterprise Helper Functions -------------------------

async function authenticateRequest(payload) {
  const providedAdminToken = String(payload?.adminToken || '').trim();
  const adminUsername = providedAdminToken && verifyAdminToken(providedAdminToken)
    ? extractUsernameFromToken(providedAdminToken)
    : null;
  if (adminUsername) return { isAdmin: true, adminUsername, lineUser: null };
  if (providedAdminToken) throw createHttpError(403, 'เซสชัน Admin หมดอายุ กรุณาเข้าสู่ระบบใหม่');

  const lineAccessToken = String(payload?.lineAccessToken || '').trim();
  if (!lineAccessToken) return { isAdmin: false, adminUsername: null, lineUser: null };

  const lineUser = await verifyLineAccessToken(lineAccessToken);
  return { isAdmin: false, adminUsername: null, lineUser };
}

async function verifyLineAccessToken(accessToken) {
  const cacheKey = crypto.createHash('sha256').update(accessToken).digest('hex');
  const cached = lineIdentityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  const verifyResponse = await fetch(
    `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`,
    { method: 'GET', headers: { Accept: 'application/json' } }
  );
  const verifyData = await readJsonResponse(verifyResponse);
  if (!verifyResponse.ok || String(verifyData?.client_id || '') !== String(LINE_LOGIN_CHANNEL_ID)) {
    throw createHttpError(401, 'เซสชัน LINE ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }

  const profileResponse = await fetch('https://api.line.me/v2/profile', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const profile = await readJsonResponse(profileResponse);
  if (!profileResponse.ok || !LINE_USER_ID_PATTERN.test(String(profile?.userId || ''))) {
    throw createHttpError(401, 'ไม่สามารถยืนยันตัวตน LINE ได้ กรุณาเข้าสู่ระบบใหม่');
  }

  const safeProfile = {
    userId: profile.userId,
    displayName: String(profile.displayName || 'ผู้ใช้ LINE').trim().slice(0, 150),
  };
  const ttlMs = Math.max(10_000, Math.min(Number(verifyData.expires_in || 60) * 1000, 60_000));
  lineIdentityCache.set(cacheKey, { profile: safeProfile, expiresAt: Date.now() + ttlMs });
  if (lineIdentityCache.size > 250) {
    const now = Date.now();
    for (const [key, value] of lineIdentityCache) if (value.expiresAt <= now) lineIdentityCache.delete(key);
  }
  return safeProfile;
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function sendLinePush(userId, messages, eventKey) {
  const [notificationType, entityId] = String(eventKey || '').split(':');
  const entityType = notificationType?.startsWith('issue')
    ? 'issue_vouchers'
    : notificationType?.startsWith('loan')
      ? 'loan_transactions'
      : notificationType?.startsWith('stock')
        ? 'ppe_items'
        : null;
  return notificationService.send({
    recipient: userId,
    messages,
    eventKey,
    notificationType,
    entityType,
    entityId: entityType === 'ppe_items' ? null : entityId,
  });
}

async function checkLineIntegrationStatus() {
  const recipientState = await notificationWorkflows.listRecipients();
  if (!LINE_CHANNEL_ACCESS_TOKEN) return {
    configured: false,
    valid: false,
    adminRecipientConfigured: recipientState.recipients.some(recipient => recipient.enabled),
    adminRecipientCount: recipientState.recipients.filter(recipient => recipient.enabled).length,
  };
  const [botResponse, quotaResponse, usageResponse] = await Promise.all([
    fetch('https://api.line.me/v2/bot/info', { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }),
    fetch('https://api.line.me/v2/bot/message/quota', { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }),
    fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }),
  ]);
  if (!botResponse.ok) return { configured: true, valid: false, status: botResponse.status };
  const [bot, quota, usage] = await Promise.all([
    readJsonResponse(botResponse), readJsonResponse(quotaResponse), readJsonResponse(usageResponse),
  ]);
  let notificationLog = { available: true, counts: {} };
  try {
    const recent = await notificationService.list({ limit: 200 });
    notificationLog.counts = recent.reduce((counts, row) => {
      counts[row.status] = (counts[row.status] || 0) + 1;
      return counts;
    }, {});
    notificationLog.recent = recent.slice(0, 10);
  } catch (error) {
    notificationLog = { available: false, counts: {}, error: 'notification_log_unavailable' };
  }
  return {
    configured: true,
    valid: true,
    bot: { displayName: bot.displayName || '', basicId: bot.basicId || '' },
    quota: quotaResponse.ok ? { type: quota.type, value: quota.value ?? null, used: usage.totalUsage ?? null } : null,
    adminRecipientConfigured: recipientState.recipients.some(recipient => recipient.enabled),
    adminRecipientCount: recipientState.recipients.filter(recipient => recipient.enabled).length,
    notificationLog,
  };
}

async function getItemDetails(items) {
  const normalized = Array.isArray(items) ? items : [];
  const ids = [...new Set(normalized.map(item => Number(item.itemId)).filter(Number.isInteger))];
  const { data } = ids.length
    ? await supabase.from('ppe_items').select('id, name, unit, image_url').in('id', ids)
    : { data: [] };
  const byId = new Map((data || []).map(item => [Number(item.id), item]));
  return normalized.map(item => {
    const stored = byId.get(Number(item.itemId));
    return {
      text: `${stored?.name || `อุปกรณ์ #${item.itemId}`} x ${Number(item.quantity) || 0} ${stored?.unit || 'หน่วย'}`,
      imageUrl: stored?.image_url || '',
    };
  });
}

async function notifyVoucherStatus(voucher, statusLabel, items, eventKey, includeReceiveLink = false, notifyAdmin = false) {
  const itemDetails = await getItemDetails(items);
  const note = String(voucher.adminNotes || '').trim();
  const targetUrl = includeReceiveLink
    ? notificationWorkflows.buildLiffLink('allHistory', { mode: 'confirmReceive', voucherId: voucher.id })
    : notificationWorkflows.buildLiffLink('allHistory', { voucherId: voucher.id });
  const linkLabel = includeReceiveLink ? 'ยืนยันรับของ' : 'ดูรายละเอียด';
  const theme = eventKey.startsWith('issue-rejected')
    ? 'danger'
    : eventKey.startsWith('issue-partial')
      ? 'partial'
      : 'success';
  const userMessage = createPpeFlexMessage({
    eyebrow: 'PPE STOCK • ใบเบิก',
    title: `ใบเบิก #${voucher.id}`,
    status: statusLabel,
    summary: note ? `หมายเหตุจากผู้อนุมัติ: ${note}` : '',
    fields: [
      { label: 'ผู้เบิก', value: voucher.user || '-' },
      { label: 'แผนก', value: voucher.department || '-' },
    ],
    items: itemDetails,
    theme,
    actionLabel: linkLabel,
    actionUrl: targetUrl,
    altText: `${statusLabel} — ใบเบิก #${voucher.id}`,
  });
  const userPromise = voucher?.userid
    ? sendLinePush(voucher.userid, [userMessage], eventKey)
    : Promise.resolve({ sent: false, accepted: false, status: 'skipped', reason: 'no_recipient' });
  const adminUrl = notificationWorkflows.buildLiffLink('allHistory', { voucherId: voucher.id });
  const adminPromise = notifyAdmin
    ? notificationWorkflows.sendToAdmins({
        topic: 'issue',
        messages: [createPpeFlexMessage({
          eyebrow: 'PPE STOCK • ADMIN',
          title: `ดำเนินการใบเบิก #${voucher.id}`,
          status: statusLabel,
          summary: note ? `หมายเหตุ: ${note}` : 'ระบบส่งผลการอนุมัติให้ผู้ใช้แล้ว',
          fields: [
            { label: 'ผู้เบิก', value: voucher.user || '-' },
            { label: 'แผนก', value: voucher.department || '-' },
          ],
          items: itemDetails,
          theme,
          actionLabel: 'ดูรายการ',
          actionUrl: adminUrl,
          altText: `Admin: ${statusLabel} — ใบเบิก #${voucher.id}`,
        })],
        eventKey: `${eventKey}:admin`,
        notificationType: `${String(eventKey).split(':')[0]}-admin`,
        entityType: 'issue_vouchers',
        entityId: voucher.id,
        metadata: { statusLabel },
      })
    : Promise.resolve({ recipientCount: 0, accepted: 0, sent: 0, results: [] });
  const [userResult, adminResult] = await Promise.all([userPromise, adminPromise]);
  return { ...userResult, admin: adminResult };
}

// Audit Log: บันทึกทุก action — fire-and-forget ไม่ throw ไม่กระทบ main flow
async function writeAuditLog(actor, action, entityType, entityId, details = {}) {
  try {
    await supabase.from('audit_log').insert({
      actor: String(actor || 'anonymous'),
      action,
      entity_type: entityType,
      entity_id: String(entityId ?? ''),
      details,
    });
  } catch (e) {
    console.error('[audit_log] write failed:', e.message);
  }
}

// ดึง username จาก HMAC token
function extractUsernameFromToken(token) {
  if (!token) return 'unknown';
  const lastColon = token.lastIndexOf(':');
  const secondLast = token.lastIndexOf(':', lastColon - 1);
  return token.substring(0, secondLast) || 'unknown';
}

// Account Lockout: ตรวจ + บันทึก login attempts
async function handleLoginWithLockout(username, password, ip) {
  const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();

  const { count } = await supabase
    .from('login_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('username', username)
    .eq('success', false)
    .gte('attempted_at', windowStart);

  if ((count ?? 0) >= MAX_LOGIN_FAILURES) {
    await supabase.from('login_attempts').insert({ username, ip, success: false });
    throw new Error('บัญชีถูกล็อกชั่วคราว กรุณารอ 15 นาทีแล้วลองใหม่');
  }

  const token = await checkAdminCredentials(username, password);
  await supabase.from('login_attempts').insert({ username, ip, success: !!token });
  return token;
}

// Auto Stock Alert: แจ้ง LINE admin เมื่อ stock ต่ำกว่า reorder point
async function checkAndAlertLowStock(updatedItems) {
  if (!updatedItems?.length) return { sent: false, status: 'skipped', reason: 'no_updated_items' };

  const ids = updatedItems.map(i => Number(i.id));
  const { data: items } = await supabase
    .from('ppe_items')
    .select('id, name, stock, reorderPoint, image_url')
    .in('id', ids)
    .is('deleted_at', null);

  const lowItems = (items || []).filter(
    i => Number(i.reorderPoint) > 0 && Number(i.stock) <= Number(i.reorderPoint)
  );
  if (!lowItems.length) return { sent: false, status: 'skipped', reason: 'stock_not_low' };

  const lines = lowItems.map(i => ({
    text: `${i.name}: เหลือ ${i.stock} ชิ้น (จุดสั่งซื้อ ${i.reorderPoint})`,
    imageUrl: i.image_url || '',
  }));

  const eventKey = `stock-low:${lowItems.map(item => `${item.id}-${item.stock}`).join(',')}`;
  const stockUrl = notificationWorkflows.buildLiffLink('manage');
  return notificationWorkflows.sendToAdmins({
    topic: 'stock',
    messages: [createPpeFlexMessage({
      eyebrow: 'PPE STOCK • คลังอุปกรณ์',
      title: 'อุปกรณ์ถึงจุดสั่งซื้อ',
      status: `พบสต็อกต่ำ ${lowItems.length} รายการ`,
      summary: 'กรุณาตรวจสอบและวางแผนสั่งซื้อเพิ่มเติม',
      items: lines,
      theme: 'danger',
      actionLabel: 'จัดการอุปกรณ์',
      actionUrl: stockUrl,
      altText: `แจ้งเตือนสต็อกต่ำ ${lowItems.length} รายการ`,
    })],
    eventKey,
    notificationType: 'stock-low',
    entityType: 'ppe_items',
    metadata: { itemIds: lowItems.map(item => item.id) },
  });
}

// ------------------------- utils: อ่าน raw body -------------------------
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

// บันทึก Feedback ลง Supabase หลังตรวจสิทธิ์และความเป็นเจ้าของรายการ
async function saveFeedback(payload, auth) {
  const transactionId = Number(payload?.transactionId);
  const itemId = Number(payload?.itemId);
  const rating = Number(payload?.rating);
  const type = String(payload?.type || 'issue').trim().slice(0, 40);
  const comment = String(payload?.comment || '').trim().slice(0, 1000);
  if (!Number.isInteger(transactionId) || transactionId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
    throw new Error('ข้อมูลรายการประเมินไม่ถูกต้อง');
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('คะแนนต้องอยู่ระหว่าง 1 ถึง 5');

  let voucherQuery = supabase.from('issue_vouchers').select('id, userid, itemsJson').eq('id', transactionId);
  if (!auth.isAdmin) voucherQuery = voucherQuery.eq('userid', auth.lineUser.userId);
  const { data: voucher, error: voucherError } = await voucherQuery.maybeSingle();
  if (voucherError) throw voucherError;
  if (!voucher) throw createHttpError(403, 'คุณไม่มีสิทธิ์ประเมินรายการนี้');
  const voucherItems = Array.isArray(voucher.itemsJson) ? voucher.itemsJson : JSON.parse(voucher.itemsJson || '[]');
  if (!voucherItems.some(item => Number(item.itemId) === itemId)) throw new Error('ไม่พบอุปกรณ์นี้ในใบเบิก');

  const { data: storedItem } = await supabase.from('ppe_items').select('name').eq('id', itemId).maybeSingle();
  const user = auth.isAdmin ? `Admin (${auth.adminUsername})` : auth.lineUser.displayName;

  // Insert ลงตาราง feedback
  const { data, error } = await supabase
    .from('feedback')
    .insert([
      {
        transaction_id: transactionId,
        item_id: itemId,
        item_name: storedItem?.name || `อุปกรณ์ #${itemId}`,
        feedback_type: type,
        rating,
        comment,
        user_name: user
      }
    ])
    .select();

  if (error) {
    console.error('Supabase Feedback Error:', error);
    throw new Error(error.message);
  }

  return { status: 'success', data };
}

// ------------------------- ฟังก์ชันเดิมของคุณ (ไม่ต้องแก้) -------------------------

async function getInitialData(auth = { isAdmin: false, lineUser: null }) {
  const ppeItemsQuery = auth.isAdmin
    ? supabase.from('ppe_items').select('*').is('deleted_at', null)
    : supabase.from('ppe_items').select('id, code, name, category, unit, stock, reorderPoint, onLoanQuantity, image_url').is('deleted_at', null);
  const [
    ppeItemsRes,
    categoriesRes,
    departmentsRes,
    matrixRes,
    docsRes // ⭐ เพิ่มตัวรับ
  ] = await Promise.all([
    ppeItemsQuery,
    supabase.from('categories').select('*'),
    supabase.from('departments').select('*').order('name'),
    supabase.from('ppe_matrix').select('*'),
    supabase.from('ppe_documents').select('*').order('created_at', { ascending: false }) // ⭐ ดึงเอกสาร
  ]);

  const ppeItems = ppeItemsRes.data || [];
  const categories = categoriesRes.data || [];
  const ppeMatrix = matrixRes.data || []; // ⭐ 3. ดึง data
  const ppeDocuments = docsRes.data || []; // ⭐ ดึง data

  let issueVouchers = [];
  let receiveTransactions = [];
  let loanTransactions = [];
  let feedback = [];
  if (auth.isAdmin) {
    const [issues, receives, loans, feedbacks] = await Promise.all([
      supabase.from('issue_vouchers').select('*'),
      supabase.from('receive_transactions').select('*'),
      supabase.from('loan_transactions').select('*'),
      supabase.from('feedback').select('*').order('created_at', { ascending: false }),
    ]);
    issueVouchers = issues.data || [];
    receiveTransactions = receives.data || [];
    loanTransactions = loans.data || [];
    feedback = feedbacks.data || [];
  } else if (auth.lineUser) {
    const [issues, loans] = await Promise.all([
      supabase.from('issue_vouchers').select('*').eq('userid', auth.lineUser.userId),
      supabase.from('loan_transactions').select('*').eq('userid', auth.lineUser.userId),
    ]);
    issueVouchers = issues.data || [];
    loanTransactions = loans.data || [];
    const voucherIds = issueVouchers.map(voucher => String(voucher.id));
    if (voucherIds.length) {
      const feedbacks = await supabase.from('feedback').select('*').in('transaction_id', voucherIds).order('created_at', { ascending: false });
      feedback = feedbacks.data || [];
    }
  }

  const totalStockValue = calculateTotalStockValue(ppeItems);
  const topIssuedItems = getTopIssuedItems(issueVouchers, ppeItems, 5);
  const loanStatusSummary = getLoanStatusSummary(loanTransactions);
  const recentActivities = getRecentActivities(
    issueVouchers,
    loanTransactions,
    receiveTransactions,
    ppeItems,
    10
  );

  return {
    ppeItems,
    issueVouchers,
    receiveTransactions,
    loanTransactions,
    categories,
    departments: departmentsRes.data || [],
    feedbackData: feedback, 
    ppeMatrix,
    ppeDocuments, // ⭐ ส่งกลับหน้าบ้าน
    dashboardMetrics: {
      totalStockValue,
      topIssuedItems,
      loanStatusSummary,
      recentActivities,
    },
  };
}

async function saveCategory(categoryData) {
  if (!categoryData || !categoryData.name || categoryData.name.trim() === '') {
    throw new Error('Category name cannot be empty.');
  }
  const name = categoryData.name.trim();

  if (categoryData.id) {
    const { data, error } = await supabase
      .from('categories')
      .update({ name })
      .eq('id', categoryData.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } else {
    const nextId = await getNextId('categories', 'id');
    const { data, error } = await supabase
      .from('categories')
      .insert({ id: nextId, name })
      .select()
      .single();
    if (error) throw error;
    return data;
  }
}

async function deleteCategory(categoryId) {
  const normalizedId = Number(categoryId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('รหัสหมวดหมู่ไม่ถูกต้อง');
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('id, name')
    .eq('id', normalizedId)
    .maybeSingle();
  if (categoryError) throw categoryError;
  if (!category) throw new Error('ไม่พบหมวดหมู่ที่ต้องการลบ');

  const { count, error: countError } = await supabase
    .from('ppe_items')
    .select('*', { count: 'exact', head: true })
    .eq('category', category.name)
    .is('deleted_at', null);
  if (countError) throw countError;
  if ((count || 0) > 0) throw new Error(`ยังลบหมวดหมู่ “${category.name}” ไม่ได้ เนื่องจากมีอุปกรณ์ใช้งานอยู่ ${count} รายการ`);

  const { error } = await supabase.from('categories').delete().eq('id', normalizedId);
  if (error) throw error;
  return normalizedId;
}

async function savePpeItem(itemData) {
  if (!itemData) throw new Error('Missing item data');

  const id = itemData.id ? Number(itemData.id) : null;
  const code = String(itemData.code || '').trim().toUpperCase();
  const name = String(itemData.name || '').trim();
  const category = String(itemData.category || '').trim();
  const unit = String(itemData.unit || '').trim();
  const stock = Number(itemData.stock);
  const reorderPoint = Number(itemData.reorderPoint);
  const price = Number(itemData.price || 0);
  const imageUrl = String(itemData.imageUrl || '').trim();

  if (id !== null && (!Number.isInteger(id) || id <= 0)) throw new Error('รหัสอุปกรณ์ไม่ถูกต้อง');
  if (!code || code.length > 50) throw new Error('กรุณาระบุรหัสอุปกรณ์ไม่เกิน 50 ตัวอักษร');
  if (!name || name.length > 150) throw new Error('กรุณาระบุชื่ออุปกรณ์ไม่เกิน 150 ตัวอักษร');
  if (!category || category.length > 100) throw new Error('กรุณาเลือกหมวดหมู่ให้ถูกต้อง');
  if (!unit || unit.length > 30) throw new Error('กรุณาระบุหน่วยนับไม่เกิน 30 ตัวอักษร');
  if (!Number.isInteger(stock) || stock < 0) throw new Error('จำนวนคงเหลือต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) throw new Error('จุดสั่งซื้อต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  if (!Number.isFinite(price) || price < 0 || price > 999999999) throw new Error('ราคาต่อหน่วยไม่ถูกต้อง');
  if (imageUrl) {
    try {
      const parsedUrl = new URL(imageUrl);
      if (parsedUrl.protocol !== 'https:') throw new Error('invalid protocol');
    } catch {
      throw new Error('ลิงก์รูปภาพต้องเป็น HTTPS ที่ถูกต้อง');
    }
  }

  const [{ data: validCategory, error: categoryError }, { data: duplicateCodes, error: duplicateError }] = await Promise.all([
    supabase.from('categories').select('id').eq('name', category).limit(1).maybeSingle(),
    supabase.from('ppe_items').select('id, name').ilike('code', code).is('deleted_at', null),
  ]);
  if (categoryError) throw categoryError;
  if (duplicateError) throw duplicateError;
  if (!validCategory) throw new Error('ไม่พบหมวดหมู่ที่เลือก กรุณารีเฟรชข้อมูลแล้วลองใหม่');
  const duplicate = (duplicateCodes || []).find(item => Number(item.id) !== id);
  if (duplicate) throw new Error(`รหัส ${code} ถูกใช้กับอุปกรณ์ “${duplicate.name}” แล้ว`);

  let existingItem = null;
  if (id !== null) {
    const { data, error } = await supabase
      .from('ppe_items')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ไม่พบอุปกรณ์ที่ต้องการแก้ไข กรุณารีเฟรชข้อมูล');
    existingItem = data;
  }

  const payload = {
    code,
    name,
    category,
    unit,
    reorderPoint,
    stock,
    onLoanQuantity: existingItem ? Math.max(0, Number(existingItem.onLoanQuantity) || 0) : 0,
    price,
    image_url: imageUrl,
  };

  if (id !== null) {
    const { data, error } = await supabase
      .from('ppe_items')
      .update(payload)
      .eq('id', id)
      .eq('stock', Number(existingItem.stock) || 0)
      .is('deleted_at', null)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('ข้อมูลสต็อกถูกเปลี่ยนโดยรายการอื่น กรุณารีเฟรชแล้วตรวจสอบอีกครั้ง');
    return { item: data, isNew: false };
  } else {
    const nextId = await getNextId('ppe_items', 'id');
    const { data, error } = await supabase
      .from('ppe_items')
      .insert({
        id: nextId,
        ...payload
      })
      .select()
      .single();
    if (error) throw error;
    return { item: data, isNew: true };
  }
}

// ✅ แก้ไข: ใช้ชื่อคอลัมน์ตัวพิมพ์เล็ก (userid, employeeid)
async function addNewVoucher(voucherData, auth) {
  const ownerUserId = auth.isAdmin
    ? (LINE_USER_ID_PATTERN.test(String(voucherData.userId || '')) ? voucherData.userId : '')
    : auth.lineUser.userId;
  const requestedName = String(voucherData.user || '').trim();
  const userName = requestedName || (auth.lineUser?.displayName || 'ผู้ใช้');
  const nextId = await getNextId('issue_vouchers', 'id');
  const { data, error } = await supabase
    .from('issue_vouchers')
    .insert({
      id: nextId,
      timestamp: new Date().toISOString(),
      user: userName,
      department: voucherData.department, // แผนก
      
      // *** เปลี่ยนเป็นตัวพิมพ์เล็กให้ตรงกับ Supabase ***
      employeeid: voucherData.employeeId || '', 
      userid: ownerUserId,
      
      status: 'pending',
      adminNotes: '',
      itemsJson: voucherData.items,
    })
    .select()
    .single();
  if (error) {
      console.error("🔥 [addNewVoucher] Error:", error);
      throw error;
  }
  const itemDetails = await getItemDetails(voucherData.items);
  const userUrl = notificationWorkflows.buildLiffLink('allHistory', { voucherId: data.id });
  const adminUrl = notificationWorkflows.buildLiffLink('pending', { voucherId: data.id });
  const [userNotification, adminNotification] = await Promise.all([
    sendLinePush(ownerUserId, [createPpeFlexMessage({
      eyebrow: 'PPE STOCK • ใบเบิก',
      title: `รับคำขอใบเบิก #${data.id}`,
      status: 'รอผู้ดูแลตรวจสอบและอนุมัติ',
      summary: 'ระบบบันทึกคำขอของคุณเรียบร้อยแล้ว',
      fields: [
        { label: 'ผู้เบิก', value: userName },
        { label: 'แผนก', value: voucherData.department || '-' },
      ],
      items: itemDetails,
      theme: 'pending',
      actionLabel: 'ติดตามสถานะ',
      actionUrl: userUrl,
      altText: `รับคำขอใบเบิก #${data.id} แล้ว — รออนุมัติ`,
    })], `issue-created-user:${data.id}`),
    notificationWorkflows.sendToAdmins({
      topic: 'issue',
      messages: [createPpeFlexMessage({
        eyebrow: 'PPE STOCK • ADMIN',
        title: `ใบเบิกใหม่ #${data.id}`,
        status: 'มีคำขอใหม่รอการอนุมัติ',
        fields: [
          { label: 'ผู้เบิก', value: userName },
          { label: 'แผนก', value: voucherData.department || '-' },
        ],
        items: itemDetails,
        theme: 'pending',
        actionLabel: 'ตรวจสอบคำขอ',
        actionUrl: adminUrl,
        altText: `มีใบเบิกใหม่ #${data.id} จาก ${userName}`,
      })],
      eventKey: `issue-created-admin:${data.id}`,
      notificationType: 'issue-created-admin',
      entityType: 'issue_vouchers',
      entityId: data.id,
    }),
  ]);
  return { ...data, notification: { user: userNotification, admin: adminNotification } };
}

async function claimPendingVoucher(voucherId) {
  const normalizedId = Number(voucherId);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('รหัสใบเบิกไม่ถูกต้อง');
  const { data: voucher, error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'processing' })
    .eq('id', normalizedId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!voucher) throw new Error('ใบเบิกนี้ถูกจัดการไปแล้ว กรุณารีเฟรชข้อมูล');
  return voucher;
}

async function releaseVoucherClaim(voucherId) {
  const { error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'pending' })
    .eq('id', Number(voucherId))
    .eq('status', 'processing');
  if (error) console.error('Voucher claim rollback failed:', error);
}

function normalizeAdminNote(value) {
  return String(value || '').trim().slice(0, 500);
}

async function approveVoucher(approvalData) {
  const voucherId = Number(approvalData?.voucherId);
  const adminNote = normalizeAdminNote(approvalData?.adminNote);
  const voucher = await claimPendingVoucher(voucherId);

  const itemsToUpdate = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');
  let updatedStockItems = [];
  try {
    updatedStockItems = await updateStockLevels(itemsToUpdate, 'decrease');
    const { data: updatedVoucher, error: upErr } = await supabase
      .from('issue_vouchers')
      .update({ status: 'approved', adminNotes: adminNote || 'อนุมัติโดย Admin' })
      .eq('id', voucherId)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle();
    if (upErr) throw upErr;
    if (!updatedVoucher) throw new Error('ไม่สามารถยืนยันสถานะใบเบิกได้ กรุณาลองใหม่');
  } catch (error) {
    if (updatedStockItems.length) {
      await updateStockLevels(itemsToUpdate, 'increase').catch(rollbackError => console.error('Approval stock rollback failed:', rollbackError));
    }
    await releaseVoucherClaim(voucherId);
    throw error;
  }

  const [notification, stockNotification] = await Promise.all([
    notifyVoucherStatus(
      { ...voucher, adminNotes: adminNote || 'อนุมัติโดย Admin' },
      'อนุมัติใบเบิกเรียบร้อยแล้ว ✅',
      itemsToUpdate,
      `issue-approved:${voucherId}`,
      true,
      true
    ),
    checkAndAlertLowStock(updatedStockItems),
  ]);
  return { updatedVoucherId: voucherId, status: 'approved', updatedStockItems, notification, stockNotification };
}

async function approvePartialVoucher(approvalData) {
  const voucherId = Number(approvalData?.voucherId);
  const adminNote = normalizeAdminNote(approvalData?.adminNote);
  const voucher = await claimPendingVoucher(voucherId);

  const originalItems = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');

  const approvedItems = Array.isArray(approvalData?.items) ? approvalData.items : [];
  const seenIds = new Set();
  let allApprovedFully = true;
  const notes = ['อนุมัติบางส่วน:'];
  const itemsToUpdateInStock = [];
  try {
    for (const approved of approvedItems) {
      const itemId = Number(approved?.itemId);
      const quantity = Number(approved?.quantity);
      const original = originalItems.find((item) => Number(item.itemId) === itemId);
      if (!Number.isInteger(itemId) || itemId <= 0 || seenIds.has(itemId) || !original) throw new Error('รายการอนุมัติไม่ถูกต้องหรือซ้ำกัน');
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > Number(original.quantity)) throw new Error('จำนวนอนุมัติเกินจำนวนที่ผู้ใช้ขอ');
      seenIds.add(itemId);
      if (quantity > 0) {
        itemsToUpdateInStock.push({ itemId, quantity });
        notes.push(`- ${String(approved.itemName || `อุปกรณ์ #${itemId}`).slice(0, 160)}: ${quantity}/${Number(original.quantity)}`);
      }
      if (quantity < Number(original.quantity)) allApprovedFully = false;
    }
    if (seenIds.size !== originalItems.length) throw new Error('กรุณาตรวจสอบจำนวนอนุมัติให้ครบทุกรายการ');
  } catch (error) {
    await releaseVoucherClaim(voucherId);
    throw error;
  }

  if (itemsToUpdateInStock.length === 0) {
    await releaseVoucherClaim(voucherId);
    throw new Error('ไม่สามารถอนุมัติโดยไม่มีรายการสินค้าได้ กรุณาปฏิเสธใบเบิกแทน');
  }
  let updatedStockItems = [];
  const newStatus = allApprovedFully ? 'approved' : 'partially_approved';
  const finalNote = [notes.join(' '), adminNote].filter(Boolean).join(' | ').slice(0, 1000);
  try {
    updatedStockItems = await updateStockLevels(itemsToUpdateInStock, 'decrease');
    const { data: updatedVoucher, error: upErr } = await supabase
      .from('issue_vouchers')
      .update({ status: newStatus, adminNotes: finalNote })
      .eq('id', voucherId)
      .eq('status', 'processing')
      .select('id')
      .maybeSingle();
    if (upErr) throw upErr;
    if (!updatedVoucher) throw new Error('ไม่สามารถยืนยันสถานะใบเบิกได้ กรุณาลองใหม่');
  } catch (error) {
    if (updatedStockItems.length) {
      await updateStockLevels(itemsToUpdateInStock, 'increase').catch(rollbackError => console.error('Partial approval stock rollback failed:', rollbackError));
    }
    await releaseVoucherClaim(voucherId);
    throw error;
  }

  const [notification, stockNotification] = await Promise.all([
    notifyVoucherStatus(
      { ...voucher, adminNotes: finalNote },
      newStatus === 'approved' ? 'อนุมัติใบเบิกเรียบร้อยแล้ว ✅' : 'อนุมัติใบเบิกบางส่วน ⚠️',
      itemsToUpdateInStock,
      `issue-partial:${voucherId}:${newStatus}`,
      true,
      true
    ),
    checkAndAlertLowStock(updatedStockItems),
  ]);
  return { updatedVoucherId: voucherId, status: newStatus, updatedStockItems, notification, stockNotification };
}

async function rejectVoucher(approvalData) {
  const voucherId = Number(approvalData?.voucherId);
  const adminNote = normalizeAdminNote(approvalData?.adminNote);
  if (!Number.isInteger(voucherId) || voucherId <= 0) throw new Error('รหัสใบเบิกไม่ถูกต้อง');
  if (!adminNote) throw new Error('กรุณาระบุเหตุผลที่ปฏิเสธ');
  const { data, error } = await supabase
    .from('issue_vouchers')
    .update({ status: 'rejected', adminNotes: adminNote })
    .eq('id', voucherId)
    .eq('status', 'pending')
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('ใบเบิกนี้ถูกจัดการไปแล้ว กรุณารีเฟรชข้อมูล');
  const items = Array.isArray(data.itemsJson) ? data.itemsJson : JSON.parse(data.itemsJson || '[]');
  const notification = await notifyVoucherStatus(data, 'ใบเบิกไม่ได้รับการอนุมัติ ❌', items, `issue-rejected:${voucherId}`);
  return { updatedVoucherId: voucherId, status: 'rejected', notification };
}

async function addReceiveTransactionAndUpdateStock(tx) {
  const itemId = Number(tx?.itemId);
  const quantity = Number(tx?.quantity);
  const type = String(tx?.type || '').trim();
  const user = String(tx?.user || '').trim();
  const department = String(tx?.department || '').trim();
  const allowedTypes = new Set(['purchase', 'return', 'adjustment']);

  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('กรุณาเลือกอุปกรณ์');
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999999) throw new Error('จำนวนที่รับต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 999,999');
  if (!allowedTypes.has(type)) throw new Error('ประเภทการรับไม่ถูกต้อง');
  if (!user || user.length > 150) throw new Error('กรุณาระบุชื่อผู้รับของให้ถูกต้อง');
  if (!department || department.length > 150) throw new Error('กรุณาเลือกแผนก');

  const [{ data: item, error: itemError }, { data: masterDepartment, error: departmentError }] = await Promise.all([
    supabase.from('ppe_items').select('id, name').eq('id', itemId).is('deleted_at', null).maybeSingle(),
    supabase.from('departments').select('id, name').eq('name', department).limit(1).maybeSingle(),
  ]);
  if (itemError) throw itemError;
  if (departmentError) throw departmentError;
  if (!item) throw new Error('ไม่พบอุปกรณ์ที่เลือก กรุณารีเฟรชข้อมูล');
  if (!masterDepartment) throw new Error('ไม่พบแผนกในข้อมูลมาสเตอร์ กรุณาเลือกแผนกใหม่');

  const updatedStockItems = await updateStockLevels([{ itemId, quantity }], 'increase');
  let transaction = null;

  try {
    const nextId = await getNextId('receive_transactions', 'id');

    const { data, error: rErr } = await supabase
      .from('receive_transactions')
      .insert({
        id: nextId,
        timestamp: new Date().toISOString(),
        itemName: item.name,
        type,
        quantity,
        user,
        department: masterDepartment.name,
        status: 'completed',
      })
      .select()
      .single();
    if (rErr) throw rErr;
    transaction = data;
  } catch (transactionError) {
    try {
      await updateStockLevels([{ itemId, quantity }], 'decrease');
    } catch (rollbackError) {
      console.error('[receive] stock rollback failed:', rollbackError.message);
    }
    throw transactionError;
  }

  return { updatedStockItems, transaction };
}

// ในไฟล์ ppe.js ค้นหาฟังก์ชัน borrowItem แล้วแก้เป็นแบบนี้
async function borrowItem(borrowData, auth) {
  const itemId = Number(borrowData?.itemId);
  const borrowerName = String(borrowData?.borrowerName || auth.lineUser?.displayName || '').trim();
  const employeeId = String(borrowData?.employeeId || '').trim();
  const department = String(borrowData?.department || '').trim();
  const dueDate = String(borrowData?.dueDate || '');
  const notes = String(borrowData?.notes || '').trim().slice(0, 500);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('กรุณาเลือกอุปกรณ์ที่ต้องการยืม');
  if (!borrowerName || borrowerName.length > 150) throw new Error('กรุณาระบุชื่อผู้ยืมให้ถูกต้อง');
  if (!employeeId || employeeId.length > 50) throw new Error('กรุณาระบุรหัสพนักงานให้ถูกต้อง');
  if (!department || department.length > 150) throw new Error('กรุณาเลือกแผนก');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) {
    throw new Error('กรุณาระบุกำหนดคืนให้ถูกต้อง');
  }
  if (dueDate < today) throw new Error('กำหนดคืนต้องไม่เป็นวันที่ย้อนหลัง');

  const ownerUserId = auth.isAdmin
    ? (LINE_USER_ID_PATTERN.test(String(borrowData.userId || '')) ? borrowData.userId : '')
    : auth.lineUser.userId;
  const nextId = await getNextId('loan_transactions', 'loanId');
  const updatedItem = await updateLoanableStock(itemId, 'borrow');

  const { data, error } = await supabase
    .from('loan_transactions')
    .insert({
      loanId: nextId,
      itemId,
      borrowerName,
      
      // ✅ แก้ตรงนี้: ฝั่งซ้ายคือชื่อคอลัมน์ใน DB (ตัวเล็ก) = ฝั่งขวาคือค่าจาก Frontend (CamelCase)
      employeeid: employeeId,
      userid: ownerUserId,
      
      department,
      
      borrowDate: new Date().toISOString(),
      dueDate,
      returnDate: null,
      status: 'on_loan',
      notes,
    })
    .select()
    .single();

  if (error) {
      console.error("Database Insert Error:", error);
      // คืนจำนวนสต็อกหากบันทึกรายการยืมไม่สำเร็จ
      try {
        await updateLoanableStock(itemId, 'return');
      } catch (rollbackError) {
        console.error('Loan stock rollback failed:', rollbackError);
      }
      throw error;
  }

  const dueText = new Date(`${dueDate}T00:00:00`).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
  const loanUrl = notificationWorkflows.buildLiffLink('loan', { loanId: data.loanId });
  const userMessage = createPpeFlexMessage({
    eyebrow: 'PPE STOCK • ยืมอุปกรณ์',
    title: `รายการยืม #${data.loanId}`,
    status: 'บันทึกการยืมเรียบร้อยแล้ว',
    summary: 'โปรดคืนอุปกรณ์ภายในวันที่กำหนด',
    fields: [
      { label: 'อุปกรณ์', value: updatedItem.name || `อุปกรณ์ #${itemId}` },
      { label: 'ผู้ยืม', value: borrowerName },
      { label: 'แผนก', value: department },
      { label: 'กำหนดคืน', value: dueText },
    ],
    theme: 'info',
    actionLabel: 'เปิดรายการยืม',
    actionUrl: loanUrl,
    heroImageUrl: updatedItem.image_url,
    altText: `บันทึกรายการยืม #${data.loanId} แล้ว กำหนดคืน ${dueText}`,
  });
  const adminMessage = createPpeFlexMessage({
    eyebrow: 'PPE STOCK • ADMIN',
    title: `มีรายการยืมใหม่ #${data.loanId}`,
    status: 'บันทึกรายการยืมใหม่',
    fields: [
      { label: 'อุปกรณ์', value: updatedItem.name || `อุปกรณ์ #${itemId}` },
      { label: 'ผู้ยืม', value: borrowerName },
      { label: 'แผนก', value: department },
      { label: 'กำหนดคืน', value: dueText },
    ],
    theme: 'info',
    actionLabel: 'ตรวจสอบรายการ',
    actionUrl: loanUrl,
    heroImageUrl: updatedItem.image_url,
    altText: `มีรายการยืมใหม่ #${data.loanId} โดย ${borrowerName}`,
  });
  const [userNotification, adminNotification] = await Promise.all([
    sendLinePush(ownerUserId, [userMessage], `loan-created-user:${data.loanId}`),
    notificationWorkflows.sendToAdmins({
      topic: 'loan',
      messages: [adminMessage],
      eventKey: `loan-created-admin:${data.loanId}`,
      notificationType: 'loan-created-admin',
      entityType: 'loan_transactions',
      entityId: data.loanId,
    }),
  ]);
  return { newLoan: data, updatedItem, notification: { user: userNotification, admin: adminNotification } };
}

async function returnItem(loanId) {
  const normalizedLoanId = Number(loanId);
  if (!Number.isInteger(normalizedLoanId) || normalizedLoanId <= 0) throw new Error('รหัสรายการยืมไม่ถูกต้อง');
  const { data: loan, error } = await supabase
    .from('loan_transactions')
    .select('*')
    .eq('loanId', normalizedLoanId)
    .single();
  if (error) throw error;
  if (!loan) throw new Error('ไม่พบรายการยืม');
  if (loan.status !== 'on_loan') throw new Error('รายการนี้ถูกคืนหรือจัดการไปแล้ว');

  const updatedItem = await updateLoanableStock(loan.itemId, 'return');

  const { error: upErr } = await supabase
    .from('loan_transactions')
    .update({
      status: 'returned',
      returnDate: new Date().toISOString(),
    })
    .eq('loanId', normalizedLoanId);
  if (upErr) {
    // ย้อนจำนวนสต็อกกลับหากอัปเดตสถานะรับคืนไม่สำเร็จ
    try {
      await updateLoanableStock(loan.itemId, 'borrow');
    } catch (rollbackError) {
      console.error('Return stock rollback failed:', rollbackError);
    }
    throw upErr;
  }

  const notification = await sendLinePush(
    loan.userid,
    [createPpeFlexMessage({
      eyebrow: 'PPE STOCK • คืนอุปกรณ์',
      title: `รายการยืม #${normalizedLoanId}`,
      status: 'รับคืนอุปกรณ์เรียบร้อยแล้ว',
      fields: [
        { label: 'อุปกรณ์', value: updatedItem.name || `#${loan.itemId}` },
        { label: 'เวลารับคืน', value: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) },
      ],
      theme: 'success',
      actionLabel: 'ดูประวัติ',
      actionUrl: notificationWorkflows.buildLiffLink('allHistory', { loanId: normalizedLoanId }),
      heroImageUrl: updatedItem.image_url,
      altText: `รับคืนอุปกรณ์รายการยืม #${normalizedLoanId} เรียบร้อยแล้ว`,
    })],
    `loan-returned:${normalizedLoanId}`
  );
  return { returnedLoanId: normalizedLoanId, updatedItem, notification };
}

// สร้าง HMAC session token อายุ 24 ชั่วโมง
function generateAdminToken(username) {
  const expiry = Date.now() + 24 * 60 * 60 * 1000;
  const tokenPayload = `${username}:${expiry}`;
  const secret = SESSION_SECRET || 'no-secret-set';
  if (!SESSION_SECRET) console.warn('⚠️ SESSION_SECRET ไม่ได้ตั้งค่า กรุณาเพิ่มใน Vercel Environment Variables');
  const signature = crypto.createHmac('sha256', secret).update(tokenPayload).digest('hex');
  return `${tokenPayload}:${signature}`;
}

// ตรวจสอบ HMAC token
function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const lastColon = token.lastIndexOf(':');
  const secondLastColon = token.lastIndexOf(':', lastColon - 1);
  if (lastColon === -1 || secondLastColon === -1 || lastColon === secondLastColon) return false;
  const username = token.substring(0, secondLastColon);
  const expiry = token.substring(secondLastColon + 1, lastColon);
  const signature = token.substring(lastColon + 1);
  if (Date.now() > Number(expiry)) return false;
  const tokenPayload = `${username}:${expiry}`;
  const secret = SESSION_SECRET || 'no-secret-set';
  const expectedSig = crypto.createHmac('sha256', secret).update(tokenPayload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

async function checkAdminCredentials(username, password) {
  if (username !== ADMIN_USERNAME) return false;

  // เส้นทางหลัก: scrypt (ปลอดภัยกว่า)
  if (ADMIN_PASSWORD_SCRYPT) {
    const [salt, storedHash] = ADMIN_PASSWORD_SCRYPT.split(':');
    try {
      const derived = crypto.scryptSync(password, salt, 64).toString('hex');
      const match = crypto.timingSafeEqual(
        Buffer.from(derived, 'hex'),
        Buffer.from(storedHash, 'hex')
      );
      return match ? generateAdminToken(username) : false;
    } catch {
      return false;
    }
  }

  // fallback: Base64 (ใช้ได้จนกว่าจะ set ADMIN_PASSWORD_SCRYPT)
  if (ADMIN_PASSWORD_BASE64) {
    const provided = Buffer.from(password, 'utf8').toString('base64');
    if (provided === ADMIN_PASSWORD_BASE64) return generateAdminToken(username);
  }

  console.warn('⚠️ ไม่มี admin credentials ตั้งค่าใน environment variables');
  return false;
}

// ------------------------- helpers -------------------------
async function getNextId(tableName, colName = 'id') {
  const { data, error } = await supabase
    .from(tableName)
    .select(colName)
    .order(colName, { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0 || data[0][colName] == null) return 1;
  return Number(data[0][colName]) + 1;
}

async function updateStockLevels(items, operation = 'decrease') {
  if (!items || items.length === 0) return [];

  const normalizedItems = items.map(item => ({
    itemId: Number(item?.itemId),
    quantity: Number(item?.quantity),
  }));
  if (normalizedItems.some(item => !Number.isInteger(item.itemId) || item.itemId <= 0 || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error('รายการหรือจำนวนอุปกรณ์ไม่ถูกต้อง');
  }
  if (new Set(normalizedItems.map(item => item.itemId)).size !== normalizedItems.length) {
    throw new Error('พบรายการอุปกรณ์ซ้ำ');
  }

  const ids = normalizedItems.map((item) => item.itemId);
  const { data: ppeRows, error } = await supabase
    .from('ppe_items')
    .select('*')
    .in('id', ids)
    .is('deleted_at', null);
  if (error) throw error;
  if ((ppeRows || []).length !== ids.length) throw new Error('มีอุปกรณ์บางรายการไม่อยู่ในคลังแล้ว');

  const updatedItems = [];
  const plannedUpdates = normalizedItems.map(item => {
    const target = ppeRows.find((p) => Number(p.id) === Number(item.itemId));
    const currentStock = Number(target.stock || 0);
    const qty = item.quantity;
    const newStock = operation === 'decrease' ? currentStock - qty : currentStock + qty;
    if (newStock < 0) throw new Error(`สต็อก "${target.name}" ไม่เพียงพอ (คงเหลือ: ${currentStock}, ต้องการ: ${qty})`);
    return { target, currentStock, newStock, quantity: qty };
  });

  try {
    for (const plan of plannedUpdates) {
      const { data: updated, error: upErr } = await supabase
        .from('ppe_items')
        .update({ stock: plan.newStock })
        .eq('id', plan.target.id)
        .eq('stock', plan.currentStock)
        .select('id, stock')
        .maybeSingle();
      if (upErr) throw upErr;
      if (!updated) throw new Error(`สต็อก "${plan.target.name}" มีการเปลี่ยนแปลง กรุณารีเฟรชและตรวจสอบใหม่`);
      updatedItems.push({ id: plan.target.id, stock: plan.newStock, previousStock: plan.currentStock, quantity: plan.quantity });
    }
  } catch (updateError) {
    for (const updated of [...updatedItems].reverse()) {
      const { error: rollbackError } = await supabase
        .from('ppe_items')
        .update({ stock: updated.previousStock })
        .eq('id', updated.id)
        .eq('stock', updated.stock);
      if (rollbackError) console.error('Stock rollback failed:', rollbackError);
    }
    throw updateError;
  }

  return updatedItems;
}

async function updateLoanableStock(itemId, direction) {
  const { data: item, error } = await supabase
    .from('ppe_items')
    .select('*')
    .eq('id', itemId)
    .single();
  if (error) throw error;
  if (!item) throw new Error(`ไม่พบอุปกรณ์ ID: ${itemId}`);

  let stock = Number(item.stock || 0);
  let onLoan = Number(item.onLoanQuantity || 0);

  if (direction === 'borrow') {
    if (stock < 1) throw new Error('อุปกรณ์หมดสต็อก');
    stock -= 1;
    onLoan += 1;
  } else {
    stock += 1;
    onLoan = Math.max(0, onLoan - 1);
  }

  const { error: upErr } = await supabase
    .from('ppe_items')
    .update({
      stock,
      onLoanQuantity: onLoan,
    })
    .eq('id', itemId);
  if (upErr) throw upErr;

  return {
    id: itemId,
    code: item.code || '',
    name: item.name || '',
    unit: item.unit || '',
    image_url: item.image_url || '',
    stock,
    onLoanQuantity: onLoan,
  };
}

// ----- dashboard helpers -----
function calculateTotalStockValue(ppeItems) {
  return ppeItems.reduce((total, item) => {
    const stock = Number(item.stock || 0);
    const price = Number(item.price || 0);
    return total + stock * price;
  }, 0);
}

function getTopIssuedItems(issueVouchers, ppeItems, n) {
  const counts = {};
  issueVouchers.forEach((v) => {
    if (v.status === 'approved' || v.status === 'partially_approved') {
      let items = v.itemsJson;
      if (!Array.isArray(items)) {
        try {
          items = JSON.parse(items || '[]');
        } catch (e) {
          items = [];
        }
      }
      items.forEach((it) => {
        const qty = Number(it.quantity || 0);
        counts[it.itemId] = (counts[it.itemId] || 0) + qty;
      });
    }
  });

  return Object.entries(counts)
    .map(([itemId, totalQuantity]) => {
      const p = ppeItems.find((i) => Number(i.id) === Number(itemId));
      return {
        itemId: Number(itemId),
        itemName: p ? p.name : 'Unknown',
        totalQuantity,
      };
    })
    .sort((a, b) => b.totalQuantity - a.totalQuantity)
    .slice(0, n);
}

function getLoanStatusSummary(loanTransactions) {
  return loanTransactions.reduce(
    (acc, loan) => {
      const st = String(loan.status || '').trim();
      if (st === 'on_loan') acc.onLoan++;
      else if (st === 'returned') acc.returned++;
      return acc;
    },
    { onLoan: 0, returned: 0 }
  );
}

function getRecentActivities(issueVouchers, loanTransactions, receiveTransactions, ppeItems, limit) {
  const list = [];

  issueVouchers.forEach((v) =>
    list.push({
      type: 'issue_voucher',
      id: v.id,
      timestamp: v.timestamp,
      description: `ใบเบิก #${v.id} โดย ${v.user} (${getStatusTextServer(v.status)})`,
      status: v.status,
    })
  );

  loanTransactions.forEach((l) => {
    const itemName = ppeItems.find((i) => Number(i.id) === Number(l.itemId))?.name || 'Unknown';
    list.push({
      type: 'loan_transaction',
      id: l.loanId,
      timestamp: l.borrowDate,
      description: `ยืม: ${itemName} โดย ${l.borrowerName}`,
      status: l.status,
    });
    if (l.returnDate) {
      list.push({
        type: 'return_transaction',
        id: l.loanId,
        timestamp: l.returnDate,
        description: `คืน: ${itemName} โดย ${l.borrowerName}`,
        status: 'returned',
      });
    }
  });

  receiveTransactions.forEach((r) =>
    list.push({
      type: 'receive_transaction',
      id: r.id,
      timestamp: r.timestamp,
      description: `รับของ: ${r.itemName} x${r.quantity}`,
      status: 'completed',
    })
  );

  return list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
}

function getStatusTextServer(status) {
  const map = {
    pending: 'รออนุมัติ',
    approved: 'อนุมัติแล้ว',
    partially_approved: 'อนุมัติบางส่วน',
    rejected: 'ถูกปฏิเสธ',
    completed: 'สำเร็จ',
    on_loan: 'กำลังยืม',
    returned: 'คืนแล้ว',
  };
  return map[status] || 'ไม่ทราบ';
}

async function confirmReceive(payload, auth) {
  const voucherId = Number(payload?.voucherId);
  if (!Number.isInteger(voucherId) || voucherId <= 0) throw new Error('รหัสใบเบิกไม่ถูกต้อง');

  const { data: voucher, error: findErr } = await supabase
    .from('issue_vouchers')
    .select('*')
    .eq('id', voucherId)
    .single();

  if (findErr) throw findErr;
  if (!voucher) throw new Error('ไม่พบใบเบิก');

  if (!auth.isAdmin && String(voucher.userid || '') !== auth.lineUser.userId) {
    throw createHttpError(403, 'คุณไม่มีสิทธิ์ยืนยันรับของสำหรับใบเบิกนี้');
  }

  if (!['approved', 'partially_approved'].includes(voucher.status)) {
    throw new Error('ใบเบิกนี้ยังไม่ได้รับการอนุมัติ');
  }

  if (voucher.status_received === 'received') {
    return { status: 'already_received', voucherId, receivedBy: voucher.received_by || '-' };
  }

  const receivedBy = auth.isAdmin
    ? `Admin (${auth.adminUsername}) รับแทน ${voucher.user || 'ผู้ใช้'}`
    : auth.lineUser.displayName;

  // ✅ อัปเดตสถานะรับของ
  const { error: upErr } = await supabase
    .from('issue_vouchers')
    .update({
      status_received: 'received',
      received_at: new Date().toISOString(),
      received_by: receivedBy
    })
    .eq('id', voucherId);

  if (upErr) throw upErr;

  const receivedItems = Array.isArray(voucher.itemsJson)
    ? voucher.itemsJson
    : JSON.parse(voucher.itemsJson || '[]');
  const receivedItemDetails = await getItemDetails(receivedItems);
  const notification = await notificationWorkflows.sendToAdmins({
    topic: 'receipt',
    messages: [createPpeFlexMessage({
      eyebrow: 'PPE STOCK • รับของ',
      title: `ใบเบิก #${voucher.id}`,
      status: 'ผู้ใช้ยืนยันรับของแล้ว',
      fields: [
        { label: 'ผู้รับ', value: receivedBy },
        { label: 'เวลารับ', value: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) },
      ],
      items: receivedItemDetails,
      theme: 'success',
      actionLabel: 'ดูรายการ',
      actionUrl: notificationWorkflows.buildLiffLink('allHistory', { voucherId: voucher.id }),
      altText: `ยืนยันรับของแล้ว — ใบเบิก #${voucher.id}`,
    })],
    eventKey: `issue-received-admin:${voucher.id}`,
    notificationType: 'issue-received-admin',
    entityType: 'issue_vouchers',
    entityId: voucher.id,
  });

  return { status: 'received', voucherId, receivedBy, notification };
}

// ✅ ฟังก์ชันลบอุปกรณ์ (เวอร์ชัน Supabase)
async function deletePpeItem(payload) {
  const itemId = Number(payload?.id);
  if (!Number.isInteger(itemId) || itemId <= 0) throw new Error('รหัสอุปกรณ์ไม่ถูกต้อง');

  const [{ data: item, error: itemError }, { data: activeLoans, error: loanError }, { data: activeVouchers, error: voucherError }] = await Promise.all([
    supabase.from('ppe_items').select('id, name').eq('id', itemId).is('deleted_at', null).maybeSingle(),
    supabase.from('loan_transactions').select('loanId').eq('itemId', itemId).eq('status', 'on_loan').limit(1),
    supabase.from('issue_vouchers').select('id, items').in('status', ['pending', 'processing']),
  ]);
  if (itemError) throw itemError;
  if (loanError) throw loanError;
  if (voucherError) throw voucherError;
  if (!item) throw new Error('ไม่พบอุปกรณ์ที่ต้องการนำออก');
  if ((activeLoans || []).length > 0) throw new Error(`ยังนำ “${item.name}” ออกจากรายการไม่ได้ เนื่องจากมีรายการยืมที่ยังไม่คืน`);
  const pendingReference = (activeVouchers || []).find(voucher => (Array.isArray(voucher.items) ? voucher.items : []).some(entry => Number(entry.itemId) === itemId));
  if (pendingReference) throw new Error(`ยังนำ “${item.name}” ออกจากรายการไม่ได้ เนื่องจากอยู่ในคำขอ #${pendingReference.id} ที่กำลังดำเนินการ`);

  // Soft delete — ตั้ง deleted_at แทนการลบจริง (กู้คืนได้จาก Supabase dashboard)
  const { data, error } = await supabase
    .from('ppe_items')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', itemId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('อุปกรณ์ถูกนำออกจากรายการไปแล้ว กรุณารีเฟรชข้อมูล');
  return { status: 'success', message: 'Soft deleted successfully' };
}

async function deleteVoucher(voucherId) {
  if (!voucherId) throw new Error('Missing voucherId');

  const { error } = await supabase
    .from('issue_vouchers')
    .delete()
    .eq('id', voucherId);

  if (error) throw error;
  return { status: 'success' };
}

// ⭐⭐⭐ แก้ไขฟังก์ชันนี้ใน api/ppe.js ⭐⭐⭐
async function saveMatrixRule(payload) {
  const id = payload?.id ? Number(payload.id) : null;
  const jobFunction = String(payload?.jobFunction || '').trim();
  const department = String(payload?.department || '').trim();
  const remark = String(payload?.remark || '').trim();
  const itemsJson = Array.isArray(payload?.itemsJson) ? payload.itemsJson : [];

  if (!jobFunction) throw new Error('กรุณาระบุชื่องานหรือพื้นที่');
  if (jobFunction.length > 160) throw new Error('ชื่องานยาวเกิน 160 ตัวอักษร');
  if (department.length > 100) throw new Error('ชื่อแผนกยาวเกิน 100 ตัวอักษร');
  if (remark.length > 1000) throw new Error('รายละเอียดงานยาวเกิน 1,000 ตัวอักษร');
  if (itemsJson.length < 1 || itemsJson.length > 50) throw new Error('กรุณาเลือกอุปกรณ์ 1-50 รายการ');

  const normalizedItems = itemsJson.map(item => ({
    id: Number(item?.id),
    name: String(item?.name || '').trim().slice(0, 160),
    props: String(item?.props || '').trim().slice(0, 500),
    lifespan: String(item?.lifespan || '').trim().slice(0, 200),
  }));
  if (normalizedItems.some(item => !Number.isInteger(item.id) || item.id <= 0 || !item.name)) {
    throw new Error('กรุณาเลือกอุปกรณ์จากรายการในคลังให้ครบถ้วน');
  }
  if (new Set(normalizedItems.map(item => item.id)).size !== normalizedItems.length) {
    throw new Error('พบอุปกรณ์ซ้ำในมาตรฐาน');
  }

  const itemIds = normalizedItems.map(item => item.id);
  const { data: linkedItems, error: linkedItemsError } = await supabase
    .from('ppe_items')
    .select('id, name')
    .in('id', itemIds)
    .is('deleted_at', null);
  if (linkedItemsError) throw linkedItemsError;
  if ((linkedItems || []).length !== itemIds.length) {
    throw new Error('มีอุปกรณ์บางรายการไม่อยู่ในคลังแล้ว กรุณาเลือกใหม่');
  }
  const linkedById = new Map(linkedItems.map(item => [Number(item.id), item]));
  normalizedItems.forEach(item => { item.name = linkedById.get(item.id)?.name || item.name; });
  
  const dbPayload = {
    job_function: jobFunction,
    items_json: normalizedItems,
    lifespan: '',
    remark,
    properties: '',
    department
  };

  if (id) {
    // Update
    const { data, error } = await supabase
      .from('ppe_matrix')
      .update(dbPayload)
      .eq('id', id).select().single();
    if (error) throw error;
    return data;
  } else {
    // Insert
    const { data, error } = await supabase
      .from('ppe_matrix')
      .insert(dbPayload)
      .select().single();
    if (error) throw error;
    return data;
  }
}

async function deleteMatrixRule(payload) {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('รหัสมาตรฐานไม่ถูกต้อง');
  const { error } = await supabase.from('ppe_matrix').delete().eq('id', id);
  if (error) throw error;
  return { status: 'success' };
}

async function uploadDocument(payload) {
  const title = String(payload?.title || '').trim();
  const fileName = String(payload?.fileName || '').trim();
  const fileBase64 = String(payload?.fileBase64 || '');
  const user = String(payload?.user || 'Admin').trim().slice(0, 100);

  if (!title || !fileName || !fileBase64) throw new Error('ข้อมูลไม่ครบ กรุณาระบุชื่อและไฟล์');
  if (title.length > 200) throw new Error('ชื่อเอกสารยาวเกิน 200 ตัวอักษร');
  if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error('รองรับเฉพาะไฟล์ PDF เท่านั้น');

  // 1. แปลง Base64 กลับเป็น Buffer
  const buffer = Buffer.from(fileBase64, 'base64');

  // ตรวจสอบขนาดไฟล์ (สูงสุด 10 MB)
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (buffer.length > MAX_FILE_SIZE) throw new Error('ไฟล์ขนาดใหญ่เกินไป (สูงสุด 10 MB)');

  // ตรวจสอบว่าเป็น PDF จริง (magic bytes: %PDF)
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
    throw new Error('รองรับเฉพาะไฟล์ PDF เท่านั้น');
  }

  // Sanitize ชื่อไฟล์ ป้องกัน path traversal
  const safeFileName = fileName.replace(/[^a-zA-Z0-9ก-๙._-]/g, '_');

  // 2. ตั้งชื่อไฟล์ใหม่กันซ้ำ (timestamp_filename)
  const filePath = `${Date.now()}_${safeFileName}`;

  // 3. Upload ขึ้น Storage Bucket ชื่อ 'documents'
  const { data: uploadData, error: uploadError } = await supabase
    .storage
    .from('documents')
    .upload(filePath, buffer, {
      contentType: 'application/pdf',
      upsert: false
    });

  if (uploadError) throw uploadError;

  // 4. ขอ Public URL
  const { data: publicUrlData } = supabase
    .storage
    .from('documents')
    .getPublicUrl(filePath);

  const finalUrl = publicUrlData.publicUrl;

  // 5. บันทึกลง Database
  const { data: doc, error: dbError } = await supabase
    .from('ppe_documents')
    .insert({
      title: title,
      file_url: finalUrl,
      file_type: 'pdf',
      uploaded_by: user
    })
    .select()
    .single();

  if (dbError) throw dbError;

  return doc;
}

async function deleteDocument(payload) {
  const id = Number(payload?.id);
  if (!Number.isInteger(id) || id <= 0) throw new Error('รหัสเอกสารไม่ถูกต้อง');

  const { data: existingDoc, error: readError } = await supabase
    .from('ppe_documents')
    .select('file_url')
    .eq('id', id)
    .maybeSingle();
  if (readError) throw readError;

  // 1. ลบจาก Database
  const { error: dbError } = await supabase.from('ppe_documents').delete().eq('id', id);
  if (dbError) throw dbError;

  // 2. ลบไฟล์จาก Storage เพื่อไม่ให้เปลืองพื้นที่
  if (existingDoc?.file_url) {
    try {
      const parsedUrl = new URL(existingDoc.file_url);
      const storageFileName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '');
      if (storageFileName) {
        await supabase.storage.from('documents').remove([storageFileName]);
      }
    } catch (storageErr) {
      // ไม่ throw เพื่อไม่ให้ blocking — DB ลบแล้ว storage ไม่ blocking
      console.error('Storage delete error (non-critical):', storageErr);
    }
  }

  return { status: 'success' };
}
