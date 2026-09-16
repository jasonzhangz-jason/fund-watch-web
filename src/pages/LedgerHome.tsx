import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogIn, PlusCircle, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PhoneFrame, TabBar } from '../components/chrome';
import { Card, ChangeChip, SortHeader, StatusLine, UpdatedTag } from '../components/ui';
import { ActionMenu } from '../components/ActionMenu';
import { PullToRefresh } from '../components/PullToRefresh';
import { fmtMoney, fmtMoneySigned, useStore, type SortKey } from '../state/store';
import { useAuth } from '../state/auth';
import { marketHint, useMarketData } from '../lib/useMarketData';
import { api, type Portfolio } from '../lib/api';

type Row = {
  code: string;
  name: string;
  amount: number;
  profit: number;
  dayProfit: number;
  dayChange: number;
  estChange: number | null;
  updated: boolean;
};

/** 账本主页（对应截图 主页-1 / 主页-2）
 *  登录后走服务端账本服务 /api/portfolio：账户资产、当日收益、每日快照都在后端计算并落库；
 *  未登录或服务不可用时回落到本地行情推算，保证纯前端也能跑。60s 自动刷新 + 下拉刷新。 */
export default function LedgerHome() {
  const { funds, reloadPositions } = useStore();
  const { user, openSheet } = useAuth();
  const navigate = useNavigate();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortKey, setSortKey] = useState<'dayProfit' | 'dayChange' | null>(null);
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  const loadPortfolio = useCallback(
    async (force = false) => {
      if (!user) {
        setPf(null);
        return;
      }
      try {
        const { portfolio } = await api.portfolio(force);
        setPf(portfolio);
      } catch {
        setPf(null); // 服务不可用 → 回落本地推算
      }
    },
    [user],
  );

  useEffect(() => {
    void loadPortfolio(false);
  }, [loadPortfolio]);

  /** 60 秒自动刷新（服务端口径：重算并更新当日快照） */
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadPortfolio(false);
    }, 60_000);
    return () => clearInterval(timer);
  }, [user, loadPortfolio]);

  const serverMode = Boolean(user) && pf !== null;
  /** 服务端已给出账本时不重复拉行情 */
  const codes = useMemo(() => (serverMode ? [] : funds.map((f) => f.code)), [serverMode, funds]);
  const { rows: market, state: marketState, updatedAt, refresh } = useMarketData(codes);

  /** 下拉刷新：强制刷新行情 + 账号持仓 + 账本快照 */
  const pullRefresh = useCallback(async () => {
    await Promise.all([loadPortfolio(true), reloadPositions(), refresh()]);
  }, [loadPortfolio, reloadPositions, refresh]);

  const list = useMemo<Row[]>(() => {
    const built: Row[] = serverMode
      ? pf!.items.map((i) => ({
          code: i.code,
          name: i.name,
          amount: i.amount,
          profit: i.profit,
          dayProfit: i.dayProfit,
          dayChange: i.dayChange ?? 0,
          estChange: i.estChange,
          updated: Boolean(i.updatedAt),
        }))
      : funds.map((f) => {
          const m = market[f.code];
          const live = m?.dayChange !== undefined;
          const dayChange = live ? (m.dayChange as number) : f.dayChange;
          return {
            code: f.code,
            name: m?.name || f.name,
            amount: f.amount,
            profit: f.profit,
            dayProfit: live ? (f.amount * dayChange) / 100 : f.dayProfit,
            dayChange,
            estChange: m?.estChange ?? null,
            updated: live ? Boolean(m?.time) : f.updated,
          };
        });

    if (!sortKey) return built;
    const factor = sortDir === 'desc' ? -1 : 1;
    return [...built].sort((a, b) => (a[sortKey] - b[sortKey]) * factor);
  }, [serverMode, pf, funds, market, sortKey, sortDir]);

  const totalAmount = serverMode ? pf!.totalAmount : list.reduce((s, r) => s + r.amount, 0);
  const totalDayProfit = serverMode ? pf!.dayProfit : list.reduce((s, r) => s + r.dayProfit, 0);
  const upCount = list.filter((r) => r.dayChange > 0).length;
  const downCount = list.filter((r) => r.dayChange < 0).length;
  const profitUp = totalDayProfit >= 0;

  const updatedText = (() => {
    const iso = serverMode ? pf!.updatedAt : updatedAt?.toISOString();
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
  })();

  const toggleSort = (key: SortKey) => {
    if (key !== 'dayProfit' && key !== 'dayChange') return;
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <PhoneFrame>
      <PullToRefresh onRefresh={pullRefresh}>
        {/* 账户资产卡（服务端账本服务口径） */}
        <div className="px-3 pt-3">
          <Card className="px-4 py-3.5">
            <div className="flex items-start justify-between">
              <span className="text-[13px] text-ink-2">账户资产(元)</span>
              <span className="text-[13px] text-ink-2">当日总收益</span>
            </div>
            <div className="mt-1 flex items-end justify-between">
              <span className="tnum text-[30px] font-bold leading-none text-ink">{fmtMoney(totalAmount)}</span>
              <span className={['tnum text-[20px] font-bold leading-none', profitUp ? 'text-up' : 'text-down'].join(' ')}>
                {fmtMoneySigned(totalDayProfit)}
              </span>
            </div>
          </Card>
        </div>

        {/* 列表头（含操作菜单锚点） */}
        <div className="relative mt-2.5 flex h-[34px] items-center px-4">
          <button type="button" aria-label="账本操作" onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-2">
            <PlusCircle size={17} className={menuOpen ? 'text-primary' : 'text-ink-3'} strokeWidth={2.2} />
            <span className="tnum text-[12.5px] font-medium text-up">{upCount} ↑</span>
            <span className="tnum text-[12.5px] font-medium text-down">{downCount} ↓</span>
          </button>
          <div className="ml-auto flex w-[176px] items-center">
            <SortHeader label="当日收益" date="实时" sortKey="dayProfit" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            <SortHeader label="当日涨幅" date="盘中" sortKey="dayChange" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
          </div>
          {menuOpen ? <ActionMenu anchor="ledger" onClose={() => setMenuOpen(false)} /> : null}
        </div>

        {/* 数据来源 + 刷新 */}
        <button type="button" onClick={() => void pullRefresh()} className="w-full active:opacity-70">
          <StatusLine
            left={`共 ${list.length} 只 · 收益按金额×涨幅估算`}
            right={
              <span className="flex items-center gap-1">
                {serverMode
                  ? `服务端已落库${updatedText ? ` · ${updatedText} 更新` : ''} · 60s`
                  : !user
                    ? '未登录'
                    : `${marketHint(marketState, updatedAt, list.length) || '行情不可用'} · 60s`}
                <RefreshCw size={11} className={marketState === 'loading' ? 'animate-spin' : ''} />
              </span>
            }
          />
        </button>

        {/* 持仓列表 */}
        <ul className="mt-1 bg-white">
          {list.map((r, i) => (
            <li key={r.code}>
              {/* 点击整行进入该基金详情页 */}
              <button
                type="button"
                aria-label={`查看 ${r.name} 详情`}
                onClick={() => navigate(`/fund/${r.code}`)}
                className="flex h-14 w-full items-center px-4 text-left active:bg-field"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15.5px] font-medium text-ink">{r.name}</p>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <UpdatedTag updated={r.updated} />
                    <span className="tnum text-[13px] text-ink">¥{fmtMoney(r.amount)}</span>
                  </div>
                </div>
                <span
                  className={['tnum w-[92px] text-right text-[16px] font-semibold', r.dayProfit >= 0 ? 'text-up' : 'text-down'].join(' ')}
                >
                  {fmtMoneySigned(r.dayProfit)}
                </span>
                <span className="flex w-[76px] justify-end">
                  <ChangeChip value={r.dayChange} />
                </span>
              </button>
              {i < list.length - 1 ? <div className="ml-4 border-b border-line" /> : null}
            </li>
          ))}
        </ul>

        {list.length === 0 ? (
          user ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink-3">暂无持仓，点上方 ⊕ →「添加持仓」开始记账</p>
          ) : (
            <div className="flex flex-col items-center px-8 py-10 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-field text-ink-3">
                <LogIn size={24} />
              </span>
              <p className="mt-3 text-[15px] font-medium text-ink">登录后即可记账</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                持仓、当日收益与账户资产都保存在你的账号里
              </p>
              <button
                type="button"
                onClick={openSheet}
                className="mt-5 h-11 w-full rounded-full bg-primary text-[16px] font-semibold text-white active:opacity-90"
              >
                登录 / 注册
              </button>
            </div>
          )
        ) : null}
        <div className="h-4" />
      </PullToRefresh>

      <TabBar />
    </PhoneFrame>
  );
}
