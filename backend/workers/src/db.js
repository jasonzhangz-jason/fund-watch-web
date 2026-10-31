/**
 * D1 访问封装
 *   D1 的 API 是**异步**的（node:sqlite 是同步），因此 Workers 侧所有查询都要 await。
 *   这里统一三个入口：one（取一行）/ all（取多行）/ run（写），以及 batch（批量原子提交）。
 */

/** D1 不接受 undefined，统一转成 null */
const norm = (args) => args.map((v) => (v === undefined ? null : v));

/** 取一行（无结果返回 null） */
export async function one(db, sql, ...args) {
  const row = await db.prepare(sql).bind(...norm(args)).first();
  return row || null;
}

/** 取多行 */
export async function all(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...norm(args)).all();
  return (res && res.results) || [];
}

/** 执行写入，返回 { changes, lastRowId } */
export async function run(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...norm(args)).run();
  const meta = (res && res.meta) || {};
  return { changes: Number(meta.changes || 0), lastRowId: Number(meta.last_row_id || 0) };
}

/** 批量执行（D1 的 batch 是原子的）；items: [{ sql, args: [] }] */
export async function batch(db, items) {
  if (!items.length) return [];
  return db.batch(items.map((it) => db.prepare(it.sql).bind(...norm(it.args || []))));
}

/** 计数便捷函数 */
export async function count(db, sql, ...args) {
  const row = await one(db, sql, ...args);
  return Number(row ? Object.values(row)[0] : 0) || 0;
}

export const nowIso = () => new Date().toISOString();

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 本地时区的今天（YYYY-MM-DD）：与 Node 端 todayLocal 一致 */
export const todayLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 统一响应体：与 Node 端 handlers 返回的 { status, headers, body } 一致 */
export const ok = (body, headers = {}) => ({ status: 200, headers, body: { ok: true, ...body } });
export const err = (status, error) => ({ status, headers: {}, body: { ok: false, error } });
