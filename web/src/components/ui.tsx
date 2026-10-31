import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import type { SortDir, SortKey } from '../state/store';

/* ============================ 涨跌色块 ============================ */
/** 实心色块（涨红 / 跌绿 + 白字），用于「当日涨幅 / 估算涨幅」列。
 *  muted=true 时表示该数据暂不可用（例如非交易时段无盘中估值）。 */
export function ChangeChip({
  value,
  muted = false,
  size = 'md',
  className = '',
}: {
  value: number;
  muted?: boolean;
  /** md=72×26（默认）；sm=68×24，用于账本等多列密集列表 */
  size?: 'md' | 'sm';
  className?: string;
}) {
  if (muted) {
    return (
      <span
        className={[
          'tnum inline-flex items-center justify-center rounded-md bg-[#C8CDD6] font-semibold text-white',
          size === 'sm' ? 'h-[24px] w-[68px] text-[14.5px]' : 'h-[26px] w-[72px] text-[16px]',
          className,
        ].join(' ')}
      >
        —
      </span>
    );
  }
  const up = value >= 0;
  return (
    <span
      className={[
        'tnum inline-flex items-center justify-center rounded-md font-semibold text-white',
        size === 'sm' ? 'h-[24px] w-[68px] text-[14.5px]' : 'h-[26px] w-[72px] text-[16px]',
        up ? 'bg-up' : 'bg-down',
        className,
      ].join(' ')}
    >
      {up ? '+' : ''}
      {value.toFixed(2)}%
    </span>
  );
}

/* ============================ 数据来源提示行 ============================ */
/** 列表上方的轻量状态行：左侧条数/状态，右侧数据来源（实时 / 未连接后端） */
export function StatusLine({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-4 text-[11px] text-ink-3">
      <span className="truncate">{left}</span>
      <span className="shrink-0 pl-2">{right}</span>
    </div>
  );
}

/* ============================ 涨跌文字 ============================ */
export function ChangeText({ value, className = '' }: { value: number; className?: string }) {
  const up = value >= 0;
  return (
    <span className={['tnum font-semibold', up ? 'text-up' : 'text-down', className].join(' ')}>
      {up ? '+' : ''}
      {value.toFixed(2)}%
    </span>
  );
}

/* ============================ 「已更新」标签 ============================ */
export function UpdatedTag({ updated = true }: { updated?: boolean }) {
  if (!updated) {
    return (
      <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-[#F1F2F4] px-1.5 py-[1px] text-[10.5px] leading-[15px] text-ink-2">
        待更新
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-primary-tint px-1.5 py-[1px] text-[10.5px] leading-[15px] text-primary">
      已更新
    </span>
  );
}

/* ============================ 可排序表头 ============================ */
type SortHeaderProps = {
  label: string;
  /** 第二行的小字说明（如 实时 / 盘中）；不传则只渲染单行标签，用于紧凑位置 */
  date?: string;
  sortKey: SortKey;
  activeKey: SortKey | null;
  dir: SortDir;
  onToggle: (key: SortKey) => void;
  className?: string;
};

/** 「当日收益 ⇅ / 实时」式表头，点击切换升/降序 */
export function SortHeader({ label, date, sortKey, activeKey, dir, onToggle, className = '' }: SortHeaderProps) {
  const active = activeKey === sortKey;
  const Icon = active ? (dir === 'desc' ? ArrowDown : ArrowUp) : ArrowUpDown;
  return (
    <button
      type="button"
      aria-label={`按${label}排序`}
      aria-pressed={active}
      onClick={() => onToggle(sortKey)}
      className={['flex flex-1 flex-col items-end justify-center gap-0.5 leading-none', className].join(' ')}
    >
      <span className={['flex items-center gap-0.5 text-[12px]', active ? 'text-primary' : 'text-ink-3'].join(' ')}>
        {label}
        <Icon size={11} strokeWidth={2.4} />
      </span>
      {date ? <span className="text-[11px] text-ink-3">{date}</span> : null}
    </button>
  );
}

/* ============================ 卡片容器 ============================ */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={['rounded-[10px] bg-white shadow-card', className].join(' ')}>{children}</div>
  );
}

/* ============================ 空态 ============================ */
export function EmptyState({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon ? <div className="text-ink-3">{icon}</div> : null}
      <p className="text-[14px] text-ink-2">{title}</p>
      {desc ? <p className="text-[12px] text-ink-3">{desc}</p> : null}
      {action}
    </div>
  );
}

/* ============================ 展开/收起按钮 ============================ */
export function CollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mx-auto flex flex-col items-center gap-0.5 py-1 text-primary active:opacity-60"
    >
      <Icon size={16} strokeWidth={2.4} />
      <span className="text-[14px] font-medium">{collapsed ? '展开' : '收起'}</span>
    </button>
  );
}
