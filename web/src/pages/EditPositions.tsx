import { useState } from 'react';
import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NavBar, PhoneFrame } from '../components/chrome';
import { CollapseToggle } from '../components/ui';
import { useStore, type Fund } from '../state/store';

/** 修改持仓（对应截图 账本-修改持仓-1 折叠列表 / 账本-修改持仓-2 行内展开编辑） */
export default function EditPositions() {
  const { funds, updateFund, removeFunds } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const navigate = useNavigate();

  return (
    <PhoneFrame>
      <NavBar title="修改持仓" />

      <div className="no-scrollbar flex-1 overflow-y-auto bg-page px-3 pt-3 pb-4">
        <ul className="flex flex-col gap-2.5">
          {funds.map((f) =>
            expanded === f.code ? (
              <li key={f.code}>
                <ExpandEditor
                  fund={f}
                  onChange={(patch) => updateFund(f.code, patch)}
                  onClose={() => setExpanded(null)}
                />
              </li>
            ) : (
              <li key={f.code}>
                <CollapsedCard
                  fund={f}
                  onOpen={() => setExpanded(f.code)}
                  onDelete={() => {
                    if (confirm(`确认删除「${f.name}」？`)) removeFunds([f.code]);
                  }}
                />
              </li>
            ),
          )}
        </ul>
      </div>

      <div className="shrink-0 bg-page px-4 pb-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="h-12 w-full rounded-full bg-primary text-[16px] font-semibold text-white active:opacity-90"
        >
          完成
        </button>
      </div>
    </PhoneFrame>
  );
}

/** 折叠态：两行三列（代码/持有金额/持有收益 + ✕，名称/金额/收益）
 *  注：金额列较窄且不使用千分位，超出以省略号截断——与参考截图一致（如 66209…） */
function CollapsedCard({ fund, onOpen, onDelete }: { fund: Fund; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="relative rounded-card bg-white shadow-card">
      <button type="button" onClick={onOpen} className="w-full px-3.5 py-3 text-left active:bg-field">
        <div className="flex items-center text-[12px] text-ink-3">
          <span className="tnum flex-1">{fund.code}</span>
          <span className="w-[68px] text-right">持有金额</span>
          <span className="w-[80px] text-right">持有收益</span>
          <span className="w-6" />
        </div>
        <div className="mt-1 flex items-center">
          <span className="min-w-0 flex-1 truncate text-[15.5px] font-medium text-ink">{fund.name}</span>
          <span className="tnum w-[68px] overflow-hidden text-right text-[16px] font-bold text-ellipsis whitespace-nowrap text-ink">
            {fund.amount.toFixed(2)}
          </span>
          <span
            className={[
              'tnum w-[80px] overflow-hidden text-right text-[16px] font-bold text-ellipsis whitespace-nowrap',
              fund.profit >= 0 ? 'text-up' : 'text-down',
            ].join(' ')}
          >
            {fund.profit.toFixed(2)}
          </span>
          <span className="w-6" />
        </div>
      </button>
      <button
        type="button"
        aria-label={`删除 ${fund.name}`}
        onClick={onDelete}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-[#C8CDD6] active:bg-field"
      >
        <X size={15} />
      </button>
    </div>
  );
}

/** 展开态：三行浅灰字段 + ✕ + 「⌃ 收起」 */
function ExpandEditor({
  fund,
  onChange,
  onClose,
}: {
  fund: Fund;
  onChange: (patch: Partial<Fund>) => void;
  onClose: () => void;
}) {
  return (
    <div className="relative rounded-card bg-white px-3.5 py-3.5 shadow-expand">
      <button
        type="button"
        aria-label="关闭编辑"
        onClick={onClose}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-[#C8CDD6] active:bg-field"
      >
        <X size={15} />
      </button>

      <div className="flex flex-col gap-2.5">
        <EditRow label="基金名称">
          <span className="truncate text-[15px] text-ink">{fund.name}</span>
        </EditRow>
        <EditRow label="持有金额">
          <input
            defaultValue={fund.amount}
            inputMode="decimal"
            aria-label="持有金额"
            onChange={(e) => onChange({ amount: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })}
            className="tnum w-full text-[15px] text-ink"
          />
        </EditRow>
        <EditRow label="持有收益">
          <input
            defaultValue={fund.profit}
            inputMode="decimal"
            aria-label="持有收益"
            onChange={(e) => onChange({ profit: Number(e.target.value.replace(/[^\d.-]/g, '')) || 0 })}
            className={['tnum w-full text-[15px]', fund.profit >= 0 ? 'text-up' : 'text-down'].join(' ')}
          />
        </EditRow>
      </div>

      <div className="mt-1">
        <CollapseToggle collapsed={false} onToggle={onClose} />
      </div>
    </div>
  );
}

function EditRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-[42px] items-center gap-4 rounded-md bg-field px-3">
      <span className="w-[68px] shrink-0 text-[15px] font-medium text-ink">{label}</span>
      {children}
    </div>
  );
}
