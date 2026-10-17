import { createPpeFlexMessage } from './line-flex.js';

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
const ALLOWED_TOPICS = new Set(['all', 'issue', 'loan', 'stock', 'receipt', 'system']);

function bangkokDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeTopics(topics) {
  const normalized = [...new Set((Array.isArray(topics) ? topics : [])
    .map(topic => String(topic || '').trim().toLowerCase())
    .filter(topic => ALLOWED_TOPICS.has(topic)))];
  return normalized.length ? normalized : ['all'];
}

function publicRecipient(row, source = 'database') {
  const lineUserId = String(row?.line_user_id || '');
  return {
    id: row?.id ?? null,
    label: String(row?.label || (source === 'environment' ? 'ผู้รับจาก Environment' : 'ผู้รับแจ้งเตือน')),
    lineUserId,
    maskedLineUserId: lineUserId ? `${lineUserId.slice(0, 6)}…${lineUserId.slice(-4)}` : '-',
    enabled: row?.enabled !== false,
    topics: normalizeTopics(row?.topics),
    source,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  };
}

export function createNotificationWorkflows({
  supabase,
  notificationService,
  liffId,
  fallbackAdminUserId = '',
} = {}) {
  if (!supabase || !notificationService) throw new Error('Notification workflows require Supabase and notification service');

  function buildLiffLink(moduleName, params = {}) {
    if (!liffId) return '';
    const query = new URLSearchParams({ module: String(moduleName || 'dashboard') });
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
    }
    return `https://liff.line.me/${liffId}?${query.toString()}`;
  }

  async function readRecipientRows() {
    const { data, error } = await supabase
      .from('notification_recipients')
      .select('id,label,line_user_id,enabled,topics,created_at,updated_at')
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[notification_recipients] read failed:', error.message);
      return { rows: [], available: false };
    }
    return { rows: data || [], available: true };
  }

  async function listRecipients() {
    const { rows, available } = await readRecipientRows();
    const recipients = rows.map(row => publicRecipient(row));
    const fallback = String(fallbackAdminUserId || '').trim();
    if (LINE_USER_ID_PATTERN.test(fallback) && !rows.some(row => row.line_user_id === fallback)) {
      recipients.push(publicRecipient({ line_user_id: fallback, enabled: true, topics: ['all'] }, 'environment'));
    }
    return { available, recipients };
  }

  async function getAdminRecipients(topic = 'all') {
    const { rows } = await readRecipientRows();
    const normalizedTopic = ALLOWED_TOPICS.has(topic) ? topic : 'all';
    const enabledRecipients = rows.filter(row => row.enabled !== false && LINE_USER_ID_PATTERN.test(String(row.line_user_id || '')));
    const configured = enabledRecipients.filter(row => {
      const topics = normalizeTopics(row.topics);
      return topics.includes('all') || topics.includes(normalizedTopic);
    });
    if (enabledRecipients.length) return configured.map(row => row.line_user_id);
    return LINE_USER_ID_PATTERN.test(String(fallbackAdminUserId || '')) ? [fallbackAdminUserId] : [];
  }

  async function sendToAdmins({ topic, messages, eventKey, notificationType, entityType, entityId, metadata } = {}) {
    const recipients = await getAdminRecipients(topic);
    const results = [];
    for (const recipient of recipients) {
      results.push(await notificationService.send({
        recipient,
        messages,
        eventKey,
        notificationType,
        entityType,
        entityId,
        metadata: { ...(metadata || {}), audience: 'admin', topic },
      }));
    }
    return {
      recipientCount: recipients.length,
      accepted: results.filter(result => result.accepted).length,
      sent: results.filter(result => result.sent).length,
      results,
    };
  }

  async function saveRecipient(payload = {}) {
    const id = Number(payload.id);
    const label = String(payload.label || '').trim().slice(0, 120);
    const lineUserId = String(payload.lineUserId || '').trim();
    const topics = normalizeTopics(payload.topics);
    if (!label) throw new Error('กรุณาระบุชื่อผู้รับแจ้งเตือน');
    if (!LINE_USER_ID_PATTERN.test(lineUserId)) throw new Error('LINE User ID ต้องขึ้นต้นด้วย U และมีอักขระ 33 ตัว');
    const values = {
      label,
      line_user_id: lineUserId,
      enabled: payload.enabled !== false,
      topics,
      updated_at: new Date().toISOString(),
    };
    let query = Number.isInteger(id) && id > 0
      ? supabase.from('notification_recipients').update(values).eq('id', id)
      : supabase.from('notification_recipients').upsert(values, { onConflict: 'line_user_id' });
    const { data, error } = await query.select('*').single();
    if (error) throw error;
    return publicRecipient(data);
  }

  async function setRecipientEnabled(payload = {}) {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('รหัสผู้รับแจ้งเตือนไม่ถูกต้อง');
    const { data, error } = await supabase
      .from('notification_recipients')
      .update({ enabled: Boolean(payload.enabled), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    return publicRecipient(data);
  }

  async function sendLoanDueReminders({ now = new Date() } = {}) {
    const today = bangkokDateKey(now);
    const tomorrow = addDays(today, 1);
    const { data: loans, error } = await supabase
      .from('loan_transactions')
      .select('loanId,itemId,borrowerName,department,dueDate,userid,status')
      .eq('status', 'on_loan')
      .lte('dueDate', tomorrow);
    if (error) throw error;

    const itemIds = [...new Set((loans || []).map(loan => Number(loan.itemId)).filter(Number.isInteger))];
    const { data: items, error: itemError } = itemIds.length
      ? await supabase.from('ppe_items').select('id,name,code').in('id', itemIds)
      : { data: [], error: null };
    if (itemError) throw itemError;
    const itemMap = new Map((items || []).map(item => [Number(item.id), item]));
    const results = [];

    for (const loan of loans || []) {
      const dueDate = String(loan.dueDate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) continue;
      const state = dueDate < today ? 'overdue' : (dueDate === today ? 'due-today' : 'due-tomorrow');
      const stateText = state === 'overdue' ? 'เกินกำหนดคืนแล้ว' : (state === 'due-today' ? 'ครบกำหนดคืนวันนี้' : 'ใกล้ครบกำหนดคืนพรุ่งนี้');
      const item = itemMap.get(Number(loan.itemId));
      const link = buildLiffLink('loan', { loanId: loan.loanId });
      const dueText = new Date(`${dueDate}T00:00:00Z`).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
      const reminderFields = [
        { label: 'อุปกรณ์', value: item?.name || `#${loan.itemId}` },
        { label: 'ผู้ยืม', value: loan.borrowerName || '-' },
        { label: 'แผนก', value: loan.department || '-' },
        { label: 'กำหนดคืน', value: dueText },
      ];
      const reminderTheme = state === 'overdue' ? 'danger' : (state === 'due-today' ? 'warning' : 'pending');
      const userMessage = createPpeFlexMessage({
        eyebrow: 'PPE STOCK • กำหนดคืน',
        title: `รายการยืม #${loan.loanId}`,
        status: stateText,
        summary: state === 'overdue' ? 'กรุณาคืนอุปกรณ์โดยเร็วที่สุด' : 'โปรดเตรียมอุปกรณ์เพื่อส่งคืนตามกำหนด',
        fields: reminderFields,
        theme: reminderTheme,
        actionLabel: 'เปิดรายการยืม',
        actionUrl: link,
        altText: `${stateText} — รายการยืม #${loan.loanId}`,
      });
      const adminMessage = createPpeFlexMessage({
        eyebrow: 'PPE STOCK • ADMIN',
        title: `ติดตามรายการยืม #${loan.loanId}`,
        status: stateText,
        summary: state === 'overdue' ? 'รายการนี้ต้องติดตามการคืนอุปกรณ์' : 'แจ้งเตือนกำหนดคืนอุปกรณ์',
        fields: reminderFields,
        theme: reminderTheme,
        actionLabel: 'ติดตามรายการ',
        actionUrl: link,
        altText: `Admin: ${stateText} — รายการยืม #${loan.loanId}`,
      });
      const eventDate = state === 'overdue' ? today : dueDate;
      const userResult = await notificationService.send({
        recipient: loan.userid,
        messages: [userMessage],
        eventKey: `loan-reminder-${state}-user:${loan.loanId}:${eventDate}`,
        notificationType: `loan-reminder-${state}`,
        entityType: 'loan_transactions',
        entityId: loan.loanId,
        metadata: { dueDate, reminderDate: today, audience: 'user' },
      });
      const adminResult = await sendToAdmins({
        topic: 'loan',
        messages: [adminMessage],
        eventKey: `loan-reminder-${state}-admin:${loan.loanId}:${eventDate}`,
        notificationType: `loan-reminder-${state}`,
        entityType: 'loan_transactions',
        entityId: loan.loanId,
        metadata: { dueDate, reminderDate: today },
      });
      results.push({ loanId: loan.loanId, state, user: userResult, admin: adminResult });
    }

    return {
      checked: (loans || []).length,
      processed: results.length,
      accepted: results.reduce((sum, row) => sum + Number(row.user.accepted || 0) + Number(row.admin.accepted || 0), 0),
      date: today,
      results,
    };
  }

  return {
    buildLiffLink,
    getAdminRecipients,
    listRecipients,
    saveRecipient,
    sendLoanDueReminders,
    sendToAdmins,
    setRecipientEnabled,
  };
}

export const notificationWorkflowInternals = { addDays, bangkokDateKey, normalizeTopics };
