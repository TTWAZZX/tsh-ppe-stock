import crypto from 'crypto';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

function getRequestId(req) {
  const supplied = String(req.headers?.['x-request-id'] || '').trim();
  return REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
}

function safeLog(entry) {
  try {
    console.log(JSON.stringify(entry));
  } catch {
    console.log('[api-metric]', entry.event, entry.route, entry.status);
  }
}

/**
 * Adds correlation, latency, and failure telemetry without reading request
 * bodies, authorization headers, cookies, query strings, or user identity.
 */
export function withApiObservability(route, handler) {
  return async function observedApiHandler(req, res) {
    const startedAt = performance.now();
    const requestId = getRequestId(req);
    let finished = false;

    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const finish = () => {
      if (finished) return;
      finished = true;
      const durationMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
      if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${durationMs}`);
      safeLog({
        event: 'api_request',
        route,
        method: String(req.method || 'UNKNOWN').toUpperCase(),
        status: Number(res.statusCode || 500),
        durationMs,
        outcome: Number(res.statusCode || 500) >= 400 ? 'failure' : 'success',
        requestId,
        timestamp: new Date().toISOString(),
      });
    };

    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
      finish();
      return originalEnd(...args);
    };

    try {
      return await handler(req, res);
    } catch (error) {
      if (!res.headersSent) {
        return res.status(500).json({ status: 'error', message: 'Internal server error', requestId });
      }
      return undefined;
    } finally {
      finish();
    }
  };
}
