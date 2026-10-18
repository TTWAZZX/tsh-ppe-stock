# Production observability

The application records operational signals without collecting form values, names, employee IDs, LINE IDs, access tokens, cookies, authorization headers, URL query strings, or request bodies.

## Signals

- Browser Web Vitals: CLS, FCP, LCP, INP/FID, and TTFB.
- Browser failures: sanitized error kind, short message, source filename, and active module.
- API calls: fixed route, method, HTTP status, duration, outcome, and request ID.
- Application readiness: startup duration only.

The browser sends small batches to `POST /api/telemetry`. The endpoint validates an allowlisted schema, truncates text, redacts URLs and secret-like values, and emits structured JSON to platform logs. It does not persist telemetry in Supabase.

Every API route emits a structured `api_request` log and returns `X-Request-Id`. Responses also include `Server-Timing` when headers have not yet been sent. Use the request ID to correlate a browser failure with a server invocation.

## Operational queries

In Vercel logs, filter JSON records by:

- `event=api_request` and `outcome=failure` for server failures.
- `event=api_request` and high `durationMs` for slow endpoints.
- `event=client_telemetry_batch` then inspect only the allowlisted `events` fields.

No alert threshold is hard-coded. A practical starting point is: error rate above 2% for five minutes, p95 API latency above 3 seconds, or poor LCP/INP above 10% of samples.
