import { useCallback, useMemo, useState } from 'react';
import { RefreshCw, Search, Settings, WifiOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PhoneFrame, TabBar } from '../components/chrome';
import { ChangeChip, ChangeText, EmptyState, SortHeader, StatusLine, UpdatedTag } from '../components/ui';
import { ActionMenu } from '../components/ActionMenu';
import { PullToRefresh } from '../components/PullToRefresh';
import { useStore, type SortKey } from '../state/store';
import { useAuth } from '../state/auth';
import { marketHint, useMarketData } from '../lib/useMarketData';

type Row = {
  code: string;
  name: string;
  latestChange: number;
  estChange: number;
  hasEst: boolean;
  hasQuote: boolean;
  updated: boolean;
};

/** 自选页（对应截图 自选）：列表来自账号（SQLite），涨幅为真实行情；60s 自动刷新 + 下拉刷新 */
export default function Watchlist() {
  const { watchItems, watchState, watchError, reloadWatchlist } = useStore();
  const { user, openSheet } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortKey, setSortKey] = useState<'latestChange' | 'estChange' | null>(null);
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const navigate = useNavigate();

  const codes = useMemo(() => watchItems.map((i) => i.code), [watchItems]);
  const { rows: market, state: marketState, updatedAt, refresh } = useMarketData(codes);

  /** 下拉刷新：行情 + 账号自选一起拉 */
  const pullRefresh = useCallback(async () => {
    await Promise.all([refresh(), reloadWatchlist()]);
  }, [refresh, reloadWatchlist]);

  /** 汇总：行情全部来自后端（/api/estimate + /api/nav），缺失即显示「—」，不使用静态数据 */
  const list = useMemo<Row[]>(() => {
    const built = watchItems.map((item) => {
      const m = market[item.code];
      return {
        code: item.code,
        name: m?.name || item.name,
        latestChange: m?.dayChange ?? 0,
        estChange: m?.estChange ?? 0,
        hasEst: m?.estChange !== undefined,
        hasQuote: m?.dayChange !== undefined,
        updated: Boolean(m?.time),
      };
    });
    if (!sortKey) return built;
    const factor = sortDir === 'desc' ? -1 : 1;
    return [...built].sort((a, b) => (a[sortKey] - b[sortKey]) * factor);
  }, [watchItems, market, sortKey, sortDir]);

  const upCount = list.filter((r) => r.hasQuote && r.latestChange > 0).length;
  const downCount = list.filter((r) => r.hasQuote && r.latestChange < 0).length;

  const toggleSort = (key: SortKey) => {
    if (key !== 'latestChange' && key !== 'estChange') return;
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <PhoneFrame>
      <PullToRefresh onRefresh={pullRefresh}>
        {/* 未登录提示：说明自选为什么要登录 */}
        {!user ? (
          <button
            type="button"
            aria-label="立即登录"
            onClick={openSheet}
            className="flex w-full items-center gap-2 bg-primary-tint px-4 py-2 text-left text-[12.5px] text-primary active:opacity-80"
          >
            <span className="flex-1">登录后自选会保存到账号，换设备也能看到</span>
            <span className="shrink-0 font-semibold">立即登录 ›</span>
          </button>
        ) : null}
        {user && watchError ? (
          <p className="flex items-center gap-1.5 bg-[#FFF6F6] px-4 py-2 text-[12.5px] text-up">
            <WifiOff size={13} />
            {watchError}
          </p>
        ) : null}

        {/* 列表头 */}
        <div className="relative flex h-[34px] items-center px-4">
          <button type="button" aria-label="列表设置" onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-2">
            <Settings size={17} className={menuOpen ? 'text-primary' : 'text-ink-3'} strokeWidth={2.2} />
            <span className="tnum text-[12.5px] font-medium text-up">{upCount} ↑</span>
            <span className="tnum text-[12.5px] font-medium text-down">{downCount} ↓</span>
          </button>
          <div className="ml-auto flex w-[176px] items-center">
            <SortHeader label="最新涨幅" date="实时" sortKey="latestChange" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <SortHeader label="估算涨幅" date="盘中" sortKey="estChange" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
          </div>
          {menuOpen ? <ActionMenu anchor="watchlist" onClose={() => setMenuOpen(false)} /> : null}
        </div>

        {/* 数据来源 + 手动刷新 */}
        <button type="button" onClick={() => void refresh()} className="w-full active:opacity-70">
          <StatusLine
            left={`共 ${list.length} 只`}
            right={
              <span className="flex items-center gap-1">
                {marketHint(marketState, updatedAt, list.length) ||
                  (watchState === 'live' ? '自选已同步到账号' : '待登录')}{' '}
                · 60s
                <RefreshCw size={11} className={marketState === 'loading' ? 'animate-spin' : ''} />
              </span>
            }
          />
        </button>

        {/* 自选列表 */}
        {list.length === 0 ? (
          <EmptyState
            icon={<Search size={28} />}
            title={user ? '还没有自选基金' : '登录后可添加自选'}
            desc={user ? '搜索基金并点击「＋自选」即可加入' : '自选保存在你的账号里，换设备也能看到'}
            action={
              <button
                type="button"
                aria-label={user ? '去搜索' : '登录或注册'}
                onClick={() => (user ? navigate('/search') : openSheet())}
                className="mt-2 rounded-full bg-primary px-5 py-2 text-[14px] font-semibold text-white active:opacity-90"
              >
                {user ? '去搜索' : '登录 / 注册'}
              </button>
            }
          />
        ) : (
          <ul>
            {list.map((r, i) => (
              <li key={r.code}>
                <button
                  type="button"
                  onClick={() => navigate(`/fund/${r.code}`)}
                  className="flex h-14 w-full items-center px-4 text-left active:bg-field"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15.5px] font-medium text-ink">{r.name}</p>
                    <div className="mt-0.5">
                      <UpdatedTag updated={r.updated} />
                    </div>
                  </div>
                  <span className="w-[92px] text-right">
                    {r.hasQuote ? (
                      <ChangeText value={r.latestChange} className="text-[16px]" />
                    ) : (
                      <span className="text-[16px] text-ink-3">—</span>
                    )}
                  </span>
                  <span className="flex w-[76px] justify-end">
                    <ChangeChip value={r.estChange} muted={!r.hasEst} />
                  </span>
                </button>
                {i < list.length - 1 ? <div className="ml-4 border-b border-line" /> : null}
              </li>
            ))}
          </ul>
        )}

        {marketState === 'offline' && list.length > 0 ? (
          <p className="px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
            行情接口不可用。请用 <code className="rounded bg-field px-1">pnpm start</code> 同时启动前后端后再刷新。
          </p>
        ) : null}
      </PullToRefresh>

      <TabBar />
    </PhoneFrame>
  );
}
