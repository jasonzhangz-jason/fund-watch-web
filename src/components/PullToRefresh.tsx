import { useCallback, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Check, Loader2 } from 'lucide-react';

type PullState = 'idle' | 'pulling' | 'ready' | 'refreshing' | 'done';

/** 触发刷新的下拉距离（px） */
const THRESHOLD = 62;
/** 最大下拉距离（px） */
const MAX_PULL = 96;
/** 起始死区：小于该位移视为点按抖动，不做位移，避免吞掉列表行的点击 */
const DEAD_ZONE = 6;

/**
 * 下拉刷新容器（触摸 + 鼠标都支持）
 * 用法：把原本 `flex-1 overflow-y-auto` 的滚动区换成它，内容作为 children。
 * 状态：下拉刷新 → 松开立即刷新 → 正在刷新… → 刷新完成（带时间）
 */
export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<unknown> | unknown;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const tracking = useRef(false);
  const pullRef = useRef(0);
  const [pull, setPull] = useState(0);
  const [state, setState] = useState<PullState>('idle');
  const [doneAt, setDoneAt] = useState('');

  const applyPull = (v: number) => {
    pullRef.current = v;
    setPull(v);
  };

  const onStart = (y: number) => {
    const el = scrollRef.current;
    if (!el || el.scrollTop > 0 || state === 'refreshing') return;
    startY.current = y;
    tracking.current = true;
  };

  const onMove = (y: number) => {
    if (!tracking.current) return;
    const el = scrollRef.current;
    const dy = y - startY.current;
    if (!el || el.scrollTop > 0 || dy <= 0) {
      if (pullRef.current) {
        applyPull(0);
        setState('idle');
      }
      return;
    }
    // 死区内的位移视为点按抖动：不位移、不改状态，保证行点击不被吞掉
    if (dy < DEAD_ZONE) return;
    const p = Math.min(MAX_PULL, (dy - DEAD_ZONE) * 0.45);
    applyPull(p);
    setState(p >= THRESHOLD ? 'ready' : 'pulling');
  };

  const finish = useCallback(async () => {
    if (!tracking.current) return;
    tracking.current = false;
    if (pullRef.current < THRESHOLD) {
      applyPull(0);
      setState('idle');
      return;
    }
    applyPull(THRESHOLD);
    setState('refreshing');
    try {
      await onRefresh();
    } catch {
      /* 刷新失败不阻断界面 */
    }
    const now = new Date();
    setDoneAt(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    setState('done');
    applyPull(0);
    setTimeout(() => setState((s) => (s === 'done' ? 'idle' : s)), 1200);
  }, [onRefresh]);

  const cancel = () => {
    tracking.current = false;
    applyPull(0);
    setState('idle');
  };

  const showIndicator = state === 'refreshing' || pull > 0;
  const hint =
    state === 'refreshing'
      ? '正在刷新…'
      : state === 'done'
        ? `刷新完成 · ${doneAt}`
        : pull >= THRESHOLD
          ? '松开立即刷新'
          : '下拉刷新';

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* 下拉指示器 */}
      <div
        data-testid="ptr"
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-end justify-center overflow-hidden"
        style={{ height: showIndicator ? Math.max(pull, state === 'refreshing' ? THRESHOLD : 0) : 0, opacity: showIndicator ? 1 : 0 }}
      >
        <div className="flex items-center gap-1.5 pb-2 text-[12px] text-ink-2">
          {state === 'refreshing' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : state === 'done' ? (
            <Check size={13} className="text-primary" />
          ) : (
            <ArrowDown size={13} className={pull >= THRESHOLD ? 'rotate-180' : ''} />
          )}
          <span>{hint}</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="no-scrollbar h-full overflow-y-auto overscroll-contain"
        onTouchStart={(e) => onStart(e.touches[0].clientY)}
        onTouchMove={(e) => onMove(e.touches[0].clientY)}
        onTouchEnd={() => void finish()}
        onTouchCancel={cancel}
        onMouseDown={(e) => onStart(e.clientY)}
        onMouseMove={(e) => {
          if (tracking.current) onMove(e.clientY);
        }}
        onMouseUp={() => void finish()}
        onMouseLeave={() => {
          if (tracking.current) cancel();
        }}
      >
        <div style={{ transform: `translateY(${pull}px)`, transition: pull ? 'none' : 'transform .22s ease-out' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
