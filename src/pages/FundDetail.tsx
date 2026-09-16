import { useEffect, useMemo, useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { NavBar, PhoneFrame } from '../components/chrome';
import { Card, StatusLine } from '../components/ui';
import { NavTrendChart } from '../components/NavTrendChart';
import { DataSourceModal } from '../components/DataSourceModal';
import { DATA_SOURCES, sourceLabel, type DataSourceKey } from '../data/sources';
import { useStore } from '../state/store';
import { useAuth } from '../state/auth';
import { api, type Estimate, type FundDetail as DetailResp, type Holding, type NavItem } from '../lib/api';

/** 基金详情页（对应截图 详情 / 数据源）
 *  数据全部来自后端：/api/detail（净值走势、阶段收益、费率）、/api/holdings（重仓股）、
 *  /api/estimate（盘中估值）、/api/nav（单位/累计净值与当日涨幅）。
 *  接口不可用时显示「—」与空态提示，**不使用任何静态/演示数据**。 */
export default function FundDetail() {
  const { code = '' } = useParams<{ code: string }>();
  const { dataSource, setDataSource, isFavorite, toggleFavorite } = useStore();
  const { user, openSheet } = useAuth();
  const [modalOpen, setModalOpen] = useState(false);

  const [detail, setDetail] = useState<DetailResp | null>(null);
  const [est, setEst] = useState<Estimate | null>(null);
  const [navRows, setNavRows] = useState<NavItem[]>([]);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holdingMeta, setHoldingMeta] = useState<{ quarter?: string | null; date?: string | null }>({});
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useMemo(
    () => async () => {
      if (!/^\d{6}$/.test(code)) return;
      setLoading(true);
      const [d, e, n, hd] = await Promise.allSettled([
        api.detail(code),
        api.estimates([code]),
        api.nav(code, 2),
        api.holdings(code),
      ]);
      if (d.status === 'fulfilled') setDetail(d.value);
      if (e.status === 'fulfilled') setEst(e.value.items[0] ?? null);
      if (n.status === 'fulfilled') setNavRows(n.value.items ?? []);
      if (hd.status === 'fulfilled') {
        setHoldings(hd.value.items ?? []);
        setHoldingMeta({ quarter: hd.value.quarter, date: hd.value.date });
      } else {
        setHoldings(null);
      }
      const anyOk = [d, e, n, hd].some((r) => r.status === 'fulfilled');
      setLive(anyOk);
      if (anyOk) setUpdatedAt(new Date());
      setLoading(false);
    },
    [code],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------- 数据汇总（全部来自接口，缺失即 —） ---------------- */
  const num = (v?: string) => (v === undefined || v === '' || v === null ? undefined : Number(v));

  const name = detail?.name || code;
  const navRow = navRows[0];
  const prevRow = navRows[1];
  const navDate = navRow?.date || detail?.latestDate || '';
  const navValue = navRow?.dwjz || (detail?.latestNav !== undefined ? String(detail.latestNav) : '—');

  const estChange = est?.available ? num(est.gszzl) : undefined;
  const dayChange = num(navRow?.jzzzl);

  const accNow = num(navRow?.ljjz);
  const accPrev = num(prevRow?.ljjz);
  const accChange = accNow !== undefined && accPrev ? ((accNow - accPrev) / accPrev) * 100 : undefined;
  const accValue = navRow?.ljjz;

  const sourceChange: Record<DataSourceKey, number | undefined> = { est: estChange, nav: dayChange, acc: accChange };
  const sourceNote: Record<DataSourceKey, string> = {
    est: est?.gztime || navDate,
    nav: navDate,
    acc: navDate,
  };
  const activeChange = sourceChange[dataSource];
  const activeLabel = sourceLabel(dataSource);
  const pct = (v?: number) => (v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const dateTag = (d: string) => (d ? d.slice(5, 10) : '—');

  const trend = useMemo(() => (detail?.trend ?? []).map((p) => ({ date: p.date, nav: p.nav })), [detail]);
  const hasTrend = trend.length > 1;
  const chartUp = hasTrend ? trend[trend.length - 1].nav - trend[0].nav >= 0 : true;

  const fav = isFavorite(code);
  const yTop = hasTrend ? Math.max(...trend.map((p) => p.nav)).toFixed(4) : '—';
  const yBottom = hasTrend ? Math.min(...trend.map((p) => p.nav)).toFixed(4) : '—';
  const xTicks = hasTrend
    ? [trend[0].date, trend[Math.floor(trend.length / 2)].date, trend[trend.length - 1].date].map((d) => d.slice(5))
    : [];

  const metrics = detail?.metrics;
  const realHoldings = Boolean(holdings && holdings.length > 0);
  const trendIsUp = hasTrend && trend[trend.length - 1].nav >= trend[0].nav;

  return (
    <PhoneFrame>
      <NavBar title={name} variant="blue" />

      <div className="no-scrollbar flex-1 overflow-y-auto bg-page">
        {/* 蓝色 Hero 区 */}
        <div className="bg-gradient-to-b from-hero-from to-hero-to px-4 pb-4 pt-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void load()} className="flex items-center gap-1.5 active:opacity-70" aria-label="刷新">
                <span
                  className={[
                    'rounded px-1.5 py-[1px] text-[11px] leading-[15px]',
                    live ? 'bg-primary-tint text-primary' : 'bg-white/25 text-white',
                  ].join(' ')}
                >
                  {loading ? '加载中' : live ? '已更新' : '暂无数据'}
                </span>
              </button>
              <span className="tnum text-[14px] text-white">{code}</span>
              <RefreshCw size={12} className={['text-white/80', loading ? 'animate-spin' : ''].join(' ')} />
            </div>
            <button
              type="button"
              onClick={() => {
                // 未登录：自选属于账号数据，先引导登录
                if (!user) {
                  openSheet();
                  return;
                }
                void toggleFavorite(code, name);
              }}
              className={[
                'h-[30px] rounded-full px-3.5 text-[13px] font-medium transition-colors',
                fav ? 'bg-white text-primary' : 'bg-white/40 text-white active:bg-white/50',
              ].join(' ')}
            >
              {fav ? '已自选' : '自选'}
            </button>
          </div>

          <h2 className="mt-2.5 text-[22px] font-bold leading-tight text-white">{name}</h2>
        </div>

        {/* 三指标卡 */}
        <div className="relative -mt-2 px-3">
          <Card className="grid grid-cols-3 gap-1 px-3 py-3.5">
            <Metric label={`${activeLabel}(${dateTag(sourceNote[dataSource])})`} value={pct(activeChange)} tone={activeChange} />
            <Metric label={`日涨幅(${dateTag(navDate)})`} value={pct(dayChange)} tone={dayChange} />
            <Metric label={`净值(${dateTag(navDate)})`} value={navValue} />
          </Card>
        </div>

        {/* 走势卡：真实净值走势 */}
        <div className="mt-3 px-3">
          <Card className="px-3 py-3">
            <div className="flex items-center justify-between text-[13px] text-ink-2">
              <span>{hasTrend ? `净值走势 · 近${trend.length}个交易日` : '净值走势'}</span>
              <span>
                {activeLabel} <span className={['tnum', tone(activeChange)].join(' ')}>{pct(activeChange)}</span>
              </span>
              <button
                type="button"
                aria-label="切换数据源"
                onClick={() => setModalOpen(true)}
                className="flex items-center gap-1 text-ink-2 active:opacity-60"
                title={DATA_SOURCES.find((s) => s.key === dataSource)?.hint}
              >
                <Globe size={13} />
                {activeLabel}
              </button>
            </div>

            <div className="relative mt-3 pl-9">
              <span className="absolute left-0 top-0 text-[11px] text-ink-2">{yTop}</span>
              {hasTrend ? (
                <NavTrendChart points={trend} up={trendIsUp} />
              ) : (
                <div className="flex h-[132px] items-center justify-center text-[12px] text-ink-3">
                  {loading ? '加载中…' : '暂无净值数据'}
                </div>
              )}
              <span className="absolute bottom-0 left-0 text-[11px] text-ink-2">{yBottom}</span>
            </div>
            <div className="mt-1 flex justify-between pl-9 text-[11px] text-ink-2">
              {xTicks.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>

            <StatusLine
              left={hasTrend ? `单位净值 ${trend[0].nav} → ${navValue}${accValue ? ` · 累计 ${accValue}` : ''}` : '暂无净值数据'}
              right={live ? `/api/detail${updatedAt ? ` · ${updatedAt.toTimeString().slice(0, 5)}` : ''}` : '未连接后端'}
            />
          </Card>
        </div>

        {/* 阶段收益与费率 */}
        <div className="mt-3 px-3">
          <Card className="px-4 py-3.5">
            <h3 className="text-[16px] font-semibold text-ink">阶段收益</h3>
            <div className="mt-3 grid grid-cols-4 gap-2">
              <Period label="近1月" value={metrics?.m1} />
              <Period label="近6月" value={metrics?.m6} />
              <Period label="近1年" value={metrics?.y1} />
              <Period label="近3年" value={metrics?.y3} />
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[13px]">
              <span className="text-ink-2">申购费率</span>
              <span className="tnum text-ink">
                {detail?.rate ? `${detail.rate}%` : '—'}
                {detail?.sourceRate && detail.sourceRate !== detail.rate ? (
                  <span className="ml-1 text-ink-3 line-through">{detail.sourceRate}%</span>
                ) : null}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-[13px]">
              <span className="text-ink-2">起购金额</span>
              <span className="tnum text-ink">{detail?.minsg ? `${detail.minsg} 元` : '—'}</span>
            </div>
          </Card>
        </div>

        {/* 重仓股票（真实：/api/holdings） */}
        <div className="mt-3 px-3 pb-5">
          <Card className="px-4 py-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-ink">重仓股票</h3>
              <span className="text-[11px] text-ink-3">
                {realHoldings ? [holdingMeta.quarter, holdingMeta.date].filter(Boolean).join(' · ') : ''}
              </span>
            </div>
            {realHoldings ? (
              <>
                <div className="mt-3 flex text-[12.5px] text-ink-2">
                  <span className="flex-1">股票名称</span>
                  <span className="w-[70px] text-right">涨跌幅</span>
                  <span className="w-[70px] text-right">持仓占比</span>
                  <span className="w-[84px] text-right">持仓市值</span>
                </div>
                <ul className="mt-1">
                  {holdings!.map((h, i) => (
                    <li key={h.code}>
                      <div className="flex h-11 items-center text-[15px]">
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {h.name}
                          <span className="tnum ml-1.5 text-[11.5px] text-ink-3">{h.code}</span>
                        </span>
                        <span
                          className={[
                            'tnum w-[70px] text-right font-semibold',
                            h.change === null ? 'text-ink-3' : h.change >= 0 ? 'text-up' : 'text-down',
                          ].join(' ')}
                        >
                          {h.change === null ? '—' : `${h.change >= 0 ? '+' : ''}${h.change.toFixed(2)}%`}
                        </span>
                        <span className="tnum w-[70px] text-right text-ink">
                          {h.weight === null ? '—' : `${h.weight.toFixed(2)}%`}
                        </span>
                        <span className="tnum w-[84px] text-right text-ink">
                          {h.marketValue === null ? '—' : `${h.marketValue.toLocaleString('zh-CN')}万`}
                        </span>
                      </div>
                      {i < holdings!.length - 1 ? <div className="border-b border-line" /> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="py-8 text-center text-[12.5px] text-ink-3">
                {loading ? '加载中…' : '暂无重仓股数据'}
              </p>
            )}
          </Card>
        </div>
      </div>

      {modalOpen ? (
        <DataSourceModal
          value={dataSource}
          onCancel={() => setModalOpen(false)}
          onConfirm={(next) => {
            setDataSource(next as DataSourceKey);
            setModalOpen(false);
          }}
        />
      ) : null}
    </PhoneFrame>
  );
}

const tone = (v?: number) => (v === undefined ? 'text-ink-3' : v >= 0 ? 'text-up' : 'text-down');

function Metric({ label, value, tone: t }: { label: string; value: string; tone?: number }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <span
        className={[
          // 窄屏（320px 等）自动缩小，避免三列指标互相挤压溢出
          'tnum whitespace-nowrap text-[clamp(19px,6.4vw,28px)] font-bold leading-none tracking-tight',
          t === undefined ? 'text-ink-3' : t >= 0 ? 'text-up' : 'text-down',
        ].join(' ')}
      >
        {value}
      </span>
      <span className="whitespace-nowrap text-[clamp(10px,2.9vw,11px)] text-ink-2">{label}</span>
    </div>
  );
}

function Period({ label, value }: { label: string; value?: number | null }) {
  const ok = value !== null && value !== undefined && !Number.isNaN(value);
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={['tnum text-[15px] font-semibold', !ok ? 'text-ink-3' : value >= 0 ? 'text-up' : 'text-down'].join(' ')}>
        {ok ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—'}
      </span>
      <span className="text-[11px] text-ink-2">{label}</span>
    </div>
  );
}
