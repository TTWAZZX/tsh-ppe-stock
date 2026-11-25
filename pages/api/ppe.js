// pages/api/ppe.js
// API เวอร์ชัน Supabase ที่เลียนแบบ Code.gs และรับ text/plain แบบเดิมจาก index.html

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { createLineNotificationService } from '../../lib/notification-service.js';
import { createNotificationWorkflows } from '../../lib/notification-workflows.js';
import { createPpeFlexMessage } from '../../lib/line-flex.js';
import { getApprovedVoucherItems, parseVoucherItems } from '../../lib/feedback-policy.js';
import { withApiObservability } from '../../lib/api-observability.js';
import { readInventoryPages } from '../../lib/inventory-read.js';
import { reportNotificationQueue, reportOperationalAlert } from '../../lib/operational-alerts.js';
import { createDocumentStorage, decodePdfUpload, MAX_PPE_REQUEST_BYTES } from '../../lib/document-storage.js';
import { ADMIN_SESSION_COOKIE, adminSessionCookie, createAdminSession } from '../../lib/admin-session.js';

// สร้าง client ไปยัง Supabase ของคุณ
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const documentStorage = createDocumentStorage(supabase, process.env.NEXT_PUBLIC_SUPABASE_URL);

// ตั้งค่า admin จาก env (แทน ScriptProperties)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const adminSession = createAdminSession({
  username: ADMIN_USERNAME,
  secret: process.env.SESSION_SECRET,
  passwordHash: process.env.ADMIN_PASSWORD_SCRYPT,
});
const secureAdminCookie = process.env.NODE_ENV === 'production';
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
  'uploadDocument', 'deleteDocument', 'deleteVoucher', 'reverseVoucher', 'returnItem',
  'checkLineStatus', 'getNotificationLogs', 'retryNotification', 'retryDueNotifications',
  'getNotificationRecipients', 'saveNotificationRecipient', 'toggleNotificationRecipient',
  'runLoanDueReminders', 'getIssueReport', 'listEmployeeRegistrations', 'reviewEmployeeRegistrations',
  'getAdminNotificationCounts',
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

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  try {
    const rawBody = await getRawBody(req);
    let body;
    try { body = JSON.parse(rawBody || '{}'); }
    catch { throw createHttpError(400, 'ข้อมูลคำขอไม่ใช่ JSON ที่ถูกต้อง'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw createHttpError(400, 'รูปแบบคำขอไม่ถูกต้อง');
    const { action, payload } = body;
    const requestPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    // A cross-origin browser request cannot send this header without CORS approval.
    // This API does not grant CORS access.
    const sameOriginRequest = req.headers['x-ppe-request'] === '1'
      && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
    if (['checkAdminCredentials', 'getAdminSession', 'logoutAdmin'].includes(action)) {
      if (!sameOriginRequest) throw createHttpError(403, 'คำขอนี้ต้องมาจากหน้า PPE Stock');

      const cookieOptions = { secure: secureAdminCookie };
      if (action === 'logoutAdmin') {
        res.setHeader('Set-Cookie', adminSessionCookie(null, cookieOptions));
        return res.status(200).json({ status: 'success', data: { authenticated: false } });
      }
      if (action === 'getAdminSession') {
        const token = req.cookies[ADMIN_SESSION_COOKIE];
        const authenticated = Boolean(adminSession.verify(token));
        if (token && !authenticated) res.setHeader('Set-Cookie', adminSessionCookie(null, cookieOptions));
        return res.status(200).json({ status: 'success', data: { authenticated } });
      }

      if (!adminSession.configured) {
        console.error('Admin authentication requires a valid SESSION_SECRET and ADMIN_PASSWORD_SCRYPT.');
        throw createHttpError(503, 'ระบบเข้าสู่ระบบผู้ดูแลยังไม่พร้อมใช้งาน');
      }
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? 'unknown';
      const { username, password, remember } = requestPayload;
      const authenticated = await handleLoginWithLockout(username, password, ip);
      if (authenticated) {
        res.setHeader('Set-Cookie', adminSessionCookie(adminSession.issue(), { ...cookieOptions, remember: remember === true }));
      }
      return res.status(200).json({ status: 'success', data: { authenticated } });
    }

    const adminUsername = sameOriginRequest ? adminSession.verify(req.cookies[ADMIN_SESSION_COOKIE]) : null;
    if (ADMIN_ONLY_ACTIONS.has(action) && !adminUsername) {
      throw createHttpError(403, 'กรุณาเข้าสู่ระบบผู้ดูแลใหม่อีกครั้ง', 'ADMIN_SESSION_REQUIRED');
    }
    const auth = await authenticateRequest(requestPayload, adminUsername);

    if (LINE_OR_ADMIN_ACTIONS.has(action) && !auth.isAdmin && !auth.lineUser) {
      return res.status(401).json({ status: 'error', message: 'กรุณาเข้าสู่ระบบผ่าน LINE ใหม่อีกครั้ง' });
    }
    if (LINE_OR_ADMIN_ACTIONS.has(action) && !auth.isAdmin && !auth.employee) {
      throw createHttpError(403, 'บัญชี LINE นี้ยังไม่ได้รับสิทธิ์พนักงาน กรุณาติดต่อผู้ดูแลระบบ', 'EMPLOYEE_ACCESS_REQUIRED');
    }

    const actor = auth.isAdmin ? `admin:${auth.adminUsername}` : (auth.lineUser?.userId || 'anonymous');

    let result;

    switch (action) {
      case 'getInitialData':
        result = await getInitialData(auth);
        break;
      case 'submitEmployeeRegistration':
        result = await submitEmployeeRegistration(auth, requestPayload);
        break;
      case 'listEmployeeRegistrations':
        result = await listEmployeeRegistrations();
        break;
      case 'reviewEmployeeRegistrations':
        result = await reviewEmployeeRegistrations(requestPayload, actor);
        break;
      case 'getAdminNotificationCounts':
        result = await getAdminNotificationCounts();
        break;

      case 'getIssueReport':
        result = await getIssueReport(requestPayload);
        break;

      case 'getDocumentUrl':
        result = await getDocumentUrl(requestPayload.id, auth);
        break;

      case 'saveCategory':
        result = await saveCategory(payload, actor, req.headers['x-idempotency-key']);
        await writeAuditLog(actor, 'saveCategory', 'categories', result?.id, { name: payload.name });
        break;

      case 'deleteCategory':
        result = await deleteCategory(payload.categoryId);
        await writeAuditLog(actor, 'deleteCategory', 'categories', payload.categoryId);
        break;

      case 'savePpeItem':
        result = await savePpeItem(requestPayload, actor, req.headers['x-idempotency-key']);
        await writeAuditLog(actor, 'savePpeItem', 'ppe_items', result?.item?.id, { name: payload.name, isNew: result?.isNew });
        break;

      case 'addNewVoucher':
        result = await addNewVoucher(requestPayload, auth, actor, req.headers['x-idempotency-key']);
        await writeAuditLog(actor, 'addNewVoucher', 'issue_vouchers', result?.id, { department: requestPayload.department, itemCount: requestPayload.items?.length });
        break;

      case 'approveVoucher':
      case 'approvePartialVoucher':
      case 'rejectVoucher':
        result = await changeVoucherStatus(action, requestPayload, actor, req.headers['x-idempotency-key']);
        await writeAuditLog(actor, action, 'issue_vouchers', requestPayload.voucherId, {
          status: result.status, items: result.updatedStockItems,
        });
        break;

      case 'confirmReceive':
        result = await confirmReceive(requestPayload, auth, actor, req.headers['x-idempotency-key']);
        await writeAuditLog(actor, auth.isAdmin ? 'adminConfirmReceive' : 'confirmReceive', 'issue_vouchers', requestPayload.voucherId, { receivedBy: result?.receivedBy });
        break;

      case 'borrowItem':
        result = await borrowItem(requestPayload, auth, actor, req.headers['x-idempotency-key']);
        break;

      case 'returnItem':
        result = await returnItem(requestPayload.loanId, actor, req.headers['x-idempotency-key']);
        break;

      case 'addReceiveTransaction':
        result = await addReceiveTransactionAndUpdateStock(requestPayload, actor, req.headers['x-idempotency-key']);
        break;

      case 'deletePpeItem':
        result = await deletePpeItem(requestPayload, actor, req.headers['x-idempotency-key']);
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
        result = await uploadDocument(requestPayload, auth.adminUsername);
        await writeAuditLog(actor, 'uploadDocument', 'ppe_documents', result?.id, { title: result.title });
        break;

      case 'deleteDocument':
        result = await documentStorage.remove(documentId(requestPayload.id));
        await writeAuditLog(actor, 'deleteDocument', 'ppe_documents', requestPayload.id, { status: result.status });
        break;

      case 'deleteVoucher':
      case 'reverseVoucher':
        result = await changeVoucherStatus(action, requestPayload, actor, req.headers['x-idempotency-key']);
        await writeAuditLog(actor, action, 'issue_vouchers', requestPayload.voucherId, {
          reason: normalizeAdminNote(requestPayload.reason), status: result.status, items: result.updatedStockItems,
        });
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
        await reportNotificationQueue(notificationWorkflows, result);
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
    return res.status(statusCode).json({
      status: 'error',
      message: clientMessage,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}),
    });
  }
}

export default withApiObservability('/api/ppe', handler);

// ------------------------- Enterprise Helper Functions -------------------------

async function authenticateRequest(payload, adminUsername) {
  if (adminUsername) return { isAdmin: true, adminUsername, lineUser: null };

  const lineAccessToken = String(payload?.lineAccessToken || '').trim();
  if (!lineAccessToken) return { isAdmin: false, adminUsername: null, lineUser: null };

  const lineUser = await verifyLineAccessToken(lineAccessToken);
  const { data, error } = await supabase.from('ppe_employee_access')
    .select('employee_id, employee_name, department, active')
    .eq('line_user_id', lineUser.userId).maybeSingle();
  if (error) throw error;
  const employee = data?.active ? { employeeId: data.employee_id, name: data.employee_name, department: data.department } : null;
  return { isAdmin: false, adminUsername: null, lineUser, employee, employeeDisabled: data?.active === false };
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

function createHttpError(statusCode, message, code = '', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

async function runInventoryMutation(action, payload, actor, suppliedRequestId) {
  const requestId = suppliedRequestId || crypto.randomUUID();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw createHttpError(400, 'รหัสคำขอไม่ถูกต้อง');
  }
  const args = { p_payload: payload, p_actor: actor, p_request_id: requestId };
  const { data, error } = action === 'savePpeItem'
    ? await supabase.rpc('ppe_save_categorized_inventory', args)
    : await supabase.rpc('ppe_apply_inventory', { p_action: action, ...args });
  if (error) {
    if (action === 'addNewVoucher' && error.code === 'PT409' && error.details) {
      let details;
      try { details = JSON.parse(error.details); } catch {}
      if (Number.isSafeInteger(details?.voucherId) && Array.isArray(details.missingItemIds)) {
        throw createHttpError(409, error.message, 'FEEDBACK_REQUIRED', details);
      }
    }
    if (/^PT4[0-9]{2}$/.test(error.code)) throw createHttpError(Number(error.code.slice(2)), error.message);
    throw error;
  }
  return data;
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

// A completed mutation stays successful even if its supplementary audit write fails.
async function writeAuditLog(actor, action, entityType, entityId, details = {}) {
  try {
    const { error } = await supabase.from('audit_log').insert({
      actor: String(actor || 'anonymous'),
      action,
      entity_type: entityType,
      entity_id: String(entityId ?? ''),
      details,
    });
    if (error) throw error;
  } catch (error) {
    const code = /^[A-Z0-9_]{1,12}$/.test(error?.code || '') ? error.code : 'UNKNOWN';
    await reportOperationalAlert(notificationWorkflows, {
      event: 'audit_log_write_failed',
      key: 'audit-log:' + action,
      message: 'PPE Stock: บันทึก Audit Log ไม่สำเร็จ (' + action + ') กรุณาตรวจ Vercel Logs',
      details: { action, entityType, code },
    });
  }
}

// Account Lockout: ตรวจ + บันทึก login attempts
async function handleLoginWithLockout(username, password, ip) {
  if (username !== ADMIN_USERNAME || typeof password !== 'string' || password.length > 1024) return false;
  const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_MS).toISOString();

  const { count, error } = await supabase
    .from('login_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('username', username)
    .eq('success', false)
    .gte('attempted_at', windowStart);

  if (error) throw error;
  if ((count ?? 0) >= MAX_LOGIN_FAILURES) {
    throw createHttpError(429, 'บัญชีถูกล็อกชั่วคราว กรุณารอ 15 นาทีแล้วลองใหม่');
  }

  const authenticated = await adminSession.verifyCredentials(username, password);
  const { error: writeError } = await supabase.from('login_attempts').insert({ username, ip, success: authenticated });
  if (writeError) throw writeError;
  return authenticated;
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
  if (Number(req.headers['content-length']) > MAX_PPE_REQUEST_BYTES) {
    req.resume();
    return Promise.reject(createHttpError(413, 'ขนาดคำขอใหญ่เกินกำหนด'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if (size > MAX_PPE_REQUEST_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_PPE_REQUEST_BYTES) {
        chunks.length = 0;
        reject(createHttpError(413, 'ขนาดคำขอใหญ่เกินกำหนด'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (size <= MAX_PPE_REQUEST_BYTES) resolve(Buffer.concat(chunks, size).toString('utf8'));
    });
    req.on('aborted', () => reject(createHttpError(400, 'การรับข้อมูลคำขอถูกยกเลิก')));
    req.on('error', (err) => {
      reject(err);
    });
  });
}

// บันทึก Feedback ลง Supabase หลังตรวจสิทธิ์และความเป็นเจ้าของรายการ
async function saveFeedback(payload, auth) {
  if (auth.isAdmin) throw createHttpError(403, 'ผู้ดูแลระบบไม่สามารถให้คะแนนแทนผู้ใช้');
  const voucherId = Number(payload?.transactionId);
  const itemId = Number(payload?.itemId);
  const rating = Number(payload?.rating);
  if (!Number.isSafeInteger(voucherId) || voucherId < 1 || !Number.isSafeInteger(itemId) || itemId < 1
    || !Number.isInteger(rating) || rating < 1 || rating > 5 || (payload.type && payload.type !== 'issue')) {
    throw createHttpError(400, 'ข้อมูลรายการประเมินไม่ถูกต้อง');
  }
  const { data, error } = await supabase.rpc('ppe_save_issue_feedback', {
    p_voucher_id: voucherId, p_item_id: itemId, p_line_user: auth.lineUser.userId,
    p_rating: rating, p_comment: String(payload.comment || '').trim().slice(0, 1000), p_employee_name: auth.employee.name,
  });
  if (error) {
    if (/^PT4[0-9]{2}$/.test(error.code)) throw createHttpError(Number(error.code.slice(2)), error.message);
    throw error;
  }
  return data;
}

// ------------------------- ฟังก์ชันเดิมของคุณ (ไม่ต้องแก้) -------------------------

async function getNextAvailablePpeCode() {
  const { data, error } = await supabase.rpc('ppe_next_code');
  if (error) throw error;
  return data;
}

function validDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

async function getIssueReport(payload) {
  const { startDate = '', endDate = '', department = '', status = 'issued', page = 1, pageSize = 25, search = '' } = payload;
  if ((startDate !== '' && !validDateKey(startDate)) || (endDate !== '' && !validDateKey(endDate))
    || (startDate && endDate && startDate > endDate)
    || !['issued', 'all', 'pending', 'rejected'].includes(status)
    || typeof department !== 'string' || department.length > 150
    || !Number.isInteger(page) || page < 1 || page > 100000
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250
    || typeof search !== 'string' || search.length > 150) {
    throw createHttpError(400, 'ตัวกรองรายงานไม่ถูกต้อง');
  }
  const { data, error } = await supabase.rpc('ppe_issue_report', {
    p_start: startDate || null, p_end: endDate || null, p_department: department, p_status: status,
    p_page: page, p_page_size: pageSize, p_search: search.trim(),
  });
  if (error) throw error;
  return data;
}

async function getInitialData(auth = { isAdmin: false, lineUser: null }) {
  if (!auth.isAdmin && !auth.employee) {
    const registration = auth.lineUser ? await getEmployeeRegistration(auth) : null;
    return {
      isAdmin: false, employee: null, accessStatus: auth.lineUser ? 'employee_required' : 'login_required',
      registration,
      ppeItems: [], categories: [], departments: [], issueVouchers: [], receiveTransactions: [],
      loanTransactions: [], feedbackData: [], ppeMatrix: [], ppeDocuments: [], nextPpeCode: null, dashboardMetrics: {},
    };
  }
  const ppeItemsQuery = () => auth.isAdmin
    ? supabase.from('ppe_items').select('*').is('deleted_at', null)
    : supabase.from('ppe_items').select('id, code, name, category, category_id, unit, stock, reorderPoint, onLoanQuantity, image_url').is('deleted_at', null);
  const [
    ppeItemsRes,
    categoriesRes,
    departmentsRes,
    matrixRes,
    docsRes // ⭐ เพิ่มตัวรับ
  ] = await Promise.all([
    readInventoryPages(ppeItemsQuery),
    readInventoryPages(() => supabase.from('categories').select('*')),
    readInventoryPages(() => supabase.from('departments').select('*')),
    readInventoryPages(() => supabase.from('ppe_matrix').select('*')),
    readInventoryPages(() => supabase.from('ppe_documents').select('id,title,file_type,created_at').eq('document_state', 'ready'))
  ]);

  const categories = categoriesRes;
  const categoryNames = new Map(categories.map(category => [String(category.id), category.name]));
  const ppeItems = ppeItemsRes.map(item => ({
    ...item,
    category: categoryNames.get(String(item.category_id)) ?? item.category,
  }));
  const ppeMatrix = matrixRes;
  const ppeDocuments = docsRes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  let issueVouchers = [];
  let receiveTransactions = [];
  let loanTransactions = [];
  let feedback = [];
  let nextPpeCode = null;
  let notificationFailures = { count: 0, recent: [], available: true };
  if (auth.isAdmin) {
    const [issues, receives, loans, feedbacks, failedNotifications, receiveAudits, generatedPpeCode] = await Promise.all([
      readInventoryPages(() => supabase.from('issue_vouchers').select('*')),
      readInventoryPages(() => supabase.from('receive_transactions').select('*')),
      readInventoryPages(() => supabase.from('loan_transactions').select('*'), 'loanId'),
      readInventoryPages(() => supabase.from('feedback').select('*')),
      supabase
        .from('notification_log')
        .select('id, status, notification_type, entity_type, entity_id, last_error, attempt_count, max_attempts, created_at, updated_at', { count: 'exact' })
        .in('status', ['failed', 'retry_scheduled'])
        .order('updated_at', { ascending: false })
        .limit(5),
      readInventoryPages(() => supabase
        .from('audit_log')
        .select('id, entity_id, details')
        .eq('action', 'addReceiveTransaction')
        .eq('entity_type', 'receive_transactions')),
      getNextAvailablePpeCode(),
    ]);
    nextPpeCode = generatedPpeCode;
    issueVouchers = issues.map(visibleVoucherStatus);
    const receiveAuditById = new Map(
      receiveAudits.map(entry => [String(entry.entity_id), entry.details || {}])
    );
    receiveTransactions = receives.map(transaction => {
      const details = receiveAuditById.get(String(transaction.id)) || {};
      const itemId = Number(transaction.ppe_item_id || details.itemId || transaction.itemId || transaction.item_id || 0);
      const item = itemId > 0 ? ppeItems.find(entry => Number(entry.id) === itemId) : null;
      const storedName = String(transaction.itemName || transaction.item_name || '').trim();
      const isGenericName = !storedName || ['อุปกรณ์', 'unknown', 'unknown item'].includes(storedName.toLowerCase());
      return {
        ...transaction,
        itemId: itemId || null,
        itemName: isGenericName ? (item?.name || storedName) : storedName,
        itemCode: item?.code || '',
        itemImageUrl: item?.image_url || '',
        unit: item?.unit || 'หน่วย',
      };
    });
    loanTransactions = loans;
    feedback = feedbacks;
    notificationFailures = failedNotifications.error
      ? { count: 0, recent: [], available: false }
      : {
          count: Number(failedNotifications.count || failedNotifications.data?.length || 0),
          recent: failedNotifications.data || [],
          available: true,
        };
  } else if (auth.lineUser) {
    const [issues, loans] = await Promise.all([
      readInventoryPages(() => supabase.from('issue_vouchers').select('*').eq('userid', auth.lineUser.userId)),
      readInventoryPages(() => supabase.from('loan_transactions').select('*').eq('userid', auth.lineUser.userId), 'loanId'),
    ]);
    issueVouchers = issues.map(visibleVoucherStatus);
    loanTransactions = loans;
    const voucherIds = issueVouchers.map(voucher => String(voucher.id));
    for (let start = 0; start < voucherIds.length; start += 100) {
      const ids = voucherIds.slice(start, start + 100);
      feedback.push(...await readInventoryPages(() => supabase.from('feedback').select('*').in('transaction_id', ids)));
    }
  }

  const reviewableItems = new Map(issueVouchers.filter(voucher => voucher.status_received === 'received' && !voucher.voided_at)
    .map(voucher => [String(voucher.id), new Set((getApprovedVoucherItems(voucher) || []).map(item => String(item.itemId)))]));
  feedback = feedback.filter(row => (!row.feedback_type || row.feedback_type === 'issue')
    && reviewableItems.get(String(row.transaction_id))?.has(String(row.item_id)));

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
    isAdmin: auth.isAdmin,
    employee: auth.employee || null,
    accessStatus: 'authorized',
    ppeItems,
    issueVouchers,
    receiveTransactions,
    loanTransactions,
    categories,
    departments: departmentsRes.sort((a, b) => a.name.localeCompare(b.name, 'th')),
    feedbackData: feedback.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    ppeMatrix,
    ppeDocuments, // ⭐ ส่งกลับหน้าบ้าน
    nextPpeCode,
    dashboardMetrics: {
      totalStockValue,
      topIssuedItems,
      loanStatusSummary,
      recentActivities,
      notificationFailures,
    },
  };
}

async function getEmployeeRegistration(auth) {
  if (auth.employeeDisabled) return { status: 'disabled' };
  const { data: row, error } = await supabase.from('ppe_employee_registrations')
    .select('employee_id,employee_name,department,status,rejection_reason')
    .eq('line_user_id', auth.lineUser.userId).maybeSingle();
  if (error) throw error;
  const status = row?.status || 'unregistered';
  const selectable = ['unregistered', 'rejected'].includes(status);
  const departments = selectable ? await readInventoryPages(() => supabase.from('departments').select('id,name')) : [];
  return {
    status, departments: departments.sort((a, b) => a.name.localeCompare(b.name, 'th')),
    employeeId: row?.employee_id,
    name: row?.employee_name || auth.lineUser.displayName,
    department: row?.department,
    reason: status === 'rejected' ? row.rejection_reason : undefined,
  };
}

async function registrationRpc(name, payload) {
  const { data, error } = await supabase.rpc(name, payload);
  if (error) {
    if (/^PT4[0-9]{2}$/.test(error.code)) throw createHttpError(Number(error.code.slice(2)), error.message);
    throw error;
  }
  return data;
}

async function submitEmployeeRegistration(auth, payload) {
  if (auth.isAdmin) throw createHttpError(403, 'กรุณาลงทะเบียนด้วยบัญชี LINE ของพนักงาน');
  if (!auth.lineUser) throw createHttpError(401, 'กรุณาเข้าสู่ระบบผ่าน LINE');
  if (auth.employee || auth.employeeDisabled) throw createHttpError(409, 'บัญชีนี้มีทะเบียนพนักงานแล้ว');
  const departmentId = parseWholeNumber(payload.departmentId);
  const employeeId = typeof payload.employeeId === 'string' ? payload.employeeId.trim() : '';
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!employeeId || employeeId.length > 50 || !name || name.length > 150 || !Number.isSafeInteger(departmentId) || departmentId < 1) {
    throw createHttpError(400, 'กรุณากรอกรหัสพนักงาน ชื่อ และเลือกแผนก');
  }
  return registrationRpc('ppe_submit_employee_registration', {
    p_line_user_id: auth.lineUser.userId, p_employee_id: employeeId, p_employee_name: name, p_department_id: departmentId,
  });
}

async function getAdminNotificationCounts() {
  const [issues, employees, messages] = await Promise.all([
    supabase.from('issue_vouchers').select('id', { head: true, count: 'exact' })
      .eq('status', 'pending').is('voided_at', null),
    supabase.from('ppe_employee_registrations').select('id', { head: true, count: 'exact' })
      .eq('status', 'pending'),
    supabase.from('notification_log').select('id', { head: true, count: 'exact' })
      .in('status', ['failed', 'retry_scheduled']),
  ]);
  if (issues.error || employees.error) throw issues.error || employees.error;
  return { issues: issues.count, employees: employees.count, messages: messages.count };
}

async function listEmployeeRegistrations() {
  const { data, error } = await supabase.from('ppe_employee_registrations')
    .select('id,revision,employee_id,employee_name,department,submitted_at')
    .eq('status', 'pending').order('submitted_at').order('id').limit(100);
  if (error) throw error;
  return data || [];
}

async function reviewEmployeeRegistrations(payload, actor) {
  const { requests, decision } = payload;
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100
    || !['approved', 'rejected'].includes(decision) || (decision === 'rejected' && (!reason || reason.length > 500))) {
    throw createHttpError(400, 'กรุณาเลือกรายการและระบุข้อมูลการพิจารณาให้ครบ');
  }
  const selections = requests.map(row => ({ id: parseWholeNumber(row?.id), revision: parseWholeNumber(row?.revision) }));
  if (selections.some(row => !Number.isSafeInteger(row.id) || row.id < 1 || !Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2147483647)
    || new Set(selections.map(row => row.id)).size !== selections.length) {
    throw createHttpError(400, 'รายการคำขอไม่ถูกต้องหรือมีรายการซ้ำ');
  }
  return registrationRpc('ppe_review_employee_registrations', {
    p_requests: selections, p_decision: decision, p_reviewer: actor, p_reason: decision === 'rejected' ? reason : null,
  });
}

function visibleVoucherStatus(voucher) {
  return voucher.voided_at ? { ...voucher, status: 'cancelled' } : voucher;
}

async function saveCategory(categoryData, actor, requestId) {
  const name = typeof categoryData?.name === 'string' ? categoryData.name.trim() : '';
  if (!name || name.length > 100) throw createHttpError(400, 'ชื่อหมวดหมู่ต้องมีความยาว 1 ถึง 100 ตัวอักษร');

  if (categoryData.id) {
    const categoryId = parseWholeNumber(categoryData.id);
    if (!Number.isSafeInteger(categoryId) || categoryId < 1) throw createHttpError(400, 'รหัสหมวดหมู่ไม่ถูกต้อง');
    const { data, error } = await supabase
      .from('categories')
      .update({ name })
      .eq('id', categoryId)
      .select()
      .maybeSingle();
    if (error?.code === 'PT409') throw createHttpError(409, 'มีหมวดหมู่ชื่อนี้อยู่แล้ว');
    if (error) throw error;
    if (!data) throw createHttpError(404, 'ไม่พบหมวดหมู่');
    return data;
  } else {
    return runInventoryMutation('createCategory', { name }, actor, requestId);
  }
}

async function deleteCategory(categoryId) {
  const normalizedId = parseWholeNumber(categoryId);
  if (!Number.isSafeInteger(normalizedId) || normalizedId <= 0) throw createHttpError(400, 'รหัสหมวดหมู่ไม่ถูกต้อง');
  const { data, error } = await supabase.from('categories').delete().eq('id', normalizedId).select('id').maybeSingle();
  if (['23001', '23503'].includes(error?.code)) throw createHttpError(409, 'ยังลบหมวดหมู่ไม่ได้ เนื่องจากมีอุปกรณ์อ้างอิงอยู่');
  if (error) throw error;
  if (!data) throw createHttpError(404, 'ไม่พบหมวดหมู่ที่ต้องการลบ');
  return data.id;
}

async function savePpeItem(itemData, actor, requestId) {
  if (!itemData) throw new Error('Missing item data');

  const id = itemData.id ? Number(itemData.id) : null;
  const name = String(itemData.name || '').trim();
  const category = String(itemData.category || '').trim();
  const categoryId = itemData.categoryId == null ? null : parseWholeNumber(itemData.categoryId);
  const unit = String(itemData.unit || '').trim();
  const stock = Number(itemData.stock);
  const reorderPoint = Number(itemData.reorderPoint);
  const price = Number(itemData.price || 0);
  const imageUrl = String(itemData.imageUrl || '').trim();

  if (id !== null && (!Number.isInteger(id) || id <= 0)) throw new Error('รหัสอุปกรณ์ไม่ถูกต้อง');
  if (!name || name.length > 150) throw new Error('กรุณาระบุชื่ออุปกรณ์ไม่เกิน 150 ตัวอักษร');
  if (categoryId === null ? (!category || category.length > 100) : (!Number.isSafeInteger(categoryId) || categoryId < 1)) {
    throw createHttpError(400, 'กรุณาเลือกหมวดหมู่ให้ถูกต้อง');
  }
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

  const expectedStock = id === null ? null : Number(itemData.expectedStock);
  if (id !== null && (itemData.expectedStock == null || !Number.isInteger(expectedStock) || expectedStock < 0)) {
    throw createHttpError(400, 'กรุณาโหลดข้อมูลสต็อกล่าสุดก่อนแก้ไข');
  }
  return runInventoryMutation('savePpeItem', {
    id, name, ...(categoryId === null ? { category } : { categoryId }), unit, stock, expectedStock, reorderPoint, price, imageUrl,
  }, actor, requestId);
}

// ✅ แก้ไข: ใช้ชื่อคอลัมน์ตัวพิมพ์เล็ก (userid, employeeid)
async function getEmployeeIdentity(payload, auth, nameField) {
  const identity = auth.isAdmin ? {
    employeeId: String(payload.employeeId || '').trim(),
    name: String(payload[nameField] || '').trim(),
    department: String(payload.department || '').trim(),
  } : auth.employee;
  if (!identity?.employeeId || identity.employeeId.length > 50 || !identity.name || identity.name.length > 150
    || !identity.department || identity.department.length > 150) {
    throw createHttpError(400, 'กรุณาระบุข้อมูลพนักงานให้ครบและถูกต้อง');
  }
  const { data, error } = await supabase.from('departments').select('name')
    .eq('name', identity.department).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw createHttpError(400, 'ไม่พบแผนกในข้อมูลมาสเตอร์');
  return identity;
}

async function addNewVoucher(voucherData, auth, actor, requestId) {
  const ownerUserId = auth.isAdmin
    ? (LINE_USER_ID_PATTERN.test(String(voucherData.userId || '')) ? voucherData.userId : '')
    : auth.lineUser.userId;
  const { employeeId, name: userName, department } = await getEmployeeIdentity(voucherData, auth, 'user');
  const items = voucherLines(voucherData.items);
  const data = await runInventoryMutation('addNewVoucher', { userId: ownerUserId, user: userName, employeeId, department, items }, actor, requestId);
  const itemDetails = await getItemDetails(parseVoucherItems(data.itemsJson));
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
        { label: 'แผนก', value: department },
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
          { label: 'แผนก', value: department },
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

function normalizeAdminNote(value) {
  return String(value || '').trim().slice(0, 500);
}

function parseWholeNumber(value) {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : NaN;
}

function voucherLines(items, allowZero = false) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw createHttpError(400, 'ใบเบิกต้องมีอุปกรณ์ 1 ถึง 100 รายการ');
  }
  const lines = items.map(item => {
    const itemId = parseWholeNumber(item?.itemId);
    const quantity = parseWholeNumber(item?.quantity);
    if (!Number.isSafeInteger(itemId) || itemId < 1 || itemId > 999999999999999
      || !Number.isInteger(quantity) || quantity < (allowZero ? 0 : 1) || quantity > 999999) {
      throw createHttpError(400, 'รหัสหรือจำนวนอุปกรณ์ไม่ถูกต้อง');
    }
    return { itemId, quantity };
  });
  if (new Set(lines.map(line => line.itemId)).size !== lines.length) throw createHttpError(400, 'พบอุปกรณ์ซ้ำในใบเบิก');
  return lines.sort((a, b) => a.itemId - b.itemId);
}

async function changeVoucherStatus(action, payload, actor, requestId) {
  const voucherId = parseWholeNumber(payload.voucherId);
  if (!Number.isSafeInteger(voucherId) || voucherId < 1) throw createHttpError(400, 'รหัสใบเบิกไม่ถูกต้อง');
  const note = normalizeAdminNote(payload.adminNote || payload.reason);
  if (['rejectVoucher', 'deleteVoucher', 'reverseVoucher'].includes(action) && !note) {
    throw createHttpError(400, 'กรุณาระบุเหตุผล');
  }
  const fields = { voucherId, note };
  if (action === 'approvePartialVoucher') fields.items = voucherLines(payload.items, true);
  const { voucher, updatedStockItems } = await runInventoryMutation(action, fields, actor, requestId);
  const response = { updatedVoucherId: voucher.id, status: voucher.voided_at ? 'cancelled' : voucher.status, updatedStockItems };
  if (action === 'deleteVoucher' || action === 'reverseVoucher') return response;
  if (action === 'rejectVoucher') {
    const notification = await notifyVoucherStatus(voucher, 'ใบเบิกไม่ได้รับการอนุมัติ ❌',
      parseVoucherItems(voucher.itemsJson), 'issue-rejected:' + voucherId);
    return { ...response, notification };
  }
  const partial = voucher.status === 'partially_approved';
  const eventKey = (action === 'approvePartialVoucher' ? 'issue-partial:' + voucherId + ':' + voucher.status : 'issue-approved:' + voucherId);
  const [notification, stockNotification] = await Promise.all([
    notifyVoucherStatus(voucher, partial ? 'อนุมัติใบเบิกบางส่วน ⚠️' : 'อนุมัติใบเบิกเรียบร้อยแล้ว ✅',
      getApprovedVoucherItems(voucher), eventKey, true, true),
    checkAndAlertLowStock(updatedStockItems),
  ]);
  return { ...response, notification, stockNotification };
}

async function addReceiveTransactionAndUpdateStock(tx, actor, requestId) {
  const itemId = parseWholeNumber(tx?.itemId);
  const quantity = parseWholeNumber(tx?.quantity);
  const type = String(tx?.type || '').trim();
  const user = String(tx?.user || '').trim();
  const department = String(tx?.department || '').trim();
  const allowedTypes = new Set(['purchase', 'return', 'adjustment']);

  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw createHttpError(400, 'กรุณาเลือกอุปกรณ์');
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 999999) throw new Error('จำนวนที่รับต้องเป็นจำนวนเต็มระหว่าง 1 ถึง 999,999');
  if (!allowedTypes.has(type)) throw new Error('ประเภทการรับไม่ถูกต้อง');
  if (!user || user.length > 150) throw new Error('กรุณาระบุชื่อผู้รับของให้ถูกต้อง');
  if (!department || department.length > 150) throw new Error('กรุณาเลือกแผนก');

  const { data: masterDepartment, error: departmentError } = await supabase
    .from('departments').select('name').eq('name', department).limit(1).maybeSingle();
  if (departmentError) throw departmentError;
  if (!masterDepartment) throw new Error('ไม่พบแผนกในข้อมูลมาสเตอร์ กรุณาเลือกแผนกใหม่');

  const { transaction, updatedItem } = await runInventoryMutation('addReceiveTransaction', {
    itemId, quantity, type, user, department: masterDepartment.name,
  }, actor, requestId);
  return { updatedStockItems: [updatedItem], transaction: { ...transaction, itemId } };
}

// ในไฟล์ ppe.js ค้นหาฟังก์ชัน borrowItem แล้วแก้เป็นแบบนี้
async function borrowItem(borrowData, auth, actor, requestId) {
  const itemId = parseWholeNumber(borrowData?.itemId);
  const { name: borrowerName, employeeId, department } = await getEmployeeIdentity(borrowData, auth, 'borrowerName');
  const dueDate = String(borrowData?.dueDate || '');
  const notes = String(borrowData?.notes || '').trim().slice(0, 500);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw createHttpError(400, 'กรุณาเลือกอุปกรณ์ที่ต้องการยืม');
  if (!borrowerName || borrowerName.length > 150) throw new Error('กรุณาระบุชื่อผู้ยืมให้ถูกต้อง');
  if (!employeeId || employeeId.length > 50) throw new Error('กรุณาระบุรหัสพนักงานให้ถูกต้อง');
  if (!department || department.length > 150) throw new Error('กรุณาเลือกแผนก');
  if (!validDateKey(dueDate)) {
    throw new Error('กรุณาระบุกำหนดคืนให้ถูกต้อง');
  }
  if (dueDate < today) throw new Error('กำหนดคืนต้องไม่เป็นวันที่ย้อนหลัง');

  const ownerUserId = auth.isAdmin
    ? (LINE_USER_ID_PATTERN.test(String(borrowData.userId || '')) ? borrowData.userId : '')
    : auth.lineUser.userId;
  const { loan: data, updatedItem } = await runInventoryMutation('borrowItem', {
    itemId, borrowerName, employeeId, userId: ownerUserId, department, dueDate, notes,
  }, actor, requestId);

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

async function returnItem(loanId, actor, requestId) {
  const normalizedLoanId = parseWholeNumber(loanId);
  if (!Number.isSafeInteger(normalizedLoanId) || normalizedLoanId <= 0) throw createHttpError(400, 'รหัสรายการยืมไม่ถูกต้อง');
  const { loan, updatedItem } = await runInventoryMutation('returnItem', { loanId: normalizedLoanId }, actor, requestId);

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

// ------------------------- helpers -------------------------



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
    if (['approved', 'partially_approved', 'completed'].includes(v.status)) {
      const items = getApprovedVoucherItems(v) || [];
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

async function confirmReceive(payload, auth, actor, requestId) {
  const voucherId = Number(payload?.voucherId);
  if (!Number.isSafeInteger(voucherId) || voucherId < 1) throw createHttpError(400, 'รหัสใบเบิกไม่ถูกต้อง');
  const receivedBy = auth.isAdmin ? 'Admin (' + auth.adminUsername + ')' : auth.employee.name;
  const { status, voucher } = await runInventoryMutation('confirmReceive', { voucherId, receivedBy }, actor, requestId);
  if (status === 'already_received') return { status, voucherId, receivedBy: voucher.received_by || '-' };
  const receivedItemDetails = await getItemDetails(getApprovedVoucherItems(voucher));
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
async function deletePpeItem(payload, actor, requestId) {
  const itemId = Number(payload?.id);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw createHttpError(400, 'รหัสอุปกรณ์ไม่ถูกต้อง');
  return runInventoryMutation('deletePpeItem', { id: itemId }, actor, requestId);
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

async function uploadDocument(payload, adminUsername) {
  const title = String(payload?.title || '').trim();
  if (!title || title.length > 200) throw createHttpError(400, 'กรุณาระบุชื่อเอกสารไม่เกิน 200 ตัวอักษร');
  const buffer = decodePdfUpload(payload);
  return documentStorage.upload({ title, buffer, user: adminUsername.slice(0, 100) });
}

function documentId(id) {
  const parsed = parseWholeNumber(id);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw createHttpError(400, 'รหัสเอกสารไม่ถูกต้อง');
  return parsed;
}

async function getDocumentUrl(id, auth) {
  if (!auth.isAdmin && !auth.employee) {
    throw createHttpError(403, 'เอกสารนี้สำหรับพนักงานที่ได้รับสิทธิ์', 'EMPLOYEE_ACCESS_REQUIRED');
  }
  return documentStorage.signedUrl(documentId(id));
}
