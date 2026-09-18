import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, LogIn, RefreshCw } from 'lucide-react';
import { NavBar, PhoneFrame } from '../components/chrome';
import { Card, EmptyState } from '../components/ui';
import { useAuth } from '../state/auth';
import { api, type Correlation } from '../lib/api';

/** 相关性底色：正相关越强越红（同涨同跌），负相关越强越绿（分散效果好） */
function corrStyle(v: number | null) {
  if (v === null) return { background: '#F1F2F4', color: '#9AA0AA' };
  const a = Math.min(1, Math.abs(v));
  const alpha = 0.06 + a * 0.6;
  const strong = a > 0.55;
  return v >= 0
    ? { background: `rgba(232,48,60,${alpha.toFixed(3)})`, color: strong ? '#fff' : '#5B6068' }
    : { background: `rgba(28,149,116,${alpha.toFixed(3)})`, color: strong ? '#fff' : '#5B6068' };
}

/** 相关性等级文案（与后端 level 对应） */
const levelText = (v: number) => (v >= 0.8 ? '高度相关' : v >= 0.5 ? '中度相关' : v >= 0 ? '低相关' : '负相关');

/**
 * 基金相关性分析（我的 → 基金相关性分析）
 *   用**对齐到共同交易日的日收益率**算皮尔逊相关系数，衡量账本内基金走势的相似程度。
 *   用收益率而非净值本身：两只长期上涨的基金净值天然同向，直接对净值求相关会虚高。
 */
export default function CorrelationPage() {
  const { user, ready, openSheet } = useAuth();
  const [days, setDays] = useState(60);
  const [data, setData] = useState<Correlation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (win = days, force = false) => {
      if (!user) return;
      setLoading(true);
      try {
        const r = await api.correlation(win, force);
        setData(r.correlation);
        setError('');
      } catch (e) {
        setError((e as Error).message || '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [user, days],
  );

  useEffect(() => {
    void load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, days]);

  const funds = data?.funds ?? [];
  /** 短标签：矩阵表头用序号，图例用完整名称 */
  const label = (i: number) => String(i + 1);

  const interpretation = useMemo(() => {
    if (!data || data.avgCorr === null) return '';
    const a = data.avgCorr;
    if (a >= 0.8) return '账本内基金高度同涨同跌，分散化效果有限，可考虑换成相关性更低的品种';
    if (a >= 0.5) return '整体中度相关：有一定分散，但同向波动仍较明显';
    if (a >= 0.2) return '相关性偏低，组合分散效果较好';
    return '相关性很低甚至负相关，分散效果很好';
  }, [data]);

  if (ready && !user) {
    return (
      <PhoneFrame>
        <NavBar title="基金相关性分析" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-page px-8">
          <EmptyState
            icon={<Activity size={30} />}
            title="登录后查看相关性分析"
            desc="需要读取你的账本持仓与历史净值，计算基金之间走势的相似程度"
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
      <NavBar title="基金相关性分析" />

      <div className="no-scrollbar flex-1 overflow-y-auto bg-page pb-6">
        {/* 窗口切换 */}
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="text-[12px] text-ink-3">分析窗口</span>
          {[30, 60, 120].map((d) => (
            <button
              key={d}
              type="button"
              aria-label={`近${d}个交易日`}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={[
                'rounded-full px-2.5 py-1 text-[12px]',
                days === d ? 'bg-primary-tint font-medium text-primary' : 'bg-white text-ink-2',
              ].join(' ')}
            >
              近{d}日
            </button>
          ))}
          <button
            type="button"
            aria-label="刷新相关性"
            onClick={() => void load(days, true)}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full bg-white text-ink-3 active:bg-field"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* 概览 */}
        <div className="mt-2.5 px-3">
          <Card className="px-4 py-3.5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[13px] text-ink-2">平均相关性</p>
                <p
                  data-testid="avg-corr"
                  className={[
                    'tnum mt-1 text-[26px] font-bold leading-none',
                    data?.avgCorr === null || data?.avgCorr === undefined
                      ? 'text-ink-3'
                      : data.avgCorr >= 0.5
                        ? 'text-up'
                        : 'text-down',
                  ].join(' ')}
                >
                  {data?.avgCorr === null || data?.avgCorr === undefined ? '—' : data.avgCorr.toFixed(2)}
                </p>
              </div>
              <div className="text-right text-[11.5px] leading-[17px] text-ink-3">
                <p>{data ? `${data.fundCount} 只基金 · ${data.pairs.length} 组对比` : ''}</p>
                <p>{data?.startDate ? `${data.startDate} ~ ${data.endDate}` : ''}</p>
                <p>{data ? `共同交易日 ${data.pointCount} 天` : ''}</p>
              </div>
            </div>
            {interpretation ? <p className="mt-2 text-[12px] leading-[18px] text-ink-2">{interpretation}</p> : null}
            <p className="mt-1.5 text-[11px] leading-[16px] text-ink-3">
              口径：对**日收益率**（净值环比涨跌）求皮尔逊相关系数，并只使用所有基金都有净值的共同交易日；
              区间越接近 1 越同步，0 附近为不相关，负值表示反向波动。
            </p>
          </Card>
        </div>

        {error ? <p className="px-4 py-6 text-center text-[13px] text-up">{error}</p> : null}

        {!error && data && data.pairs.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] leading-[20px] text-ink-3">
            {data.reason || '账本至少需要 2 只基金，且需要有足够的共同交易日才能分析'}
          </p>
        ) : null}

        {data && data.pairs.length > 0 ? (
          <>
            {/* 最相似 / 最分散 */}
            <div className="mt-3 grid grid-cols-2 gap-2.5 px-3">
              {[
                { title: '最相似', pair: data.mostSimilar, tone: 'text-up' },
                { title: '最分散', pair: data.mostDiverse, tone: 'text-down' },
              ].map(({ title, pair, tone }) => (
                <Card key={title} className="px-3 py-3">
                  <p className="text-[12px] text-ink-3">{title}</p>
                  <p className="tnum mt-1 text-[20px] font-bold leading-none">
                    <span className={tone}>{pair ? pair.corr.toFixed(2) : '—'}</span>
                  </p>
                  <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-[16px] text-ink-2">
                    {pair ? `${pair.aName} ↔ ${pair.bName}` : '—'}
                  </p>
                </Card>
              ))}
            </div>

            {/* 相关性矩阵 */}
            <div className="mt-3 px-3">
              <Card className="px-3 py-3">
                <p className="text-[13px] font-medium text-ink">相关性矩阵</p>
                <div className="mt-2 overflow-x-auto">
                  <table data-testid="corr-matrix" className="w-full border-separate border-spacing-[2px] text-[11px]">
                    <thead>
                      <tr>
                        <th className="w-[104px]" />
                        {funds.map((_, j) => (
                          <th key={j} className="text-center font-medium text-ink-3">
                            {label(j)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {funds.map((f, i) => (
                        <tr key={f.code}>
                          <th className="max-w-[104px] truncate pr-1 text-left font-normal text-ink-2">
                            <span className="tnum mr-1 text-ink-3">{label(i)}</span>
                            {f.name}
                          </th>
                          {funds.map((_, j) => {
                            const v = data.matrix[i]?.[j] ?? null;
                            const st = corrStyle(v);
                            return (
                              <td
                                key={j}
                                data-testid={`corr-${i}-${j}`}
                                style={st}
                                className="tnum h-[26px] rounded-[4px] text-center font-medium"
                              >
                                {v === null ? '—' : v.toFixed(2)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[10.5px] text-ink-3">
                  <span className="flex items-center gap-1">
                    <i className="inline-block h-[10px] w-[10px] rounded-[2px]" style={{ background: 'rgba(232,48,60,0.5)' }} />
                    正相关（同涨同跌）
                  </span>
                  <span className="flex items-center gap-1">
                    <i className="inline-block h-[10px] w-[10px] rounded-[2px]" style={{ background: 'rgba(28,149,116,0.5)' }} />
                    负相关（互相分散）
                  </span>
                </div>
                <ul className="mt-2 border-t border-line pt-2 text-[11px] leading-[17px] text-ink-2">
                  {funds.map((f, i) => (
                    <li key={f.code} className="truncate">
                      <span className="tnum mr-1 text-ink-3">{label(i)}</span>
                      {f.name}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            {/* 两两组合明细 */}
            <div className="mt-3 px-3">
              <Card className="px-4 py-3">
                <p className="text-[13px] font-medium text-ink">两两组合（按相关性从高到低）</p>
                <ul className="mt-2">
                  {data.pairs.map((p) => {
                    const st = corrStyle(p.corr);
                    return (
                      <li key={`${p.aCode}-${p.bCode}`} className="flex items-center gap-2 py-[7px]">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12.5px] text-ink">
                            {p.aName} <span className="text-ink-3">↔</span> {p.bName}
                          </p>
                          <div className="mt-1 h-[4px] w-full overflow-hidden rounded-full bg-line">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.min(100, Math.abs(p.corr) * 100)}%`, background: st.background }}
                            />
                          </div>
                        </div>
                        <span className="tnum shrink-0 text-[13px] font-semibold text-ink">{p.corr.toFixed(2)}</span>
                        <span className="w-[54px] shrink-0 text-right text-[11px] text-ink-3">
                          {levelText(p.corr)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          </>
        ) : null}

        {/* 数据不足的基金 */}
        {data && data.insufficient.length > 0 ? (
          <div className="mt-3 px-3">
            <Card className="px-4 py-3">
              <p className="text-[13px] font-medium text-ink">未纳入分析（{data.insufficient.length} 只）</p>
              <p className="mt-1 text-[11.5px] leading-[16px] text-ink-3">
                以下基金缺少足够的净值历史（或为无净值波动的品种），无法参与相关性计算：
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {data.insufficient.map((f) => (
                  <li key={f.code} className="rounded-full bg-field px-2.5 py-1 text-[11.5px] text-ink-2">
                    {f.name}
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
