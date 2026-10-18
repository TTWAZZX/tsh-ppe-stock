# Production deployment checklist

## Before deployment

- [ ] Confirm `.env.local` and all `.env.*` files remain ignored and unstaged.
- [ ] Confirm Vercel contains the required environment variable names: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ADMIN_USERNAME`, the configured admin password hash, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_LOGIN_CHANNEL_ID`, `LIFF_ID`, `ADMIN_LINE_USER_ID`, and `CRON_SECRET`.
- [ ] Confirm the latest SQL migrations have been applied to the intended Supabase project.
- [ ] Run `npm run release:gate` and require a zero exit code.
- [ ] Run `npm run audit:security` and resolve every high/critical production dependency finding. Build-only tooling is isolated from user input and reviewed separately before upgrades.
- [ ] Confirm the LIFF endpoint and allowed redirect URLs point to the production domain.
- [ ] Review the staged file list and verify that no environment file, token, exported data, or QA screenshot is included.

## Deployment

- [ ] Deploy the verified commit only.
- [ ] Confirm `/index.html` and `/api/ppe` respond over HTTPS.
- [ ] Confirm the CSP permits the LINE LIFF SDK and required Supabase connections without browser violations.
- [ ] Confirm `X-Request-Id`, `X-Content-Type-Options`, `Referrer-Policy`, and CSP headers are present.

## Post-deployment smoke test

- [ ] Open through LINE and confirm login/profile loading.
- [ ] Check user stock, issue, loan, history, and PPE standards modules.
- [ ] Check admin pending, manage, receive, report, and notification modules.
- [ ] Use a controlled test account to complete one approved issue and receipt-confirmation flow.
- [ ] Confirm the Flex notification contains the correct item image and deep link.
- [ ] Confirm Vercel logs contain `api_request` and `client_telemetry_batch` entries without personal or secret data.
- [ ] Check desktop at 1920 px and mobile at 390 px for overflow and blocked controls.

## Rollback

- [ ] If critical flows fail, immediately promote the previous known-good Vercel deployment.
- [ ] Do not roll back database migrations that contain production data without a reviewed recovery plan.
- [ ] Record the failed deployment ID, request IDs, symptom, and rollback time for follow-up.
