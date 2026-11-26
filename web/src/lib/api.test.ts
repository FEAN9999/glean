import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiErr, request } from './api.ts';

// Regression: ISSUE-004 — an error already on screen was not translated when the language changed
// Found by /qa on 2026-11-26
// Report: .gstack/qa-reports/qa-report-localhost-2026-11-26.md

/** Runs one request against a server that answers with `res`, and returns the error it throws. */
async function errorOf(res: Response): Promise<ApiErr> {
  const real = globalThis.fetch;
  globalThis.fetch = async () => res;
  try {
    await request('/x', { method: 'POST', quiet: true });
  } catch (e) {
    assert.ok(e instanceof ApiErr);
    return e;
  } finally {
    globalThis.fetch = real;
  }
  throw new Error('the request did not fail');
}

test('an API error keeps both languages of its message', async () => {
  const body = { success: false, code: 'INVALID_PASSWORD', message: 'Mật khẩu hiện tại không đúng.', messages: { vi: 'Mật khẩu hiện tại không đúng.', en: 'The current password is not right.' } };
  const e = await errorOf(new Response(JSON.stringify(body), { status: 400, headers: { 'error-message-type': 'inline' } }));
  assert.equal(e.message, 'Mật khẩu hiện tại không đúng.');
  assert.deepEqual(e.both, { vi: 'Mật khẩu hiện tại không đúng.', en: 'The current password is not right.' });
});

test('an answer that is not from Glean still gives an error in both languages', async () => {
  // e.g. a proxy in front of the server answering with its own page
  const e = await errorOf(new Response('<html>Bad Gateway</html>', { status: 500 }));
  assert.deepEqual(e.both, { vi: 'Lỗi 500', en: 'Error 500' });
});
