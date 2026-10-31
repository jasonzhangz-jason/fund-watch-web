import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, LogIn, PieChart, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NavBar, PhoneFrame } from '../components/chrome';
import { Card, EmptyState } from '../components/ui';
import { useAuth } from '../state/auth';
import { fmtMoney } from '../state/store';
import { api, type LookThrough as LookThroughData } from '../lib/api';

/**
 * 持仓穿透（对应「我的 → 持仓穿透」）
 *   把持仓按各基金**前十大重仓股**穿透到个股：显示个股穿透金额、占账户比，
 *   以及**具体哪几只基金持有它**（各自的占净值比例与贡献金额）。
 *   覆盖比例 = 穿透金额 / 账户资产，非 100%（只覆盖前十大重仓），界面如实标注。
 */
export default function LookThrough() {
  const { user, ready, openSheet } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<LookThroughData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 排序：按穿透金额 / 占账户比 / 涉及基金数 */
  const [sortBy, setSortBy] = useState<'amount' | 'ratio' | 'fundCount'>('amount');

  const load = useCallback(
    async (force = false) => {
      if (!user) return;
      setLoading(true);
      try {
        const r = await api.lookthrough(force);
        setData(r.lookthrough);
        setError('');
      } catch (e) {
        setError((e as Error).message || '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [user],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    if (!data) return [];
    return [...data.items].sort((a, b) => b[sortBy] - a[sortBy]);
  }, [data, sortBy]);

  /* ---------------- 未登录 ---------------- */
  if (ready && !user) {
    return (
      <PhoneFrame>
        <NavBar title="持仓穿透" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-page px-8">
          <EmptyState
            icon={<PieChart size={30} />}
            title="登录后查看持仓穿透"
            desc="穿透需要读取你的持仓，再按各基金重仓股逐层拆解"
            action={
              <button
                type="button"
                aria-label="登录或注册"
                onClick={openSheet}
                className="mt-2 flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-[15px] font-semibold text-white active:opacity-90"
              >
                <LogIn size={17} />
                登录 / 注册
              </button>
            }
          />
        </div>
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame>
      <NavBar title="持仓穿透" />

      <div className="no-scrollbar flex-1 overflow-y-auto bg-page pb-6">
        {/* 概览：穿透资产 / 覆盖率 */}
        <div className="px-3 pt-3">
          <Card className="px-4 py-3.5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[13px] text-ink-2">穿透资产(元)</p>
                <p className="tnum mt-1 text-[26px] font-bold leading-none text-ink">
                  {data ? fmtMoney(data.coveredAmount) : '—'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[13px] text-ink-2">账户资产(元)</p>
                <p className="tnum mt-1 text-[16px] font-semibold leading-none text-ink-2">
                  {data ? fmtMoney(data.totalAmount) : '—'}
                </p>
              </div>
            </div>

            <div className="mt-3">
              <div className="flex items-center justify-between text-[12px] text-ink-2">
                <span>
                  重仓股覆盖 <b className="tnum text-ink">{data ? `${data.coverage.toFixed(1)}%` : '—'}</b>
                </span>
                <span>
                  {data ? `${data.stockCount} 只个股 · ${data.positionCount} 只基金` : ''}
                </span>
              </div>
              <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${Math.min(100, data?.coverage ?? 0)}%` }}
                />
              </div>
            </div>

            <p className="mt-2 text-[11px] leading-[16px] text-ink-3">
              口径：个股穿透金额 = Σ（该基金持有金额 × 该股票占净值比例）。仅覆盖各基金<b>前十大重仓股</b>，
              故覆盖率通常小于 100%，未覆盖部分为基金的其他持仓与现金。
              {data?.quarter ? ` 数据期：${data.quarter}${data.date ? ` · ${data.date}` : ''}` : ''}
              {data?.stale ? '（上游暂不可用，显示缓存数据）' : ''}
            </p>

            <button
              type="button"
              aria-label="刷新穿透数据"
              onClick={() => void load(true)}
              className="mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-field text-[13px] text-ink-2 active:bg-line"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              {loading ? '穿透中…' : '重新穿透'}
            </button>
          </Card>
        </div>

        {/* 排序 */}
        <div className="mt-2.5 flex items-center gap-2 px-4">
          <span className="text-[12px] text-ink-3">排序</span>
          {(
            [
              ['amount', '穿透金额'],
              ['ratio', '占账户比'],
              ['fundCount', '涉及基金数'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-label={`按${label}排序`}
              onClick={() => setSortBy(key)}
              className={[
                'rounded-full px-2.5 py-1 text-[12px]',
                sortBy === key ? 'bg-primary-tint font-medium text-primary' : 'bg-white text-ink-2',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        {error ? <p className="px-4 py-6 text-center text-[13px] text-up">{error}</p> : null}

        {/* 个股列表 */}
        {!error && data && items.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">
            暂无穿透数据：请先在「账本」添加持仓，且持仓基金需已披露重仓股
          </p>
        ) : null}

        <ul className="mt-2 bg-white">
          {items.map((s, i) => {
            const open = expanded === s.code;
            return (
              <li key={s.code}>
                <button
                  type="button"
                  aria-label={`${s.name} 穿透明细`}
                  onClick={() => setExpanded(open ? null : s.code)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-field"
                >
                  <span className="tnum w-[18px] shrink-0 text-[12px] text-ink-3">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium text-ink">{s.name}</p>
                    <p className="tnum mt-0.5 text-[12px] text-ink-3">
                      {s.code} · {s.fundCount} 只基金持有
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tnum text-[15px] font-semibold text-ink">¥{fmtMoney(s.amount)}</p>
                    <p className="tnum mt-0.5 text-[12px] text-ink-2">占账户 {s.ratio.toFixed(2)}%</p>
                  </div>
                  <span className="shrink-0 text-ink-3">
                    {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </span>
                </button>

                {/* 具体哪几只基金持有 */}
                {open ? (
                  <ul className="bg-page px-4 pb-3 pt-1">
                    {s.funds.map((f) => (
                      <li key={f.code}>
                        <button
                          type="button"
                          aria-label={`查看 ${f.name} 详情`}
                          onClick={() => navigate(`/fund/${f.code}`)}
                          className="flex w-full items-center gap-2 rounded-card bg-white px-3 py-2 text-left active:opacity-70"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13.5px] text-ink">{f.name}</p>
                            <p className="tnum mt-0.5 text-[11.5px] text-ink-3">占净值 {f.weight.toFixed(2)}%</p>
                          </div>
                          <span className="tnum shrink-0 text-[13px] font-medium text-ink">¥{fmtMoney(f.amount)}</span>
                        </button>
                      </li>
                    ))}
                    <li className="mt-1.5 px-1 text-[11px] text-ink-3">
                      「占净值」为该股票在对应基金中的持仓占比；右侧金额为该基金为你贡献的穿透金额。
                    </li>
                  </ul>
                ) : null}

                {i < items.length - 1 ? <div className="ml-4 border-b border-line" /> : null}
              </li>
            );
          })}
        </ul>

        {/* 无重仓股数据的基金（如实标注） */}
        {data && data.noData.length > 0 ? (
          <div className="mt-3 px-3">
            <Card className="px-4 py-3">
              <p className="text-[13px] font-medium text-ink">未纳入穿透的基金（{data.noData.length} 只）</p>
              <p className="mt-1 text-[11.5px] leading-[16px] text-ink-3">
                以下基金暂未披露股票重仓明细（如债券型 / QDII / 新成立基金），未计入穿透金额：
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {data.noData.map((f) => (
                  <li key={f.code} className="rounded-full bg-field px-2.5 py-1 text-[11.5px] text-ink-2">
                    {f.name} ¥{fmtMoney(f.amount)}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        ) : null}
      </div>
    </PhoneFrame>
  );
}
