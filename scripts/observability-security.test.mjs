import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const client = readFileSync(new URL('../public/js/observability.js', import.meta.url), 'utf8');
const telemetryApi = readFileSync(new URL('../pages/api/telemetry.js', import.meta.url), 'utf8');
const apiObservability = readFileSync(new URL('../lib/api-observability.js', import.meta.url), 'utf8');
const apiClient = readFileSync(new URL('../public/js/api-client.js', import.meta.url), 'utf8');
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('client observability reports vitals, failures, API timing, and a fatal fallback', () => {
  assert.match(html, /src="\/js\/observability\.js"/);
  assert.match(html, /id="fatalErrorFallback"[\s\S]*?role="alertdialog"/);
  assert.match(client, /largest-contentful-paint/);
  assert.match(client, /layout-shift/);
  assert.match(client, /\bINP\b/);
  assert.match(client, /unhandledrejection/);
  assert.match(apiClient, /X-Request-Id/);
  assert.match(apiClient, /recordApiMetric/);
});

test('telemetry collection is schema-limited and does not ingest request identity', () => {
  assert.match(telemetryApi, /MAX_EVENTS = 20/);
  assert.match(telemetryApi, /MAX_BODY_BYTES = 24 \* 1024/);
  assert.match(telemetryApi, /EVENT_TYPES/);
  assert.doesNotMatch(telemetryApi, /req\.headers\.(authorization|cookie)|req\.socket|req\.query/);
  assert.doesNotMatch(telemetryApi, /lineAccessToken|adminToken|displayName|employeeId|department/);
  assert.doesNotMatch(apiObservability, /req\.(?:body|query)|req\.headers\?\.\[['"](?:authorization|cookie)/);
});

test('API observability exposes correlation and latency without exposing payloads', () => {
  assert.match(apiObservability, /X-Request-Id/);
  assert.match(apiObservability, /Server-Timing/);
  assert.match(apiObservability, /durationMs/);
  assert.match(apiObservability, /outcome/);
});

test('security headers allow required LIFF and Supabase connections', () => {
  const globalRoute = vercel.routes.find(route => route.src === '/(.*)' && route.headers?.['Content-Security-Policy']);
  assert.ok(globalRoute, 'global security header route must exist');
  const csp = globalRoute.headers['Content-Security-Policy'];
  assert.match(csp, /static\.line-scdn\.net/);
  assert.match(csp, /https:\/\/\*\.supabase\.co/);
  assert.match(csp, /wss:\/\/\*\.supabase\.co/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors/);
  assert.equal(globalRoute.headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(globalRoute.headers['Referrer-Policy']);
  assert.ok(globalRoute.headers['Permissions-Policy']);
});
