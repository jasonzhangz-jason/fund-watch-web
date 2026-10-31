import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, LogIn, LogOut, Shield, User as UserIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PhoneFrame, TabBar } from '../components/chrome';
import { Card, StatusLine } from '../components/ui';
import { useAuth } from '../state/auth';
import { fmtMoney, fmtMoneySigned, useStore } from '../state/store';
import { marketHint, useMarketData } from '../lib/useMarketData';
import { api, isOffline, type Portfolio } from '../lib/api';

/** 「我的」页（账本 / 自选 / 我的 三 Tab 的第三个）
 *  账号信息取自登录会话（/api/auth/me），这里只展示用户可读内容（头像、用户名、角色）。
 *  资产/收益优先使用服务端账本服务 /api/portfolio（含每日快照），服务不可用时回落本地推算。 */
export default function Mine() {
  const { user, ready, online, openSheet, logout } = useAuth();
  const { watchItems, funds } = useStore();
  const navigate = useNavigate();

  /* 服务端账本（账户资产 / 当日收益 / 持仓明细） */
  const [pf, setPf] = useState<Portfolio | null>(null);
  useEffect(() => {
    if (!user) {
      setPf(null);
      return;
    }
    let alive = true;
    api
      .portfolio()
      .then((r) => alive && setPf(r.portfolio))
      .catch(() => alive && setPf(null));
    return () => {
      alive = false;
    };
  }, [user]);

  const serverMode = Boolean(user) && pf !== null;
  const codes = useMemo(() => (serverMode ? [] : funds.map((f) => f.code)), [serverMode, funds]);
  const { rows: market, state: marketState, updatedAt } = useMarketData(codes);

  /** 持仓合计与当日收益（服务端口径优先，否则按行情推算） */
  const totals = useMemo(() => {
    if (serverMode) return { amount: pf!.totalAmount, dayProfit: pf!.dayProfit };
    let amount = 0;
    let dayProfit = 0;
    for (const f of funds) {
      amount += f.amount;
      const change = market[f.code]?.dayChange;
      dayProfit += change === undefined ? f.dayProfit : (f.amount * change) / 100;
    }
    return { amount, dayProfit };
  }, [serverMode, pf, funds, market]);

  /** 持仓明细（服务端口径 → 含每只当日收益） */
  const holdings = useMemo(() => {
    if (serverMode) {
      return pf!.items.map((i) => ({
        code: i.code,
        name: i.name,
        amount: i.amount,
        profit: i.profit,
        dayChange: i.dayChange ?? 0,
      }));
    }
    return funds.map((f) => ({
      code: f.code,
      name: f.name,
      amount: f.amount,
      profit: f.profit,
      dayChange: market[f.code]?.dayChange ?? f.dayChange,
    }));
  }, [serverMode, pf, funds, market]);

  const roleText = (role: string) => (role === 'admin' ? '管理员' : '普通用户');

  return (
    <PhoneFrame>
      <div className="no-scrollbar flex-1 overflow-y-auto bg-page pb-4">
        {!user ? (
          /* ---------- 未登录 ---------- */
          <div className="px-3 pt-3">
            <Card className="px-4 py-5">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-field text-ink-3">
                  <UserIcon size={24} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold text-ink">未登录</p>
                  <p className="mt-0.5 text-[12.5px] text-ink-2">
                    {ready ? (online ? '登录后自选与账号数据可跨设备同步' : '未检测到后端服务，请先运行 pnpm start') : '正在读取会话…'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={openSheet}
                className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary text-[16px] font-semibold text-white active:opacity-90"
              >
                <LogIn size={18} />
                登录 / 注册
              </button>
            </Card>
          </div>
        ) : (
          /* ---------- 已登录 ---------- */
          <>
            <div className="px-3 pt-3">
              <Card className="px-4 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-[20px] font-bold text-white">
                    {user.username.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[18px] font-semibold text-ink">{user.username}</p>
                    <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-ink-2">
                      {user.role === 'admin' ? <Shield size={12} className="text-primary" /> : null}
                      {roleText(user.role)} · 会话已登录
                    </p>
                  </div>
                  {/* 管理员：头像栏内的后台管理入口（新标签页打开独立后台） */}
                  {user.role === 'admin' ? (
                    <button
                      type="button"
                      aria-label="后台管理"
                      onClick={() => window.open('/admin.html', '_blank', 'noopener,noreferrer')}
                      className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-primary-tint px-3 text-[12.5px] font-medium text-primary active:bg-[#D8E7FF]"
                    >
                      <Shield size={13} />
                      后台管理
                    </button>
                  ) : null}
                </div>
              </Card>
            </div>

            {/* 我的资产概览 */}
            <div className="mt-3 px-3">
              <Card className="grid grid-cols-2 divide-x divide-line px-0 py-3.5">
                <button type="button" onClick={() => navigate('/')} className="flex flex-col items-center gap-1 px-4 text-center">
                  <span className="tnum text-[20px] font-bold text-ink">{fmtMoney(totals.amount)}</span>
                  <span className="text-[12px] text-ink-2">持仓合计（元）</span>
                </button>
                <button type="button" onClick={() => navigate('/')} className="flex flex-col items-center gap-1 px-4 text-center">
                  <span className={['tnum text-[20px] font-bold', totals.dayProfit >= 0 ? 'text-up' : 'text-down'].join(' ')}>
                    {fmtMoneySigned(totals.dayProfit)}
                  </span>
                  <span className="text-[12px] text-ink-2">当日收益（估算）</span>
                </button>
              </Card>
              <StatusLine
                left={`持仓 ${holdings.length} 只`}
                right={
                  holdings.length
                    ? serverMode
                      ? '服务端账本已落库'
                      : marketHint(marketState, updatedAt, holdings.length) || '行情不可用'
                    : '暂无持仓'
                }
              />
            </div>

            {/* 我的自选 / 我的持仓 / 持仓穿透 / 相关性分析（持仓明细不再在本页平铺展示） */}
            <div className="mt-2 px-3">
              <Card className="divide-y divide-line px-0">
                <Entry
                  label="我的自选"
                  hint={`${serverMode ? pf!.watchCount : watchItems.length} 只`}
                  onClick={() => navigate('/watchlist')}
                />
                <Entry
                  label="我的持仓"
                  hint={`${holdings.length} 只`}
                  onClick={() => navigate('/')}
                />
                <Entry
                  label="持仓穿透"
                  hint="按重仓股穿透到个股"
                  onClick={() => navigate('/lookthrough')}
                />
                <Entry
                  label="基金相关性分析"
                  hint="账本基金走势相似程度"
                  onClick={() => navigate('/correlation')}
                  last
                />
              </Card>
            </div>

            <div className="mt-4 px-3">
              <button
                type="button"
                onClick={() => void logout()}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-[16px] font-medium text-down shadow-card active:bg-field"
              >
                <LogOut size={18} />
                退出登录
              </button>
            </div>
          </>
        )}
      </div>

      <TabBar />
    </PhoneFrame>
  );
}

function Entry({ label, hint, onClick, last }: { label: string; hint: string; onClick: () => void; last?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={['flex h-12 w-full items-center justify-between px-4 text-left active:bg-field', last ? '' : ''].join(' ')}
    >
      <span className="text-[15px] text-ink">{label}</span>
      <span className="flex items-center gap-1 text-[13px] text-ink-3">
        {hint}
        <ChevronRight size={16} />
      </span>
    </button>
  );
}

