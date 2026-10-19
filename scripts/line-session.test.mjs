import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadLineSession() {
  const context = { URL, window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL('../public/js/line-session.js', import.meta.url), 'utf8'), context);
  return context.window.PpeLineSession;
}

test('restarts an expired session through the LIFF URL inside the LIFF browser', () => {
  const lineSession = loadLineSession();
  let logoutCount = 0;
  let loginCount = 0;
  let navigatedTo = '';

  const result = lineSession.restartAuthentication({
    liffSdk: {
      isInClient: () => true,
      isLoggedIn: () => true,
      logout: () => { logoutCount += 1; },
      login: () => { loginCount += 1; },
    },
    liffId: '1234567890-AbCdEf',
    currentUrl: 'https://example.com/index.html?mode=confirmReceive&voucherId=42#issue',
    moduleName: 'issue',
    navigate: url => { navigatedTo = url; },
  });

  assert.equal(result.method, 'liff-url');
  assert.equal(logoutCount, 1);
  assert.equal(loginCount, 0);
  assert.equal(navigatedTo, 'https://liff.line.me/1234567890-AbCdEf?mode=confirmReceive&voucherId=42&module=issue');
});

test('uses LINE Login outside the LIFF browser', () => {
  const lineSession = loadLineSession();
  let redirectUri = '';
  let navigationCount = 0;

  const result = lineSession.restartAuthentication({
    liffSdk: {
      isInClient: () => false,
      isLoggedIn: () => true,
      logout: () => {},
      login: options => { redirectUri = options.redirectUri; },
    },
    liffId: '1234567890-AbCdEf',
    currentUrl: 'https://example.com/index.html?module=issue#issue',
    moduleName: 'issue',
    navigate: () => { navigationCount += 1; },
  });

  assert.equal(result.method, 'line-login');
  assert.equal(redirectUri, 'https://example.com/index.html?module=issue#issue');
  assert.equal(navigationCount, 0);
});

test('does not copy LIFF credentials or unknown query parameters into restart URL', () => {
  const lineSession = loadLineSession();
  const restartUrl = lineSession.buildLiffRestartUrl(
    '1234567890-AbCdEf',
    'https://example.com/index.html?liff.state=secret&access_token=secret&localUser=Tester&loanId=7',
    'loan',
  );

  assert.equal(restartUrl, 'https://liff.line.me/1234567890-AbCdEf?loanId=7&module=loan');
});
