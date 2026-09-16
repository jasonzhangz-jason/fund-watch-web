import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';

/** 单只基金的行情快照（真实数据） */
export type MarketRow = {
  code: string;
  name?: string;
  /** 最新单位净值 */
  nav?: number;
  navDate?: string;
  /** 当日涨幅 %（取自最新净值的 jzzzl） */
  dayChange?: number;
  /** 盘中估算涨幅 %（fundgz 可用时才有） */
  estChange?: number;
  estAvailable?: boolean;
  /** 估值时间或净值日期 */
  time?: string;
};

export type MarketState = 'idle' | 'loading' | 'live' | 'offline';

/**
 * 批量拉取真实行情：/api/estimate（盘中估值，一次多只）+ /api/nav（最新净值与当日涨幅）。
 * 失败时置为 'offline'（表示行情不可用），页面据此显示「—」与提示，不使用任何静态数据。
 */
export function useMarketData(codes: string[], opts?: { intervalMs?: number }) {
  const key = useMemo(() => [...new Set(codes.filter(Boolean))].sort().join(','), [codes]);
  const [rows, setRows] = useState<Record<string, MarketRow>>({});
  const [state, setState] = useState<MarketState>('idle');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const list = key ? key.split(',') : [];
    if (!list.length) {
      setRows({});
      setState('idle');
      return;
    }
    const my = ++reqId.current;
    setState((prev) => (prev === 'live' || prev === 'offline' ? prev : 'loading'));

    try {
      const [est, navs] = await Promise.all([
        api.estimates(list),
        Promise.all(list.map((c) => api.nav(c, 1).catch(() => null))),
      ]);
      if (my !== reqId.current) return;

      const estMap = new Map(est.items.map((i) => [i.code, i]));
      const next: Record<string, MarketRow> = {};
      list.forEach((code, i) => {
        const e = estMap.get(code);
        const navRow = navs[i]?.items?.[0];
        const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));

        // 盘中估值可用 → 单独作为估算涨幅；不可用时 estimate 返回的就是最新净值涨幅
        const estChange = e?.available ? num(e.gszzl) : undefined;
        const dayChange = num(navRow?.jzzzl) ?? (!e?.available ? num(e?.gszzl) : undefined);

        next[code] = {
          code,
          name: e?.name || undefined,
          nav: num(navRow?.dwjz) ?? (e && !e.available ? num(e.gsz) : undefined),
          navDate: navRow?.date || e?.jzrq || undefined,
          dayChange,
          estChange,
          estAvailable: estChange !== undefined,
          time: e?.gztime || navRow?.date || undefined,
        };
      });

      setRows(next);
      setState('live');
      setUpdatedAt(new Date());
    } catch {
      if (my !== reqId.current) return;
      setState('offline');
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  // 定时刷新（默认 60s）；页面不可见时跳过，避免无谓请求
  useEffect(() => {
    const ms = opts?.intervalMs ?? 60_000;
    if (!ms) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, ms);
    return () => clearInterval(timer);
  }, [load, opts?.intervalMs]);

  return { rows, state, updatedAt, refresh: load };
}

/** 行情状态文案（用于列表上方的轻量提示行） */
export function marketHint(state: MarketState, updatedAt: Date | null, count: number) {
  if (state === 'live') {
    const t = updatedAt ? updatedAt.toTimeString().slice(0, 5) : '';
    return `实时数据 · 天天基金${t ? ` · ${t} 更新` : ''}`;
  }
  if (state === 'loading') return '正在获取行情…';
  if (state === 'offline') return '行情不可用（未连接后端）';
  return count ? '' : '';
}
