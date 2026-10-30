// 认证与会话（仅用 node:crypto 内置模块，零依赖）
// 密码：scrypt + 随机盐；会话：随机 token（数据库只存 SHA-256 哈希）+ HttpOnly Cookie
'use strict';
const crypto = require('node:crypto');
const { getDb, purgeExpiredSessions } = require('./db.cjs');

const SESSION_COOKIE = 'fw_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

// ---------------- 密码 ----------------
/**
 * 密码哈希有两种格式（两套运行时共用同一个库）：
 *   - 新版：`pbkdf2$sha256$<iterations>$<hex>`（Cloudflare Workers / WebCrypto 生成，Node 也能生成与校验）
 *   - 旧版：裸 hex（scrypt，Node 专用；Workers 无法校验，需重置密码）
 */
const PBKDF2_PREFIX = /^pbkdf2\$sha256\$(\d+)\$([0-9a-f]+)$/i;

function pbkdf2Hash(password, salt, iterations) {
  return crypto.pbkdf2Sync(String(password), String(salt), iterations, 32, 'sha256').toString('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex'), iterations = 100000) {
  // 默认沿用 scrypt（Node 端性能更好）；如需与 Workers 互认可传 { pbkdf2: true }
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

/** PBKDF2 格式哈希（与 workers/src/auth.js 完全一致） */
function hashPasswordPbkdf2(password, salt = crypto.randomBytes(16).toString('hex'), iterations = 100000) {
  const hex = pbkdf2Hash(password, salt, iterations);
  return { hash: `pbkdf2$sha256$${iterations}$${hex}`, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const stored = String(expectedHash || '');
  const m = stored.match(PBKDF2_PREFIX);
  if (m) {
    const iterations = Number(m[1]);
    const actual = Buffer.from(pbkdf2Hash(password, salt, iterations), 'hex');
    const expected = Buffer.from(m[2], 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  // 旧版 scrypt
  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(stored, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------- 输入校验 ----------------
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5-]{3,20}$/;

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return '用户名需为 3-20 位（字母/数字/下划线/中文/连字符）';
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    return '密码长度需为 6-72 位';
  }
  return null;
}

function validateFundCode(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code) ? null : '基金代码须为 6 位数字';
}

// ---------------- 用户 ----------------
function createUser(username, password, role = 'user') {
  const { hash, salt } = hashPassword(password);
  const now = new Date().toISOString();
  try {
    const info = getDb()
      .prepare('INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, hash, salt, role, now);
    return { id: Number(info.lastInsertRowid), username, role, created_at: now };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return { error: '该用户名已被注册' };
    throw e;
  }
}

function findUserByName(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function findUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}

function publicUser(u) {
  return u ? { id: u.id, username: u.username, role: u.role || 'user', created_at: u.created_at } : null;
}

const isAdmin = (u) => !!u && (u.role === 'admin');

// ---------------- 内置管理员（root/root） ----------------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'root';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'root';

let seeded = false;

/** 确保内置管理员存在（默认 root/root，可用 ADMIN_USERNAME / ADMIN_PASSWORD 覆盖） */
function ensureAdminSeed() {
  if (seeded) return;
  seeded = true;
  const now = new Date().toISOString();
  const existing = findUserByName(ADMIN_USERNAME);
  if (!existing) {
    const { hash, salt } = hashPassword(ADMIN_PASSWORD);
    getDb()
      .prepare('INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(ADMIN_USERNAME, hash, salt, 'admin', now);
    console.warn(
      `[auth] 已创建内置管理员：${ADMIN_USERNAME}/${ADMIN_PASSWORD}` +
      (ADMIN_PASSWORD === 'root' ? '（默认弱口令，请尽快修改：ADMIN_PASSWORD 环境变量或在后台改密）' : '')
    );
  } else if (existing.role !== 'admin') {
    getDb().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    console.warn(`[auth] 已将已存在用户 ${ADMIN_USERNAME} 提升为管理员`);
  }
}

/** 修改密码（后台/个人使用） */
function changePassword(userId, newPassword) {
  const { hash, salt } = hashPassword(newPassword);
  getDb().prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, Number(userId));
  // 改密后使该用户所有旧会话失效
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
}

// ---------------- 会话 ----------------
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function createSession(userId) {
  purgeExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires };
}

function userFromSessionToken(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const row = getDb()
    .prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > ?`)
    .get(sha256(token), new Date().toISOString());
  return row || null;
}

function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// ---------------- Cookie ----------------
function parseCookies(header) {
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

function sessionCookie(token, maxAgeSec = SESSION_DAYS * 86400) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function clearCookie() {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

module.exports = {
  SESSION_COOKIE, SESSION_DAYS, ADMIN_USERNAME,
  hashPassword, hashPasswordPbkdf2, verifyPassword,
  validateCredentials, validateFundCode,
  createUser, findUserByName, findUserById, publicUser, isAdmin,
  ensureAdminSeed, changePassword,
  createSession, userFromSessionToken, destroySession,
  parseCookies, sessionCookie, clearCookie,
};
