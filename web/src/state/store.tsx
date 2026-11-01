import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, isOffline, type PositionItem, type WatchItem } from '../lib/api';
import { DEFAULT_SOURCE, type DataSourceKey } from '../data/sources';
import {
  clearLocal,
  localMovePosition,
  localRemovePositions,
  localSavePosition,
  localToggleWatch,
  readLocal,
  subscribeLocal,
} from '../lib/localData';
import { useAuth } from './auth';

/** 前端持仓模型（账号模式来自 /api/positions；本地模式来自 localStorage） */
export type Fund = {
  code: string;
  name: string;
  /** 持有金额（元） */
  amount: number;
  /** 持有收益（元，正红负绿） */
  profit: number;
  /** 当日收益（元） */
  dayProfit: number;
  /** 当日涨幅（%） */
  dayChange: number;
  /** 最新涨幅（%） */
  latestChange: number;
  /** 估算涨幅（%） */
  estChange: number;
  /** 数据是否已更新 */
  updated: boolean;
};

/** 列表排序键 */
export type SortKey = 'dayProfit' | 'dayChange' | 'latestChange' | 'estChange' | 'rate';
export type SortDir = 'desc' | 'asc';

/** 数据来源：live=账号（服务端），local=本浏览器，error=接口失败 */
export type DataState = 'idle' | 'loading' | 'live' | 'local' | 'anonymous' | 'error';
/** 数据归属：account=已登录写服务端，local=未登录写 localStorage */
export type StoreMode = 'account' | 'local';

type Store = {
  /** 当前数据归属（决定写服务端还是写 localStorage） */
  mode: StoreMode;
  isGuest: boolean;

  /* ---- 持仓 ---- */
  funds: Fund[];
  positionsState: DataState;
  positionsError: string;
  reloadPositions: () => Promise<void>;
  addFund: (input: { code: string; name: string; amount: number; profit: number }) => void;
  updateFund: (code: string, patch: Partial<Fund>) => void;
  removeFunds: (codes: string[]) => void;
  move: (code: string, dir: 'top' | 'up' | 'down') => void;
  sortFunds: (list: Fund[], key: SortKey, dir: SortDir) => Fund[];

  /* ---- 自选 ---- */
  watchItems: WatchItem[];
  watchState: DataState;
  watchError: string;
  favoriteCodes: string[];
  isFavorite: (code: string) => boolean;
  toggleFavorite: (code: string, name?: string) => Promise<void>;
  reloadWatchlist: () => Promise<void>;

  /* ---- 本地数据（未登录）---- */
  /** 把本浏览器的自选/持仓合并进账号（登录后由用户显式触发） */
  syncLocalToAccount: () => Promise<{ watch: number; positions: number }>;
  /** 清空本浏览器数据（危险操作，需二次确认由调用方负责） */
  clearLocalData: () => void;
  /** 本地是否有数据（账号模式下用于提示可合并） */
  localPending: { watch: number; positions: number };

  /* ---- 其他 ---- */
  dataSource: DataSourceKey;
  setDataSource: (source: DataSourceKey) => void;
};

const StoreContext = createContext<Store | null>(null);

/** 持仓 → 前端 Fund（行情字段由 useMarketData / 账本页填充） */
const toFund = (p: PositionItem): Fund => ({
  code: p.code,
  name: p.name,
  amount: p.amount,
  profit: p.profit,
  dayProfit: 0,
  dayChange: 0,
  latestChange: 0,
  estChange: 0,
  updated: true,
});

export function StoreProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const mode: StoreMode = user ? 'account' : 'local';

  /* ---------------- 持仓 ---------------- */
  const [funds, setFunds] = useState<Fund[]>([]);
  const [positionsState, setPositionsState] = useState<DataState>('idle');
  const [positionsError, setPositionsError] = useState('');

  const reloadPositions = useCallback(async () => {
    // 未登录：读浏览器本地数据（不是演示数据，是用户自己记的账）
    if (!user) {
      try {
        const { positions } = readLocal();
        setFunds(positions.map(toFund));
        setPositionsState('local');
        setPositionsError('');
      } catch (e) {
        setFunds([]);
        setPositionsState('error');
        setPositionsError((e as Error).message || '本地数据读取失败');
      }
      return;
    }
    setPositionsState('loading');
    try {
      const { items } = await api.positions.list();
      setFunds(items.map(toFund));
      setPositionsState('live');
      setPositionsError('');
    } catch (e) {
      setFunds([]);
      setPositionsState('error');
      setPositionsError(isOffline(e) ? '后端不可用，持仓未同步' : (e as Error).message);
    }
  }, [user]);

  useEffect(() => {
    void reloadPositions();
  }, [reloadPositions]);

  /* ---------------- 自选 ---------------- */
  const [watchItems, setWatchItems] = useState<WatchItem[]>([]);
  const [watchState, setWatchState] = useState<DataState>('idle');
  const [watchError, setWatchError] = useState('');

  const reloadWatchlist = useCallback(async () => {
    if (!user) {
      const { watch } = readLocal();
      setWatchItems(watch);
      setWatchState('local');
      setWatchError('');
      return;
    }
    setWatchState('loading');
    try {
      const { items } = await api.watchlist.list();
      setWatchItems(items);
      setWatchState('live');
      setWatchError('');
    } catch (e) {
      setWatchItems([]);
      setWatchState('error');
      setWatchError(isOffline(e) ? '后端不可用，自选未同步' : (e as Error).message);
    }
  }, [user]);

  useEffect(() => {
    void reloadWatchlist();
  }, [reloadWatchlist]);

  /* 本地数据变化 → 跨标签页/其他组件写入后同步（仅未登录时） */
  useEffect(() => {
    if (user) return;
    return subscribeLocal(() => {
      void reloadPositions();
      void reloadWatchlist();
    });
  }, [user, reloadPositions, reloadWatchlist]);

  const favoriteCodes = useMemo(() => watchItems.map((i) => i.code), [watchItems]);
  const isFavorite = useCallback((code: string) => favoriteCodes.includes(code), [favoriteCodes]);

  const toggleFavorite = useCallback<Store['toggleFavorite']>(
    async (code, name = '') => {
      // 未登录：写浏览器本地（体验一致，只是不同步到账号）
      if (!user) {
        localToggleWatch(code, name);
        return;
      }
      const already = favoriteCodes.includes(code);
      const prev = watchItems;
      setWatchItems(already ? prev.filter((i) => i.code !== code) : [...prev, { code, name }]);
      try {
        if (already) await api.watchlist.remove(code);
        else await api.watchlist.add(code, name);
        setWatchState('live');
        setWatchError('');
      } catch (e) {
        setWatchItems(prev);
        setWatchError(isOffline(e) ? '后端不可用，自选未保存' : (e as Error).message);
      }
    },
    [favoriteCodes, watchItems, user],
  );

  /* ---------------- 持仓操作（本地模式写 localStorage，账号模式写服务端） ---------------- */
  const addFund = useCallback<Store['addFund']>(
    ({ code, name, amount, profit }) => {
      const prev = funds;
      const existed = prev.find((f) => f.code === code);
      setFunds(
        existed
          ? prev.map((f) => (f.code === code ? { ...f, name: name || f.name, amount, profit } : f))
          : [...prev, toFund({ code, name, amount, profit })],
      );
      if (!user) {
        localSavePosition({ code, name, amount, profit });
        setPositionsState('local');
        setPositionsError('');
        return;
      }
      api.positions
        .save({ code, name, amount, profit })
        .then(() => {
          setPositionsState('live');
          setPositionsError('');
        })
        .catch((e) => {
          setFunds(prev);
          setPositionsError(isOffline(e) ? '后端不可用，持仓未保存' : (e as Error).message);
        });
    },
    [funds, user],
  );

  const updateFund = useCallback<Store['updateFund']>(
    (code, patch) => {
      const prev = funds;
      const next = prev.map((f) => (f.code === code ? { ...f, ...patch } : f));
      setFunds(next);
      const row = next.find((f) => f.code === code);
      if (!row) return;
      if (!user) {
        localSavePosition({ code: row.code, name: row.name, amount: row.amount, profit: row.profit });
        setPositionsState('local');
        return;
      }
      api.positions.save({ code: row.code, name: row.name, amount: row.amount, profit: row.profit }).catch((e) => {
        setFunds(prev);
        setPositionsError(isOffline(e) ? '后端不可用，持仓未保存' : (e as Error).message);
      });
    },
    [funds, user],
  );

  const removeFunds = useCallback<Store['removeFunds']>(
    (codes) => {
      const prev = funds;
      setFunds(prev.filter((f) => !codes.includes(f.code)));
      if (!user) {
        localRemovePositions(codes);
        setPositionsState('local');
        return;
      }
      api.positions.remove(codes).catch((e) => {
        setFunds(prev);
        setPositionsError(isOffline(e) ? '后端不可用，删除未生效' : (e as Error).message);
      });
    },
    [funds, user],
  );

  const move = useCallback<Store['move']>(
    (code, dir) => {
      const prev = funds;
      const idx = prev.findIndex((f) => f.code === code);
      if (idx < 0) return;
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      if (dir === 'top') next.unshift(item);
      else if (dir === 'up') next.splice(Math.max(0, idx - 1), 0, item);
      else next.splice(Math.min(next.length, idx + 1), 0, item);
      setFunds(next);
      if (!user) {
        localMovePosition(code, dir);
        setPositionsState('local');
        return;
      }
      api.positions.reorder(code, dir).catch((e) => {
        setFunds(prev);
        setPositionsError(isOffline(e) ? '后端不可用，排序未保存' : (e as Error).message);
      });
    },
    [funds, user],
  );

  const sortFunds = useCallback<Store['sortFunds']>((list, key, dir) => {
    const factor = dir === 'desc' ? -1 : 1;
    /** 收益率需换算（收益 / 本金），其余键直接取自基金字段 */
    const val = (f: Fund) => {
      if (key === 'rate') {
        const cost = f.amount - f.profit;
        return cost > 0 ? f.profit / cost : null;
      }
      return f[key];
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * factor;
    });
  }, []);

  /* ---------------- 本地 ↔ 账号 ---------------- */
  const [localPending, setLocalPending] = useState(() => {
    const { watch, positions } = readLocal();
    return { watch: watch.length, positions: positions.length };
  });

  // 登录态变化时刷新「可合并条数」（登录后才提示合并）
  useEffect(() => {
    const { watch, positions } = readLocal();
    setLocalPending({ watch: watch.length, positions: positions.length });
  }, [user]);

  const syncLocalToAccount = useCallback<Store['syncLocalToAccount']>(async () => {
    const { watch, positions } = readLocal();
    let w = 0;
    let p = 0;
    for (const item of watch) {
      await api.watchlist.add(item.code, item.name);
      w += 1;
    }
    for (const item of positions) {
      await api.positions.save({
        code: item.code,
        name: item.name,
        amount: item.amount,
        profit: item.profit,
      });
      p += 1;
    }
    clearLocal();
    setLocalPending({ watch: 0, positions: 0 });
    await Promise.all([reloadPositions(), reloadWatchlist()]);
    return { watch: w, positions: p };
  }, [reloadPositions, reloadWatchlist]);

  const clearLocalData = useCallback(() => {
    clearLocal();
    setLocalPending({ watch: 0, positions: 0 });
    void reloadPositions();
    void reloadWatchlist();
  }, [reloadPositions, reloadWatchlist]);

  /* ---------------- 其他 ---------------- */
  const [dataSource, setDataSource] = useState<DataSourceKey>(DEFAULT_SOURCE);

  const value = useMemo<Store>(
    () => ({
      mode,
      isGuest: mode === 'local',
      funds,
      positionsState,
      positionsError,
      reloadPositions,
      addFund,
      updateFund,
      removeFunds,
      move,
      sortFunds,
      watchItems,
      watchState,
      watchError,
      favoriteCodes,
      isFavorite,
      toggleFavorite,
      reloadWatchlist,
      syncLocalToAccount,
      clearLocalData,
      localPending,
      dataSource,
      setDataSource,
    }),
    [
      mode,
      funds,
      positionsState,
      positionsError,
      reloadPositions,
      addFund,
      updateFund,
      removeFunds,
      move,
      sortFunds,
      watchItems,
      watchState,
      watchError,
      favoriteCodes,
      isFavorite,
      toggleFavorite,
      reloadWatchlist,
      syncLocalToAccount,
      clearLocalData,
      localPending,
      dataSource,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 <StoreProvider> 内使用');
  return ctx;
}

/* ---------------- 展示格式化 ---------------- */
export const fmtMoney = (n: number, digits = 2) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** 带正负号 + 千分位的金额（账本页「当日收益」列与当日总收益使用，与截图一致） */
export const fmtMoneySigned = (n: number, digits = 2) =>
  `${n >= 0 ? '+' : '-'}${Math.abs(n).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;

export const fmtSigned = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;

export const fmtPct = (n: number, digits = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;

export const fmtCompactMoney = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(2)}万` : fmtMoney(n));
