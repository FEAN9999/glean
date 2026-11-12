import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { get, run, now } from './db.ts';
import { cfg } from './config.ts';
import { ApiError, ok } from './http.ts';

/* ---------------- password ---------------- */

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
}

/* ---------------- JWT (HS256) ---------------- */

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(payload: Record<string, unknown>, ttlSeconds: number) {
  const a = cfg().auth;
  const iat = Math.floor(Date.now() / 1000);
  const body = { iss: a.issuer, aud: a.audience, iat, exp: iat + ttlSeconds, ...payload };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pl = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', a.secret).update(`${head}.${pl}`).digest('base64url');
  return `${head}.${pl}.${sig}`;
}

export function verifyJwt<T = any>(token: string | undefined): T | null {
  if (!token) return null;
  const [head, pl, sig] = token.split('.');
  if (!head || !pl || !sig) return null;
  const a = cfg().auth;
  const expect = crypto.createHmac('sha256', a.secret).update(`${head}.${pl}`).digest('base64url');
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  const body = JSON.parse(Buffer.from(pl, 'base64url').toString());
  if (body.exp < Date.now() / 1000 || body.iss !== a.issuer || body.aud !== a.audience) return null;
  return body;
}

/* ---------------- TOTP (RFC 6238) ---------------- */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf: Buffer) {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(secret: string, counter: number) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}
export function verifyTotp(secret: string, code: string) {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => hotp(secret, step + d) === c);
}

/* ---------------- user helpers ---------------- */

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled: number;
  created_at: string;
}
const getUser = (id?: number) =>
  id ? get<UserRow>('SELECT * FROM app_user WHERE id=?', id) : get<UserRow>('SELECT * FROM app_user ORDER BY id LIMIT 1');

const publicUser = (u: UserRow) => ({ id: u.id, username: u.username, twoFactorEnabled: !!u.totp_enabled, createdAt: u.created_at });

function issueTokens(u: UserRow) {
  const a = cfg().auth;
  const accessToken = signJwt({ sub: u.id, scope: 'access' }, a.accessTokenMinutes * 60);
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + a.refreshTokenDays * 86400_000).toISOString();
  run('INSERT INTO refresh_token(token, user_id, expires_at, created_at) VALUES(?,?,?,?)', refreshToken, u.id, expires, now());
  run('DELETE FROM refresh_token WHERE expires_at < ?', now());
  return {
    accessToken,
    refreshToken,
    userId: u.id,
    accessTokenExpiresAt: new Date(Date.now() + a.accessTokenMinutes * 60_000).toISOString(),
    user: publicUser(u),
  };
}

export function userFromRequest(req: FastifyRequest): number | null {
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query as any)?.access_token;
  const body = verifyJwt<{ sub: number; scope: string }>(token);
  return body?.scope === 'access' ? body.sub : null;
}

/** When 2FA is on, sensitive admin writes need a fresh `x-sudo-token` from /auth/2fa/verify-code. */
export function requireSudo(req: FastifyRequest) {
  const u = getUser((req as any).userId);
  if (!u?.totp_enabled) return;
  const body = verifyJwt<{ sub: number; scope: string }>(req.headers['x-sudo-token'] as string);
  if (!body || body.scope !== 'sudo' || body.sub !== u.id)
    throw new ApiError(403, 'SUDO_REQUIRED', 'Cần nhập lại mã xác thực 2 lớp để thực hiện thao tác này.', 'inline');
}

const loginAttempts = new Map<string, { n: number; until: number }>();

export function registerAuth(app: FastifyInstance) {
  app.get('/api/auth/status', async () => ok({ hasUser: !!getUser() }));

  app.post<{ Body: { username: string; password: string } }>('/api/auth/setup', async (req) => {
    if (getUser()) throw new ApiError(409, 'ALREADY_SETUP', 'Tài khoản đã được tạo.');
    const { username, password } = req.body ?? ({} as any);
    if (!username?.trim() || !password || password.length < 8)
      throw new ApiError(400, 'INVALID_INPUT', 'Tên đăng nhập bắt buộc, mật khẩu tối thiểu 8 ký tự.', 'inline');
    run('INSERT INTO app_user(username, password_hash, created_at) VALUES(?,?,?)', username.trim(), hashPassword(password), now());
    return ok(issueTokens(getUser()!));
  });

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', async (req) => {
    const key = req.ip;
    const att = loginAttempts.get(key);
    if (att && att.until > Date.now())
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', `Thử lại sau ${Math.ceil((att.until - Date.now()) / 1000)} giây.`, 'inline');
    const { username, password } = req.body ?? ({} as any);
    const u = get<UserRow>('SELECT * FROM app_user WHERE username = ? COLLATE NOCASE', String(username ?? '').trim());
    if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
      const n = (att?.n ?? 0) + 1;
      loginAttempts.set(key, { n, until: n >= 5 ? Date.now() + 60_000 * Math.min(10, n - 4) : 0 });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu.', 'inline');
    }
    loginAttempts.delete(key);
    if (u.totp_enabled) return ok({ requires2fa: true, challenge: signJwt({ sub: u.id, scope: '2fa' }, 300) });
    return ok(issueTokens(u));
  });

  app.post<{ Body: { challenge: string; code: string } }>('/api/auth/verify-2fa', async (req) => {
    const body = verifyJwt<{ sub: number; scope: string }>(req.body?.challenge);
    if (!body || body.scope !== '2fa') throw new ApiError(401, 'CHALLENGE_EXPIRED', 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.', 'inline');
    const u = getUser(body.sub);
    if (!u?.totp_secret || !verifyTotp(u.totp_secret, req.body.code))
      throw new ApiError(401, 'INVALID_2FA_CODE', 'Mã xác thực không đúng.', 'inline');
    return ok(issueTokens(u));
  });

  app.post<{ Params: { userId: string; token: string } }>('/api/auth/refresh/:userId/:token', async (req) => {
    const row = get<{ user_id: number; expires_at: string }>('SELECT user_id, expires_at FROM refresh_token WHERE token=?', req.params.token);
    if (!row || row.user_id !== Number(req.params.userId) || row.expires_at < now())
      throw new ApiError(401, 'REFRESH_INVALID', 'Phiên đã hết hạn.', 'silent');
    run('DELETE FROM refresh_token WHERE token=?', req.params.token);
    const u = getUser(row.user_id);
    if (!u) throw new ApiError(401, 'REFRESH_INVALID', 'Phiên đã hết hạn.', 'silent');
    return ok(issueTokens(u));
  });

  app.post<{ Body: { refreshToken?: string } }>('/api/auth/logout', async (req) => {
    if (req.body?.refreshToken) run('DELETE FROM refresh_token WHERE token=?', req.body.refreshToken);
    return ok(true);
  });

  app.get('/api/auth/validate-token', async (req) => ok({ valid: userFromRequest(req) != null }));

  const me = async (req: FastifyRequest) => {
    const u = getUser((req as any).userId);
    if (!u) throw new ApiError(401, 'UNAUTHORIZED', 'Chưa đăng nhập.', 'silent');
    return ok(publicUser(u));
  };
  app.get('/api/auth/me', me);
  app.get('/api/accounts/me', me);

  app.put<{ Body: { currentPassword: string; newPassword: string } }>('/api/accounts/change-password', async (req) => {
    const u = getUser((req as any).userId)!;
    const { currentPassword, newPassword } = req.body ?? ({} as any);
    if (!verifyPassword(String(currentPassword ?? ''), u.password_hash))
      throw new ApiError(400, 'INVALID_PASSWORD', 'Mật khẩu hiện tại không đúng.', 'inline');
    if (!newPassword || newPassword.length < 8) throw new ApiError(400, 'WEAK_PASSWORD', 'Mật khẩu mới tối thiểu 8 ký tự.', 'inline');
    run('UPDATE app_user SET password_hash=? WHERE id=?', hashPassword(newPassword), u.id);
    run('DELETE FROM refresh_token WHERE user_id=?', u.id);
    return ok(issueTokens(getUser(u.id)!));
  });

  app.post('/api/auth/2fa/setup', async (req) => {
    const u = getUser((req as any).userId)!;
    if (u.totp_enabled) throw new ApiError(409, 'ALREADY_ENABLED', 'Xác thực 2 lớp đang bật.', 'inline');
    const secret = base32Encode(crypto.randomBytes(20));
    run('UPDATE app_user SET totp_pending_secret=? WHERE id=?', secret, u.id);
    const label = encodeURIComponent(`Glean:${u.username}`);
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Glean')}&algorithm=SHA1&digits=6&period=30`;
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220, color: { dark: '#16203a', light: '#ffffff' } });
    return ok({ secret, otpauthUrl, qrDataUrl });
  });

  app.post<{ Body: { code: string } }>('/api/auth/2fa/enable', async (req) => {
    const u = getUser((req as any).userId)!;
    if (!u.totp_pending_secret || !verifyTotp(u.totp_pending_secret, req.body?.code))
      throw new ApiError(400, 'INVALID_2FA_CODE', 'Mã xác thực không đúng.', 'inline');
    run('UPDATE app_user SET totp_secret=totp_pending_secret, totp_pending_secret=NULL, totp_enabled=1 WHERE id=?', u.id);
    return ok(publicUser(getUser(u.id)!));
  });

  app.post<{ Body: { code: string } }>('/api/auth/2fa/disable', async (req) => {
    const u = getUser((req as any).userId)!;
    if (!u.totp_enabled || !u.totp_secret || !verifyTotp(u.totp_secret, req.body?.code))
      throw new ApiError(400, 'INVALID_2FA_CODE', 'Mã xác thực không đúng.', 'inline');
    run('UPDATE app_user SET totp_secret=NULL, totp_enabled=0 WHERE id=?', u.id);
    return ok(publicUser(getUser(u.id)!));
  });

  app.post<{ Body: { code: string } }>('/api/auth/2fa/verify-code', async (req) => {
    const u = getUser((req as any).userId)!;
    if (!u.totp_enabled) return ok({ sudoToken: null, required: false });
    if (!u.totp_secret || !verifyTotp(u.totp_secret, req.body?.code))
      throw new ApiError(400, 'INVALID_2FA_CODE', 'Mã xác thực không đúng.', 'inline');
    return ok({ sudoToken: signJwt({ sub: u.id, scope: 'sudo' }, 15 * 60), required: true, expiresInSeconds: 900 });
  });
}

/** Exposed for tests / tooling. */
export const _totp = { hotp, base32Encode };
