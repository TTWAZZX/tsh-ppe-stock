import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { createLineNotificationService } from '../../../lib/notification-service.js';
import { createNotificationWorkflows } from '../../../lib/notification-workflows.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const cronSecret = String(process.env.CRON_SECRET || '');
  const authorization = String(req.headers.authorization || '');
  if (!secretMatches(authorization, `Bearer ${cronSecret}`)) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  try {
    const [retry, reminders] = await Promise.all([
      notificationService.retryDue({ limit: 10 }),
      notificationWorkflows.sendLoanDueReminders(),
    ]);
    return res.status(200).json({ status: 'success', data: { retry, reminders } });
  } catch (error) {
    console.error('[notification-retry] failed:', error);
    return res.status(500).json({ status: 'error', message: 'Notification retry failed' });
  }
}
