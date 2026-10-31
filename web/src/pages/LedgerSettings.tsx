import { useState } from 'react';
import { ArrowUpToLine, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NavBar, PhoneFrame } from '../components/chrome';
import { useStore } from '../state/store';

/** 账本设置：持仓排序与批量删除（对应截图 账本-账本设置） */
export default function LedgerSettings() {
  const { funds, move, removeFunds } = useStore();
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();

  const allSelected = funds.length > 0 && selected.length === funds.length;
  const toggleOne = (code: string) =>
    setSelected((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));

  return (
    <PhoneFrame>
      <NavBar title="账本设置" />

      <div className="no-scrollbar flex-1 overflow-y-auto bg-white">
        {/* 表头 */}
        <div className="flex h-8 items-center px-4 text-[12.5px] text-ink-3">
          <span className="flex-1">基金名称</span>
          <span className="w-11 text-center">置顶</span>
          <span className="w-11 text-center">上移</span>
          <span className="w-11 text-center">下移</span>
        </div>

        {/* 持仓行 */}
        <ul>
          {funds.map((f, i) => {
            const checked = selected.includes(f.code);
            const canUp = i > 0;
            const canTop = i > 0;
            const canDown = i < funds.length - 1;
            return (
              <li key={f.code}>
                <div className="flex h-[52px] items-center px-4">
                  <button
                    type="button"
                    aria-label={`选择 ${f.name}`}
                    onClick={() => toggleOne(f.code)}
                    className={[
                      'mr-2 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors',
                      checked ? 'border-primary bg-primary' : 'border-[#D5D9E0] bg-white',
                    ].join(' ')}
                  >
                    {checked ? <Check size={11} strokeWidth={3.4} className="text-white" /> : null}
                  </button>

                  <div className="min-w-0 flex-1 pr-1">
                    <p className="truncate text-[15.5px] font-medium text-ink">{f.name}</p>
                    <p className="tnum text-[12.5px] text-ink-3">{f.code}</p>
                  </div>

                  <IconAction label="置顶" disabled={!canTop} onClick={() => move(f.code, 'top')}>
                    <ArrowUpToLine size={17} />
                  </IconAction>
                  <IconAction label="上移" disabled={!canUp} onClick={() => move(f.code, 'up')}>
                    <ChevronUp size={17} />
                  </IconAction>
                  <IconAction label="下移" disabled={!canDown} onClick={() => move(f.code, 'down')}>
                    <ChevronDown size={17} />
                  </IconAction>
                </div>
                {i < funds.length - 1 ? <div className="ml-4 border-b border-line" /> : null}
              </li>
            );
          })}
        </ul>
      </div>

      {/* 底部操作区：全选 + 删除（未选中为禁用态） */}
      <div className="flex h-14 shrink-0 items-center justify-between border-t border-line-2 bg-white px-4 pb-[env(safe-area-inset-bottom,0px)]">
        <button
          type="button"
          onClick={() => setSelected(allSelected ? [] : funds.map((f) => f.code))}
          className="flex items-center gap-2 text-[15.5px] text-ink"
        >
          <span
            className={[
              'flex h-[18px] w-[18px] items-center justify-center rounded-full border-[1.5px]',
              allSelected ? 'border-primary bg-primary' : 'border-[#D5D9E0] bg-white',
            ].join(' ')}
          >
            {allSelected ? <Check size={11} strokeWidth={3.4} className="text-white" /> : null}
          </span>
          全选
        </button>

        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => {
            removeFunds(selected);
            setSelected([]);
            navigate('/');
          }}
          className={[
            'h-9 rounded-2xl px-5 text-[15px] font-medium transition-colors',
            selected.length === 0
              ? 'border border-danger-soft-line text-danger-soft-text'
              : 'bg-danger text-white active:opacity-90',
          ].join(' ')}
        >
          删除
        </button>
      </div>
    </PhoneFrame>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'flex w-11 items-center justify-center',
        disabled ? 'text-[#D5D9E0]' : 'text-[#3A3F47] active:opacity-60',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
