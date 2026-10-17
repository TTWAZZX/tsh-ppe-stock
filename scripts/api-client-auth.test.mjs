import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadApiClient(fetchImpl, windowOverrides = {}) {
  const context = {
    console,
    fetch: fetchImpl,
    window: { _adminToken: null, _lineAccessToken: 'expired-token', ...windowOverrides },
    LoadingManager: { wrap: async (_key, fn) => fn(null) },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/js/api-client.js', import.meta.url), 'utf8'), context);
  return context.window;
}

test('invokes centralized LINE re-login handler on API 401', async () => {
  let handledMessage = '';
  const browser = loadApiClient(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: 'เซสชัน LINE หมดอายุ กรุณาเข้าสู่ระบบใหม่' }),
  }), {
    handleLineSessionExpired: async message => {
      handledMessage = message;
      return true;
    },
  });

  await assert.rejects(
    browser.apiCall('addNewVoucher', {}, { silent: true }),
    error => error.statusCode === 401 && error.authenticationRedirected === true,
  );
  assert.match(handledMessage, /เข้าสู่ระบบใหม่/);
});

test('invokes centralized Admin login handler on API 403', async () => {
  let called = false;
  const browser = loadApiClient(async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: 'เซสชัน Admin หมดอายุ กรุณาเข้าสู่ระบบใหม่' }),
  }), {
    handleAdminSessionExpired: () => {
      called = true;
      return true;
    },
  });

  await assert.rejects(
    browser.apiCall('approveVoucher', {}, { silent: true }),
    error => error.statusCode === 403 && error.authenticationRedirected === true,
  );
  assert.equal(called, true);
});

test('preserves feedback-required code and voucher details on API 409', async () => {
  const browser = loadApiClient(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      message: 'กรุณาให้คะแนนใบเบิกเดิมให้ครบ',
      code: 'FEEDBACK_REQUIRED',
      details: { voucherId: 117, ratedCount: 1, total: 2 },
    }),
  }));

  await assert.rejects(
    browser.apiCall('addNewVoucher', {}, { silent: true }),
    error => (
      error.statusCode === 409
      && error.code === 'FEEDBACK_REQUIRED'
      && error.details?.voucherId === 117
    ),
  );
});
