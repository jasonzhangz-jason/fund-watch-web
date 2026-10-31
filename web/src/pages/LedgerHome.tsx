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
  /** 持仓收益率 % = 持有收益 / 本金（本金 = 持有金额 - 持有收益），本金 ≤ 0 时为 null */
  rate: number | null;
  dayProfit: number;
  dayChange: number;
  estChange: number | null;
  updated: boolean;
};

/** 持仓行右侧两列的统一列宽与间距：表头与数据行共用，保证逐列对齐 */
const COL_PROFIT = 'w-[84px]';
const COL_CHANGE = 'w-[72px]';
const COL_GAP = 'gap-x-3';

/** 持仓收益率：收益 / 本金 × 100（本金 = 当前持有金额 - 持有收益） */
function holdRate(amount: number, profit: number): number | null {
  const cost = amount - profit;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return (profit / cost) * 100;
}

/** 账本主页（对应截图 主页-1 / 主页-2）
 *  登录后走服务端账本服务 /api/portfolio：账户资产、当日收益、每日快照都在后端计算并落库；
 *  未登录或服务不可用时回落到本地行情推算，保证纯前端也能跑。60s 自动刷新 + 下拉刷新。 */
export default function LedgerHome() {
  const { funds, reloadPositions } = useStore();
  const { user, openSheet } = useAuth();
  const navigate = useNavigate();
  const [pf, setPf] = useState<Portfolio | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortKey, setSortKey] = useState<'dayProfit' | 'dayChange' | 'rate' | null>(null);
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
          rate: i.rate ?? holdRate(i.amount, i.profit),
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
            rate: holdRate(f.amount, f.profit),
            dayProfit: live ? (f.amount * dayChange) / 100 : f.dayProfit,
            dayChange,
            estChange: m?.estChange ?? null,
            updated: live ? Boolean(m?.time) : f.updated,
          };
        });

    if (!sortKey) return built;
    const factor = sortDir === 'desc' ? -1 : 1;
    return [...built].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      // 无法计算收益率的持仓始终排在最后
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * factor;
    });
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
    if (key !== 'dayProfit' && key !== 'dayChange' && key !== 'rate') return;
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

        {/* 列表头（含操作菜单锚点）：左「收益率」排序 + 右两列排序 */}
        <div className="relative mt-2.5 flex h-[34px] items-center gap-3 px-4">
          <button type="button" aria-label="账本操作" onClick={() => setMenuOpen((v) => !v)} className="flex items-center gap-2">
            <PlusCircle size={17} className={menuOpen ? 'text-primary' : 'text-ink-3'} strokeWidth={2.2} />
            <span className="tnum text-[12.5px] font-medium text-up">{upCount} ↑</span>
            <span className="tnum text-[12.5px] font-medium text-down">{downCount} ↓</span>
          </button>
          <div className="w-[62px]">
            <SortHeader label="收益率" sortKey="rate" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
          </div>
          <div className={`ml-auto flex items-center ${COL_GAP}`}>
            <div className={COL_PROFIT}>
              <SortHeader label="当日收益" date="实时" sortKey="dayProfit" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            </div>
            <div className={COL_CHANGE}>
              <SortHeader label="当日涨幅" date="盘中" sortKey="dayChange" activeKey={sortKey} dir={sortDir} onToggle={toggleSort} />
            </div>
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
                className={`flex h-[60px] w-full items-center px-4 text-left active:bg-field ${COL_GAP}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium leading-[20px] text-ink">{r.name}</p>
                  <div className="mt-[3px] flex items-center gap-1.5 leading-[18px]">
                    <UpdatedTag updated={r.updated} />
                    <span className="tnum shrink-0 text-[12.5px] text-ink-2">¥{fmtMoney(r.amount)}</span>
                    {/* 持仓收益率：持有收益 / 本金（右对齐在金额行尾，与表头「收益率」排序呼应） */}
                    <span
                      data-testid={`rate-${r.code}`}
                      className={[
                        'tnum ml-auto shrink-0 text-[12.5px] font-medium',
                        r.rate === null ? 'text-ink-3' : r.rate >= 0 ? 'text-up' : 'text-down',
                      ].join(' ')}
                    >
                      {r.rate === null ? '—' : `收益率 ${r.rate >= 0 ? '+' : ''}${r.rate.toFixed(2)}%`}
                    </span>
                  </div>
                </div>
                <span
                  className={['tnum whitespace-nowrap text-right text-[15px] font-semibold leading-[20px]', COL_PROFIT, r.dayProfit >= 0 ? 'text-up' : 'text-down'].join(' ')}
                >
                  {fmtMoneySigned(r.dayProfit)}
                </span>
                <span className={`flex justify-end ${COL_CHANGE}`}>
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
