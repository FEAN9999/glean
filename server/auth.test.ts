import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadConfig } from './config.ts';
import { _totp, registerApiGuard, registerAuth, signJwt, verifyJwt, verifyTotp } from './auth.ts';
import { browserCookie } from './media.ts';
import { registerSystem } from './system.ts';

loadConfig(0);

const PASSWORD = 'mat-khau-thu-1';

/* ---------------- TOTP and JWT ---------------- */

test('HOTP matches the RFC 4226 test values', () => {
  const secret = _totp.base32Encode(Buffer.from('12345678901234567890'));
  const codes = [0, 1, 2, 3, 9].map((c) => _totp.hotp(secret, c));
  assert.deepEqual(codes, ['755224', '287082', '359152', '969429', '520489']);
});

test('a 2FA code is accepted 30 seconds either side of now, not further', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_763_000_000_000 });
  const secret = _totp.base32Encode(Buffer.from('12345678901234567890'));
  const step = Math.floor(Date.now() / 30_000);
  const at = (d: number) => verifyTotp(secret, _totp.hotp(secret, step + d));
  assert.deepEqual([-2, -1, 0, 1, 2].map(at), [false, true, true, true, false]);
  assert.equal(verifyTotp(secret, 'abcdef'), false);
});

test('a token with a changed payload, a past expiry or a broken shape is refused', () => {
  const good = signJwt({ sub: 1, scope: 'access' }, 60);
  assert.equal(verifyJwt<{ sub: number }>(good)?.sub, 1);
  const [head, , sig] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 2, scope: 'access', exp: 9e9 })).toString('base64url');
  assert.equal(verifyJwt(`${head}.${forged}.${sig}`), null);
  assert.equal(verifyJwt(signJwt({ sub: 1, scope: 'access' }, -1)), null);
  for (const bad of ['', 'abc', 'a.b', `${head}.${forged}`]) assert.equal(verifyJwt(bad), null, bad);
});

/* ---------------- routes ---------------- */

async function appWithAuth() {
  const app = Fastify();
  registerApiGuard(app);
  registerAuth(app);
  registerSystem(app, 0);
  await app.ready();
  return app;
}
const app = await appWithAuth();
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const login = (password: string, remoteAddress = '10.0.0.1') =>
  app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'an', password }, remoteAddress });

const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'an', password: PASSWORD } });
const userId: number = setup.json().data.userId;

test('after 5 wrong passwords that address must wait, even with the right one; another address can log in', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('sai', '10.0.0.5')).statusCode, 401);
  const blocked = await login(PASSWORD, '10.0.0.5');
  assert.deepEqual([blocked.statusCode, blocked.json().code], [429, 'TOO_MANY_ATTEMPTS']);
  assert.equal((await login(PASSWORD, '10.0.0.6')).statusCode, 200);
});

test('a refresh token works once', async () => {
  const { refreshToken } = (await login(PASSWORD)).json().data;
  const refresh = () => app.inject({ method: 'POST', url: `/api/auth/refresh/${userId}/${encodeURIComponent(refreshToken)}` });
  assert.equal((await refresh()).statusCode, 200);
  const again = await refresh();
  assert.deepEqual([again.statusCode, again.json().code], [401, 'REFRESH_INVALID']);
});

test('a browser-cookie token is not an access token', async () => {
  const cookieToken = decodeURIComponent(browserCookie(userId).split(';')[0].split('=')[1]);
  assert.equal((await app.inject({ url: '/api/auth/me', headers: bearer(cookieToken) })).statusCode, 401);
  const { accessToken } = (await login(PASSWORD)).json().data;
  assert.equal((await app.inject({ url: '/api/auth/me', headers: bearer(accessToken) })).statusCode, 200);
});

test('an access token in the URL is not accepted, since URLs end up in logs and history', async () => {
  const { accessToken } = (await login(PASSWORD)).json().data;
  const res = await app.inject({ url: `/api/auth/me?access_token=${encodeURIComponent(accessToken)}` });
  assert.equal(res.statusCode, 401);
});

test('changing the password ends every other session', async () => {
  const other = (await login(PASSWORD)).json().data;
  const mine = (await login(PASSWORD)).json().data;
  const r = await app.inject({
    method: 'PUT',
    url: '/api/accounts/change-password',
    headers: bearer(mine.accessToken),
    payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
  });
  assert.equal(r.statusCode, 200);
  const refresh = await app.inject({ method: 'POST', url: `/api/auth/refresh/${userId}/${encodeURIComponent(other.refreshToken)}` });
  assert.equal(refresh.statusCode, 401);
});

test('with 2FA on: login needs the code, and admin writes need a fresh 2FA check', async () => {
  const code = (secret: string) => _totp.hotp(secret, Math.floor(Date.now() / 30_000));
  const access = (await login(PASSWORD)).json().data.accessToken;
  const { secret } = (await app.inject({ method: 'POST', url: '/api/auth/2fa/setup', headers: bearer(access) })).json().data;
  const enable = await app.inject({ method: 'POST', url: '/api/auth/2fa/enable', headers: bearer(access), payload: { code: code(secret) } });
  assert.equal(enable.statusCode, 200);

  // the password alone now only yields a short-lived challenge, which is not an access token
  const step1 = (await login(PASSWORD)).json().data;
  assert.equal(step1.requires2fa, true);
  assert.equal((await app.inject({ url: '/api/auth/me', headers: bearer(step1.challenge) })).statusCode, 401);
  const step2 = await app.inject({ method: 'POST', url: '/api/auth/verify-2fa', payload: { challenge: step1.challenge, code: code(secret) } });
  const token = step2.json().data.accessToken;

  const save = (sudo?: string) =>
    app.inject({ method: 'PUT', url: '/api/systems/config', headers: { ...bearer(token), ...(sudo ? { 'x-sudo-token': sudo } : {}) }, payload: {} });
  for (const sudo of [undefined, token, step1.challenge]) {
    const r = await save(sudo);
    assert.deepEqual([r.statusCode, r.json().code], [403, 'SUDO_REQUIRED'], String(sudo));
  }
  const sudo = await app.inject({ method: 'POST', url: '/api/auth/2fa/verify-code', headers: bearer(token), payload: { code: code(secret) } });
  const sudoToken = sudo.json().data.sudoToken;
  assert.equal((await save(sudoToken)).statusCode, 200);
  // and the sudo token is not an access token either
  assert.equal((await app.inject({ url: '/api/auth/me', headers: bearer(sudoToken) })).statusCode, 401);
});
