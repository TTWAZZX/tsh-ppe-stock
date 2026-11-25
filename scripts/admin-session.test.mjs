import assert from 'node:assert/strict';
import { createHmac, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import { ADMIN_SESSION_COOKIE, adminSessionCookie, createAdminSession } from '../lib/admin-session.js';

const username = 'test-admin';
const secret = 'test-session-secret-for-automated-checks';
const password = 'password for this test';
const salt = 'c2ed0a990e103e37a57ad8807d215b27';
const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const session = createAdminSession({ username, secret, passwordHash });

test('Admin authentication requires a valid secret and scrypt hash', async () => {
  for (const options of [
    { secret: '', passwordHash },
    { secret: 'short', passwordHash },
    { secret, passwordHash: 'invalid' },
  ]) {
    const adminSession = createAdminSession({ username, ...options });
    assert.equal(adminSession.configured, false);
    assert.equal(await adminSession.verifyCredentials(username, password), false);
    assert.equal(adminSession.issue(), null);
    assert.equal(adminSession.verify(session.issue()), null);
  }
  assert.equal(await session.verifyCredentials(username, password), true);
  assert.equal(await session.verifyCredentials(username, 'incorrect'), false);
  assert.equal(await session.verifyCredentials('other-admin', password), false);
});

test('accepts only current-format, unexpired Admin sessions for the configured user and secret', () => {
  const now = Date.UTC(2026, 1, 1);
  const token = session.issue(now);
  const legacyPayload = `${username}:${now + 60_000}`;
  const legacyToken = `${legacyPayload}:${createHmac('sha256', secret).update(legacyPayload).digest('hex')}`;
  assert.equal(session.verify(token, now), username);
  assert.equal(session.verify(token, now + 24 * 60 * 60 * 1000), null);
  assert.equal(session.verify(token + '0', now), null);
  assert.equal(session.verify(legacyToken, now), null);
  assert.equal(createAdminSession({ username, secret: 'rotated-test-session-secret-with-randomness', passwordHash }).verify(token, now), null);
  assert.equal(createAdminSession({ username: 'other-admin', secret, passwordHash }).verify(token, now), null);
});

test('creates an HttpOnly, same-site cookie with the matching expiration and deletion scope', () => {
  const sessionCookie = adminSessionCookie('token', { secure: true });
  assert.equal(sessionCookie, `${ADMIN_SESSION_COOKIE}=token; Path=/api/ppe; HttpOnly; SameSite=Strict; Secure`);
  assert.equal(adminSessionCookie('token', { remember: true, secure: true }), `${sessionCookie}; Max-Age=86400`);
  assert.equal(adminSessionCookie(null, { secure: true }), `${ADMIN_SESSION_COOKIE}=; Path=/api/ppe; HttpOnly; SameSite=Strict; Secure; Max-Age=0`);
});
