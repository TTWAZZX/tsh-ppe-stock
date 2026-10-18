import { withApiObservability } from '../../lib/api-observability.js';

// LINE Notify was discontinued on March 31, 2025.
// Keep the route as an explicit tombstone so old clients cannot use it as a relay.
function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    success: false,
    error: 'LINE Notify is discontinued; use server-managed Messaging API notifications',
  });
}

export default withApiObservability('/api/notify', handler);
