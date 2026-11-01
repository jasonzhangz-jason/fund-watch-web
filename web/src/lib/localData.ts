/**
 * 本地数据层（未登录 / 游客模式）
 *
 * 设计：
 *   - 账号数据在服务端（SQLite / D1）；**未登录时**数据落在浏览器 localStorage，功能一致、不上传
 *   - 单一存储键 + 版本号，便于将来迁移；写入后派发事件，跨标签页通过 storage 事件同步
 *   - 与账号数据同构：自选 { code, name, createdAt }、持仓 { code, name, amount, profit }
 *
 * 隐私：本模块不发送任何网络请求；登录后由 store 显式调用同步接口（用户点确认才执行）。
 */
import type { PositionItem, WatchItem } from './api';

export const LOCAL_KEY = 'fundwatch_local_v1';
const EVENT = 'fundwatch:local-changed';

export type LocalState = {
  v: 1;
  watch: WatchItem[];
  positions: PositionItem[];
};

const EMPTY: LocalState = { v: 1, watch: [], positions: [] };

/** 读取本地数据（损坏/越权数据一律回落空态，不让页面崩） */
export function readLocal(): LocalState {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<LocalState>;
    const watch = Array.isArray(parsed.watch)
      ? parsed.watch.filter((w): w is WatchItem => Boolean(w) && /^\d{6}$/.test(String(w.code)))
      : [];
    const positions = Array.isArray(parsed.positions)
      ? parsed.positions.filter((p): p is PositionItem => Boolean(p) && /^\d{6}$/.test(String(p.code)))
      : [];
    return {
      v: 1,
      watch: watch.map((w) => ({ code: w.code, name: String(w.name || ''), createdAt: w.createdAt })),
      positions: positions.map((p) => ({
        code: p.code,
        name: String(p.name || ''),
        amount: Number(p.amount) || 0,
        profit: Number(p.profit) || 0,
      })),
    };
  } catch {
    return { ...EMPTY };
  }
}

function persist(next: LocalState) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式/配额满：仍更新内存态，由调用方提示 */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** 写入本地数据（浅合并补丁） */
export function writeLocal(patch: Partial<Pick<LocalState, 'watch' | 'positions'>>) {
  const cur = readLocal();
  persist({ v: 1, watch: patch.watch ?? cur.watch, positions: patch.positions ?? cur.positions });
}

/** 订阅本地数据变化（同标签页事件 + 跨标签页 storage 事件） */
export function subscribeLocal(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCAL_KEY || e.key === null) cb();
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

/* ---------------- 自选 ---------------- */
export function localToggleWatch(code: string, name = ''): boolean {
  const { watch } = readLocal();
  const exists = watch.some((w) => w.code === code);
  const next = exists
    ? watch.filter((w) => w.code !== code)
    : [...watch, { code, name, createdAt: new Date().toISOString() }];
  writeLocal({ watch: next });
  return !exists;
}

export function localIsWatched(code: string): boolean {
  return readLocal().watch.some((w) => w.code === code);
}

/* ---------------- 持仓 ---------------- */
export function localSavePosition(p: PositionItem) {
  const { positions } = readLocal();
  const idx = positions.findIndex((x) => x.code === p.code);
  const next =
    idx >= 0
      ? positions.map((x, i) => (i === idx ? { ...x, ...p } : x))
      : [...positions, { code: p.code, name: p.name, amount: p.amount, profit: p.profit }];
  writeLocal({ positions: next });
}

export function localRemovePositions(codes: string[]) {
  const { positions } = readLocal();
  writeLocal({ positions: positions.filter((p) => !codes.includes(p.code)) });
}

export function localMovePosition(code: string, dir: 'top' | 'up' | 'down') {
  const { positions } = readLocal();
  const idx = positions.findIndex((p) => p.code === code);
  if (idx < 0) return;
  const next = [...positions];
  const [item] = next.splice(idx, 1);
  if (dir === 'top') next.unshift(item);
  else if (dir === 'up') next.splice(Math.max(0, idx - 1), 0, item);
  else next.splice(Math.min(next.length, idx + 1), 0, item);
  writeLocal({ positions: next });
}

/* ---------------- 统计 / 清理 ---------------- */
export function localCounts() {
  const { watch, positions } = readLocal();
  return { watch: watch.length, positions: positions.length };
}

export function hasLocalData(): boolean {
  const { watch, positions } = readLocal();
  return watch.length > 0 || positions.length > 0;
}

export function clearLocal() {
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* 忽略 */
  }
  window.dispatchEvent(new Event(EVENT));
}
