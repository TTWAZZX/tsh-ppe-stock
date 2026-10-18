import { withApiObservability } from '../../lib/api-observability.js';

const EVENT_TYPES = new Set(['web_vital', 'client_error', 'api_metric', 'app_state']);
const METRIC_NAMES = new Set(['CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB']);
const MAX_EVENTS = 20;
const MAX_BODY_BYTES = 24 * 1024;

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/(?:token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanNumber(value, min = 0, max = 3_600_000) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : null;
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || !EVENT_TYPES.has(event.type)) return null;
  const clean = {
    type: event.type,
    timestamp: cleanNumber(event.timestamp, 0, Date.now() + 60_000) || Date.now(),
    module: cleanText(event.module, 40),
  };

  if (event.type === 'web_vital') {
    if (!METRIC_NAMES.has(event.name)) return null;
    clean.name = event.name;
    clean.value = cleanNumber(event.value);
    clean.rating = ['good', 'needs-improvement', 'poor'].includes(event.rating) ? event.rating : 'unknown';
  } else if (event.type === 'api_metric') {
    clean.route = cleanText(event.route, 60);
    clean.method = cleanText(event.method, 10);
    clean.status = cleanNumber(event.status, 0, 599);
    clean.durationMs = cleanNumber(event.durationMs);
    clean.outcome = event.outcome === 'failure' ? 'failure' : 'success';
    clean.requestId = cleanText(event.requestId, 80);
  } else if (event.type === 'client_error') {
    clean.kind = cleanText(event.kind, 40);
    clean.message = cleanText(event.message, 200);
    clean.source = cleanText(event.source, 80);
  } else {
    clean.state = cleanText(event.state, 40);
    clean.durationMs = cleanNumber(event.durationMs);
  }

  return clean;
}

async function telemetryHandler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ status: 'error', message: 'Payload too large' });
  }

  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, MAX_EVENTS) : [];
  const sanitized = events.map(sanitizeEvent).filter(Boolean);
  if (sanitized.length === 0) return res.status(202).json({ status: 'accepted', accepted: 0 });

  console.log(JSON.stringify({
    event: 'client_telemetry_batch',
    count: sanitized.length,
    events: sanitized,
    timestamp: new Date().toISOString(),
  }));
  return res.status(202).json({ status: 'accepted', accepted: sanitized.length });
}

export default withApiObservability('/api/telemetry', telemetryHandler);

export const config = {
  api: { bodyParser: { sizeLimit: '24kb' } },
};
