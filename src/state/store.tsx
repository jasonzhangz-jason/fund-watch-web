import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, isOffline, type PositionItem, type WatchItem } from '../lib/api';
import { DEFAULT_SOURCE, type DataSourceKey } from '../data/sources';
import { useAuth } from './auth';

/** 前端持仓模型（数据全部来自后端 /api/positions + /api/portfolio） */
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
export type SortKey = 'dayProfit' | 'dayChange' | 'latestChange' | 'estChange';
export type SortDir = 'desc' | 'asc';

/** 数据来源：live=服务端实时，anonymous=未登录（不展示任何静态数据），error=接口失败 */
export type DataState = 'idle' | 'loading' | 'live' | 'anonymous' | 'error';

type Store = {
  /* ---- 持仓（账号级服务端持久化）---- */
  funds: Fund[];
  positionsState: DataState;
  positionsError: string;
  reloadPositions: () => Promise<void>;
  addFund: (input: { code: string; name: string; amount: number; profit: number }) => void;
  updateFund: (code: string, patch: Partial<Fund>) => void;
  removeFunds: (codes: string[]) => void;
  move: (code: string, dir: 'top' | 'up' | 'down') => void;
  sortFunds: (list: Fund[], key: SortKey, dir: SortDir) => Fund[];

  /* ---- 自选（账号级服务端持久化）---- */
  watchItems: WatchItem[];
  watchState: DataState;
  watchError: string;
  favoriteCodes: string[];
  isFavorite: (code: string) => boolean;
  toggleFavorite: (code: string, name?: string) => Promise<void>;
  reloadWatchlist: () => Promise<void>;

  /* ---- 其他 ---- */
  dataSource: DataSourceKey;
  setDataSource: (source: DataSourceKey) => void;
};

const StoreContext = createContext<Store | null>(null);

/** 账号持仓 → 前端 Fund（行情字段由 useMarketData / 账本服务填充） */
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

  /* ---------------- 持仓 ---------------- */
  // 未登录时不展示任何静态数据：持仓为空，由页面给出登录引导
  const [funds, setFunds] = useState<Fund[]>([]);
  const [positionsState, setPositionsState] = useState<DataState>('idle');
  const [positionsError, setPositionsError] = useState('');

  const reloadPositions = useCallback(async () => {
    if (!user) {
      setFunds([]);
      setPositionsState('anonymous');
      setPositionsError('');
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
      setWatchItems([]);
      setWatchState('anonymous');
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

  const favoriteCodes = useMemo(() => watchItems.map((i) => i.code), [watchItems]);
  const isFavorite = useCallback((code: string) => favoriteCodes.includes(code), [favoriteCodes]);

  const toggleFavorite = useCallback<Store['toggleFavorite']>(
    async (code, name = '') => {
      // 未登录：自选属于账号数据，不写入任何本地状态（页面会引导登录）
      if (!user) return;
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

  /* ---------------- 持仓操作（乐观更新 + 服务端落库） ---------------- */
  const addFund = useCallback<Store['addFund']>(
    ({ code, name, amount, profit }) => {
      const prev = funds;
      const existed = prev.find((f) => f.code === code);
      setFunds(
        existed
          ? prev.map((f) => (f.code === code ? { ...f, name: name || f.name, amount, profit } : f))
          : [...prev, toFund({ code, name, amount, profit })],
      );
      if (!user) return;
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
      if (!user) return;
      const row = next.find((f) => f.code === code);
      if (!row) return;
      api.positions
        .save({ code: row.code, name: row.name, amount: row.amount, profit: row.profit })
        .catch((e) => {
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
      if (!user) return;
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
      if (!user) return;
      api.positions.reorder(code, dir).catch((e) => {
        setFunds(prev);
        setPositionsError(isOffline(e) ? '后端不可用，排序未保存' : (e as Error).message);
      });
    },
    [funds, user],
  );

  const sortFunds = useCallback<Store['sortFunds']>((list, key, dir) => {
    const factor = dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => (a[key] - b[key]) * factor);
  }, []);

  /* ---------------- 其他 ---------------- */
  const [dataSource, setDataSource] = useState<DataSourceKey>(DEFAULT_SOURCE);

  const value = useMemo<Store>(
    () => ({
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
      dataSource,
      setDataSource,
    }),
    [
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
