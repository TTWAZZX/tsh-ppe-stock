import { withApiObservability } from '../../lib/api-observability.js';

// Public LINE push relay intentionally disabled.
// Notifications are created and sent only by trusted business actions in /api/ppe.
function handler(req, res) {
  res.setHeader('Allow', 'POST');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  return res.status(410).json({
    success: false,
    error: 'Direct push endpoint is disabled',
  });
}

export default withApiObservability('/api/push', handler);
