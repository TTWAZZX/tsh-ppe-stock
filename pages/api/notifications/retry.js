import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { createLineNotificationService } from '../../../lib/notification-service.js';
import { createNotificationWorkflows } from '../../../lib/notification-workflows.js';
import { withApiObservability } from '../../../lib/api-observability.js';
import { reportNotificationQueue, reportOperationalAlert } from '../../../lib/operational-alerts.js';
import { createDocumentStorage } from '../../../lib/document-storage.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const documentStorage = createDocumentStorage(supabase, process.env.NEXT_PUBLIC_SUPABASE_URL);

const notificationService = createLineNotificationService({
  supabase,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
});
const notificationWorkflows = createNotificationWorkflows({
  supabase,
  notificationService,
  liffId: process.env.LIFF_ID || '2007053300-JTSerFbF',
  fallbackAdminUserId: process.env.ADMIN_LINE_USER_ID || '',
});

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const cronSecret = String(process.env.CRON_SECRET || '');
  const authorization = String(req.headers.authorization || '');
  if (!cronSecret || !secretMatches(authorization, `Bearer ${cronSecret}`)) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const [retry, reminders, documents] = await Promise.allSettled([
    notificationService.retryDue({ limit: 10 }),
    notificationWorkflows.sendLoanDueReminders(),
    documentStorage.retryCleanup(),
  ]);
  const alerts = [];
  if (retry.status === 'fulfilled') alerts.push(reportNotificationQueue(notificationWorkflows, retry.value));
  if (retry.status === 'rejected' || reminders.status === 'rejected') {
    alerts.push(reportOperationalAlert(notificationWorkflows, {
      event: 'notification_retry_job_failed',
      message: 'PPE Stock: งานประมวลผลแจ้งเตือนล้มเหลว กรุณาตรวจ Vercel Logs',
      details: { retryFailed: retry.status === 'rejected', remindersFailed: reminders.status === 'rejected' },
    }));
  }
  if (documents.status === 'rejected' || documents.value.failed > 0) {
    alerts.push(reportOperationalAlert(notificationWorkflows, {
      event: 'document_cleanup_failed',
      message: 'PPE Stock: มีไฟล์ PDF ที่ยังล้างไม่สำเร็จ ระบบจะลองใหม่ในรอบถัดไป',
      details: { failed: documents.value?.failed ?? null },
    }));
  }
  await Promise.all(alerts);
  const failed = [retry, reminders, documents].some(job => job.status === 'rejected') || documents.value?.failed > 0;
  const data = { retry: retry.value, reminders: reminders.value, documents: documents.value };
  return res.status(failed ? 500 : 200).json({ status: failed ? 'error' : 'success', data });
}

export default withApiObservability('/api/notifications/retry', handler);
