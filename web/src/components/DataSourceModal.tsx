import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { DATA_SOURCES } from '../data/sources';

/**
 * 估值数据源切换弹窗（对应截图「数据源」）
 * 居中卡片 + 50% 黑遮罩；选项横向排列；底部「取消 | 确定」文字按钮 + 竖分割线。
 * 三个选项都对应后端真实字段（盘中估值 / 最新净值 / 累计净值），切换后会改变详情页展示口径。
 */
export function DataSourceModal({
  value,
  onCancel,
  onConfirm,
}: {
  value: string;
  onCancel: () => void;
  onConfirm: (next: string) => void;
}) {
  const [picked, setPicked] = useState(value);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="anim-fade absolute inset-0 z-40 flex items-center justify-center bg-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="anim-sheet w-[286px] overflow-hidden rounded-sheet bg-white shadow-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="pb-3.5 pt-2.5 text-center text-[17px] font-semibold text-ink">切换数据源</h2>

        <div className="flex items-center justify-between gap-2 px-4 pb-4">
          {DATA_SOURCES.map((s) => {
            const active = picked === s.key;
            return (
              <button
                key={s.key}
                type="button"
                title={s.hint}
                onClick={() => setPicked(s.key)}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[15px]"
              >
                <span
                  className={[
                    'flex h-[18px] w-[18px] items-center justify-center rounded-full border transition-colors',
                    active ? 'border-primary bg-primary' : 'border-[#C8CDD6] bg-white',
                  ].join(' ')}
                >
                  {active ? <Check size={12} strokeWidth={3.4} className="text-white" /> : null}
                </span>
                <span className={active ? 'text-ink' : 'text-ink-2'}>{s.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex h-12 divide-x divide-line-2 border-t border-line-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 text-[16px] text-ink-2 active:bg-field"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(picked)}
            className="flex-1 text-[16px] font-semibold text-primary active:bg-field"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
