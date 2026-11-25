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

Operational alerts write JSON warnings and attempt LINE delivery to recipients with the `system` topic. Each event key is sent at most once per UTC hour per recipient. Database or LINE failures can prevent delivery. Use the structured logs as the independent alert source.

| Event | Trigger |
| --- | --- |
| `notification_queue_delayed` | The worker recovered a row left processing for over 10 minutes, or due work is still more than 15 minutes overdue after the batch. |
| `notification_retry_job_failed` | The scheduled notification retry or loan reminder job failed. |
| `audit_log_write_failed` | A supplementary audit insert failed. Check the database error code and action to trace the missing log. |
| `document_cleanup_deferred` | An upload or delete needs a later cleanup attempt. |
| `document_cleanup_failed` | A scheduled attempt to remove a hidden document or an abandoned upload failed. |
| `operational_alert_delivery_unavailable` | No configured LINE recipient accepted the alert or the alert worker failed. |

The maintenance endpoint retries pending LINE work and processes up to 10 document cleanup rows per run. It picks up documents that have been uploading or deleting for at least 30 minutes. It runs on the configured Vercel cron schedule. A practical starting point for additional log alerts is an error rate above 2% for five minutes or p95 API latency above 3 seconds.
