import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, LogIn, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { NavBar, PhoneFrame } from '../components/chrome';
import { Card } from '../components/ui';
import { useStore } from '../state/store';
import { useAuth } from '../state/auth';
import { api, type SearchItem } from '../lib/api';

type Picked = { code: string; name: string } | null;

/** 添加持仓（对应截图 账本-添加持仓）
 *  持仓属于账号数据：未登录时只给出登录引导，不展示任何静态内容；
 *  基金选择器走后端真实搜索 /api/search（无关键词时列出账本已有基金）。 */
export default function AddPosition() {
  const navigate = useNavigate();
  const { user, openSheet } = useAuth();
  const { funds, addFund, positionsState } = useStore();
  const [picked, setPicked] = useState<Picked>(null);
  const [amount, setAmount] = useState('');
  const [profit, setProfit] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  // 选择器内的真实搜索
  const [keyword, setKeyword] = useState('');
  const [remote, setRemote] = useState<SearchItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!pickerOpen) return;
    const kw = keyword.trim();
    if (!kw) {
      setRemote(null);
      return;
    }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const { items } = await api.search(kw);
        if (alive) setRemote(items);
      } catch {
        if (alive) setRemote(null); // 后端不可用 → 不展示任何回落数据
      } finally {
        if (alive) setSearching(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [keyword, pickerOpen]);

  /** 无关键词 → 账本已有基金；有关键词 → 后端真实搜索结果（不再回落静态列表） */
  const options = useMemo<{ code: string; name: string }[]>(() => {
    const kw = keyword.trim();
    if (!kw) return funds.map((f) => ({ code: f.code, name: f.name }));
    return remote ? remote.map((r) => ({ code: r.code, name: r.name })) : [];
  }, [keyword, remote, funds]);

  const valid = Boolean(picked) && Number(amount) > 0 && profit.trim() !== '' && !Number.isNaN(Number(profit));

  const submit = () => {
    if (!valid || !picked) return;
    addFund({ code: picked.code, name: picked.name, amount: Number(amount), profit: Number(profit) });
    navigate(-1);
  };

  /* 未登录：持仓属于账号数据，这里只给登录引导，不展示任何静态内容 */
  if (!user) {
    return (
      <PhoneFrame>
        <NavBar title="添加持仓" />
        <div className="flex flex-1 flex-col items-center justify-center bg-page px-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-field text-ink-3">
            <LogIn size={24} />
          </span>
          <p className="mt-3 text-[15px] font-medium text-ink">登录后即可记账</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
            持仓保存在你的账号里（SQLite），换设备也能看到
          </p>
          <button
            type="button"
            onClick={openSheet}
            className="mt-5 h-11 w-full rounded-full bg-primary text-[16px] font-semibold text-white active:opacity-90"
          >
            登录 / 注册
          </button>
        </div>
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame>
      <NavBar title="添加持仓" />

      <div className="no-scrollbar flex-1 overflow-y-auto bg-page px-4 pt-3">
        {positionsState === 'error' ? (
          <p className="mb-2 rounded-md bg-[#FFF6F6] px-3 py-2 text-[12px] text-up">
            后端不可用，持仓无法保存；请用 <code className="rounded bg-white px-1">pnpm start</code> 启动服务后重试。
          </p>
        ) : null}

        <Card className="divide-y divide-line">
          <FieldRow label="基金名称">
            <button
              type="button"
              aria-label="选择基金"
              onClick={() => setPickerOpen(true)}
              className={['flex items-center gap-1 text-[16px]', picked ? 'text-ink' : 'text-[#B9BEC9]'].join(' ')}
            >
              {picked ? <span className="max-w-[190px] truncate">{picked.name}</span> : '请选择基金'}
              <ChevronRight size={16} className="text-ink-3" />
            </button>
          </FieldRow>

          <FieldRow label="持有金额">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              inputMode="decimal"
              placeholder="请输入持有金额"
              aria-label="持有金额"
              className="w-[190px] text-right text-[16px] text-ink placeholder:text-[#B9BEC9]"
            />
          </FieldRow>

          <FieldRow label="持有收益">
            <input
              value={profit}
              onChange={(e) => setProfit(e.target.value.replace(/[^\d.-]/g, ''))}
              inputMode="decimal"
              placeholder="请输入持有收益"
              aria-label="持有收益"
              className="w-[190px] text-right text-[16px] text-ink placeholder:text-[#B9BEC9]"
            />
          </FieldRow>
        </Card>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
          提示：持有收益可填负数（亏损）。三项填写完整后「完成」按钮才会激活；登录状态下会写入账号（`/api/positions`）。
        </p>
      </div>

      {/* 底部通栏按钮：未填写完整时为禁用态 */}
      <div className="shrink-0 bg-page px-4 pb-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          disabled={!valid}
          onClick={submit}
          className={[
            'h-12 w-full rounded-full text-[16px] font-semibold transition-colors',
            valid ? 'bg-primary text-white active:opacity-90' : 'bg-primary-soft text-white/60',
          ].join(' ')}
        >
          完成
        </button>
      </div>

      {pickerOpen ? (
        <div
          className="anim-fade absolute inset-0 z-40 flex items-end bg-mask"
          onClick={(e) => e.target === e.currentTarget && setPickerOpen(false)}
        >
          <div className="anim-sheet flex max-h-[76%] w-full flex-col overflow-hidden rounded-t-2xl bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex h-12 shrink-0 items-center justify-between px-4">
              <span className="text-[16px] font-semibold">选择基金</span>
              <button type="button" onClick={() => setPickerOpen(false)} className="text-[14px] text-ink-2">
                关闭
              </button>
            </div>

            <div className="shrink-0 px-4 pb-2">
              <div className="flex h-9 items-center gap-2 rounded-full bg-field px-3">
                <Search size={15} className="shrink-0 text-ink-2" />
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索基金名称或代码"
                  aria-label="搜索基金"
                  className="h-full w-full bg-transparent text-[14.5px] text-ink placeholder:text-ink-3"
                />
                {searching ? <span className="text-[11px] text-ink-3">搜索中…</span> : null}
              </div>
            </div>

            <ul className="no-scrollbar flex-1 overflow-y-auto">
              {options.length === 0 ? (
                <li className="py-10 text-center text-[13px] text-ink-3">
                  {keyword.trim() ? `没有找到「${keyword}」相关基金` : '账本暂无基金，试试搜索'}
                </li>
              ) : (
                options.map((o, i) => (
                  <li key={o.code}>
                    <button
                      type="button"
                      onClick={() => {
                        setPicked(o);
                        setPickerOpen(false);
                      }}
                      className="flex h-[52px] w-full items-center px-4 text-left active:bg-field"
                    >
                      <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{o.name}</span>
                      <span className="tnum ml-3 text-[12.5px] text-ink-2">{o.code}</span>
                    </button>
                    {i < options.length - 1 ? <div className="ml-4 border-b border-line" /> : null}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </PhoneFrame>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-12 items-center justify-between px-4">
      <span className="text-[16px] font-medium text-ink">{label}</span>
      {children}
    </div>
  );
}
