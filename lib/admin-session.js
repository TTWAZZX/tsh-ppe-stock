import crypto from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'ppe_admin_session_v2';
const SESSION_SECONDS = 24 * 60 * 60;
const HASH_PATTERN = /^([a-f0-9]{32}):([a-f0-9]{128})$/i;

export function createAdminSession({ username, secret, passwordHash }) {
  const configured = Boolean(username && typeof secret === 'string' && secret.trim().length >= 32);
  const hash = typeof passwordHash === 'string' ? HASH_PATTERN.exec(passwordHash) : null;

  function sign(value) {
    return crypto.createHmac('sha256', secret).update(`ppe-admin-session-v2:${value}`).digest();
  }

  return {
    configured: configured && Boolean(hash),

    async verifyCredentials(providedUsername, password) {
      if (!configured || !hash || providedUsername !== username || typeof password !== 'string' || password.length > 1024) return false;
      const derived = await new Promise((resolve, reject) => {
        crypto.scrypt(password, hash[1], 64, (error, key) => error ? reject(error) : resolve(key));
      });
      return crypto.timingSafeEqual(derived, Buffer.from(hash[2], 'hex'));
    },

    issue(now = Date.now()) {
      if (!configured || !hash) return null;
      const value = Buffer.from(JSON.stringify({ username, expiresAt: now + SESSION_SECONDS * 1000 })).toString('base64url');
      return `${value}.${sign(value).toString('hex')}`;
    },

    verify(token, now = Date.now()) {
      if (!configured || !hash || typeof token !== 'string' || token.length > 1024) return null;
      const parts = /^([\w-]+)\.([a-f0-9]{64})$/.exec(token);
      if (!parts || !crypto.timingSafeEqual(sign(parts[1]), Buffer.from(parts[2], 'hex'))) return null;
      try {
        const session = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return session.username === username && Number.isSafeInteger(session.expiresAt) && session.expiresAt > now
          ? username : null;
      } catch {
        return null;
      }
    },
  };
}

export function adminSessionCookie(token, { remember = false, secure = false } = {}) {
  const cookie = [`${ADMIN_SESSION_COOKIE}=${token || ''}`, 'Path=/api/ppe', 'HttpOnly', 'SameSite=Strict'];
  if (secure) cookie.push('Secure');
  if (!token || remember) cookie.push(`Max-Age=${token ? SESSION_SECONDS : 0}`);
  return cookie.join('; ');
}
