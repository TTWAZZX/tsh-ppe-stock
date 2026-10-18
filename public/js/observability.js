(function initPpeObservability(global) {
  'use strict';

  const ENDPOINT = '/api/telemetry';
  const MAX_QUEUE = 40;
  const FLUSH_SIZE = 20;
  const queue = [];
  let flushTimer = null;
  let appReady = false;
  const bootStartedAt = performance.now();

  function moduleName() {
    return String(global.location.hash || '#dashboard').replace(/^#/, '').replace(/[^a-zA-Z]/g, '').slice(0, 40) || 'dashboard';
  }

  function safeText(value, maxLength) {
    return String(value || '')
      .replace(/https?:\/\/[^\s]+/gi, '[url]')
      .replace(/(?:token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, maxLength);
  }

  function enqueue(event) {
    if (!event || typeof event !== 'object') return;
    queue.push({ ...event, module: moduleName(), timestamp: Date.now() });
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (queue.length >= FLUSH_SIZE) flush();
    else if (!flushTimer) flushTimer = global.setTimeout(flush, 5000);
  }

  function flush() {
    if (flushTimer) global.clearTimeout(flushTimer);
    flushTimer = null;
    if (!queue.length || global.navigator.onLine === false) return;
    const batch = queue.splice(0, FLUSH_SIZE);
    const body = JSON.stringify({ events: batch });

    if (global.navigator.sendBeacon) {
      const sent = global.navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      if (sent) return;
    }

    global.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {
      if (queue.length < MAX_QUEUE) queue.unshift(...batch.slice(0, MAX_QUEUE - queue.length));
    });
  }

  function rating(name, value) {
    const thresholds = {
      CLS: [0.1, 0.25], LCP: [2500, 4000], INP: [200, 500], FID: [100, 300],
      FCP: [1800, 3000], TTFB: [800, 1800],
    }[name];
    if (!thresholds) return 'unknown';
    return value <= thresholds[0] ? 'good' : value <= thresholds[1] ? 'needs-improvement' : 'poor';
  }

  function reportVital(name, value) {
    if (!Number.isFinite(value)) return;
    enqueue({ type: 'web_vital', name, value: Math.round(value * 1000) / 1000, rating: rating(name, value) });
  }

  function observeVitals() {
    if (!('PerformanceObserver' in global)) return;
    const supported = PerformanceObserver.supportedEntryTypes || [];
    if (supported.includes('paint')) {
      new PerformanceObserver(list => list.getEntries().forEach(entry => {
        if (entry.name === 'first-contentful-paint') reportVital('FCP', entry.startTime);
      })).observe({ type: 'paint', buffered: true });
    }
    if (supported.includes('largest-contentful-paint')) {
      let latest = 0;
      new PerformanceObserver(list => { latest = list.getEntries().at(-1)?.startTime || latest; }).observe({ type: 'largest-contentful-paint', buffered: true });
      global.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && latest) reportVital('LCP', latest); }, { once: true });
    }
    if (supported.includes('layout-shift')) {
      let cls = 0;
      new PerformanceObserver(list => list.getEntries().forEach(entry => { if (!entry.hadRecentInput) cls += entry.value; })).observe({ type: 'layout-shift', buffered: true });
      global.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reportVital('CLS', cls); }, { once: true });
    }
    if (supported.includes('event')) {
      let inp = 0;
      new PerformanceObserver(list => list.getEntries().forEach(entry => { inp = Math.max(inp, entry.duration || 0); })).observe({ type: 'event', buffered: true, durationThreshold: 40 });
      global.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && inp) reportVital('INP', inp); }, { once: true });
    } else if (supported.includes('first-input')) {
      new PerformanceObserver(list => {
        const entry = list.getEntries()[0];
        if (entry) reportVital('FID', entry.processingStart - entry.startTime);
      }).observe({ type: 'first-input', buffered: true });
    }
    const navigation = performance.getEntriesByType('navigation')[0];
    if (navigation) reportVital('TTFB', navigation.responseStart);
  }

  function captureError(error, context = {}) {
    enqueue({
      type: 'client_error',
      kind: safeText(context.kind || error?.name || 'Error', 40),
      message: safeText(error?.message || error || 'Unknown client error', 200),
      source: safeText(context.source || '', 80),
    });
  }

  function showFatal(error) {
    captureError(error, { kind: 'FatalBootError', source: 'app-bootstrap' });
    const fallback = document.getElementById('fatalErrorFallback');
    if (!fallback) return;
    document.getElementById('splashScreen')?.classList.add('hidden');
    fallback.classList.remove('hidden');
    fallback.removeAttribute('aria-hidden');
    fallback.querySelector('button')?.focus();
  }

  global.addEventListener('error', event => captureError(event.error || event.message, {
    kind: 'window.error', source: String(event.filename || '').split('/').pop(),
  }));
  global.addEventListener('unhandledrejection', event => captureError(event.reason, { kind: 'unhandledrejection' }));
  global.addEventListener('pagehide', flush);
  global.addEventListener('online', flush);
  document.addEventListener('DOMContentLoaded', observeVitals, { once: true });

  global.setTimeout(() => {
    if (!appReady) showFatal(new Error('Application startup timeout'));
  }, 30000);

  global.PpeObservability = Object.freeze({
    captureError,
    flush,
    markAppReady() {
      if (appReady) return;
      appReady = true;
      enqueue({ type: 'app_state', state: 'ready', durationMs: Math.round(performance.now() - bootStartedAt) });
    },
    recordApiMetric(metric) { enqueue({ type: 'api_metric', ...metric }); },
    showFatal,
  });
})(window);
