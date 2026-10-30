/**
 * 认证（Cloudflare Workers 版）
 *
 * 与 Node 端的差异：Workers 没有 node:crypto 的 scrypt，改用 **WebCrypto 的 PBKDF2-SHA256**。
 *   - 新密码哈希格式：`pbkdf2$sha256$<iterations>$<hex>`
 *   - 兼容：Node 端也认这个格式（见 server/auth.cjs 的 verifyPassword），因此两套运行时可以共用一个 D1 库
 *   - 旧库里的 scrypt 哈希（无前缀的裸 hex）在 Workers 里**无法验证**，需要重置密码（见 docs/cloudflare.md）
 */
const SESSION_COOKIE = 'fw_session';
const SESSION_DAYS = 30;
const KEY_BYTES = 32;

const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex) {
  const clean = String(hex || '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 常量时间比较（避免时序侧信道） */
function safeEqual(a, b) {
  const sa = String(a);
  const sb = String(b);
  let diff = sa.length ^ sb.length;
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i += 1) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export const iterationsOf = (env) => {
  const n = Number((env && env.PBKDF2_ITERATIONS) || 100000);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : 100000;
};

async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    // 注意：salt 与 Node 端一致，按 **hex 字符串的字节** 参与派生（而不是解码成 16 字节），
    // 这样两套运行时对同一 (password, salt) 得到相同结果，D1 库可互认。
    { name: 'PBKDF2', salt: enc.encode(String(saltHex)), iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8,
  );
  return toHex(bits);
}

/** 生成密码哈希（salt 为 16 字节 hex） */
export async function hashPassword(password, iterations) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hex = await pbkdf2Hex(password, salt, iterations);
  return { hash: `pbkdf2$sha256$${iterations}$${hex}`, salt };
}

/** 校验密码：支持 pbkdf2 前缀格式；scrypt 裸 hex 在 Workers 中不可验证，返回 false */
export async function verifyPassword(password, salt, storedHash, iterations) {
  const stored = String(storedHash || '');
  if (!stored.startsWith('pbkdf2$')) return false; // 旧 scrypt 哈希：需重置密码
  const [, , iterRaw, hex] = stored.split('$');
  const iter = Number(iterRaw) || iterations;
  const actual = await pbkdf2Hex(password, salt, iter);
  return safeEqual(actual, hex);
}

/** 令牌：32 字节随机 → 64 位 hex（与 Node 端一致） */
export const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(value)));
  return toHex(digest);
}

/* ---------------- 输入校验（与 Node 端同一套规则） ---------------- */
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{3,20}$/;

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return '用户名需为 3-20 位（字母/数字/下划线/中文/连字符）';
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    return '密码长度需为 6-72 位';
  }
  return null;
}

export const validateFundCode = (code) =>
  typeof code === 'string' && /^\d{6}$/.test(code) ? null : '基金代码须为 6 位数字';

export const publicUser = (u) =>
  u ? { id: u.id, username: u.username, role: u.role || 'user', created_at: u.created_at } : null;

export const isAdmin = (u) => Boolean(u) && u.role === 'admin';

/* ---------------- Cookie ---------------- */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionCookie(token, secure, maxAgeSec = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export { SESSION_COOKIE, SESSION_DAYS };
