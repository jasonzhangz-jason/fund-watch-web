import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Search as SearchIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PhoneFrame } from '../components/chrome';
import { useStore } from '../state/store';
import { useAuth } from '../state/auth';

type Item = { code: string; name: string };

/** 搜索页（对应截图 搜索-1 空态 / 搜索-2 结果列表）
 *  数据来源：优先调用后端 /api/search（真实天天基金数据）；
 *  后端未启动 / 请求失败时显示空态提示（「未连接后端，无法搜索」），不使用任何静态数据。 */
export default function Search() {
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { isFavorite, toggleFavorite } = useStore();
  const { user, openSheet } = useAuth();

  // 输入防抖 + 请求后端真实搜索接口
  useEffect(() => {
    const kw = q.trim();
    if (!kw) {
      setRemote(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?key=${encodeURIComponent(kw)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items?: Item[] };
        const items = Array.isArray(data.items) ? data.items.map((i) => ({ code: i.code, name: i.name })) : [];
        if (alive) setRemote(items.length ? items : null); // 空结果也回落本地，避免空白页
      } catch {
        if (alive) setRemote(null); // 后端不可用 → 回落本地数据
      } finally {
        if (alive) setLoading(false);
      }
    }, 220);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  /** 只使用后端真实搜索结果，不再回落静态列表 */
  const results = useMemo<Item[]>(() => {
    const kw = q.trim();
    if (!kw) return [];
    return remote ?? [];
  }, [q, remote]);

  const usingLiveData = remote !== null;
  const failed = q.trim() !== '' && remote === null && !loading;

  return (
    <PhoneFrame>

      {/* 搜索行 */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line-2 bg-white px-2">
        <button
          type="button"
          aria-label="返回"
          onClick={() => navigate(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full active:bg-black/5"
        >
          <ChevronLeft size={24} strokeWidth={2.2} />
        </button>
        <div className="flex h-9 flex-1 items-center gap-2 rounded-full bg-field px-3">
          <SearchIcon size={16} className="shrink-0 text-ink-2" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索一下"
            aria-label="搜索基金"
            className="h-full w-full bg-transparent text-[15px] text-ink placeholder:text-ink-2"
          />
          {q ? (
            <button type="button" aria-label="清空" onClick={() => setQ('')} className="text-ink-3">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {/* 结果 / 空态 */}
      <div className="no-scrollbar flex-1 overflow-y-auto bg-white">
        {q.trim() === '' ? null : results.length === 0 ? (
          <p className="py-16 text-center text-[14px] text-ink-2">
            {loading ? '搜索中…' : failed ? '未连接后端，无法搜索' : `没有找到「${q}」相关的基金`}
          </p>
        ) : (
          <ul>
            {/* 数据来源提示：结果全部来自后端 /api/search */}
            <li className="flex h-7 items-center justify-between px-4 text-[11px] text-ink-3">
              <span>{loading ? '搜索中…' : `共 ${results.length} 条`}</span>
              <span>{usingLiveData ? '实时数据 · 天天基金' : '未连接后端'}</span>
            </li>
            {results.map((r, i) => {
              const fav = isFavorite(r.code);
              return (
                <li key={r.code}>
                  <div className="flex h-[58px] items-center px-4">
                    <button
                      type="button"
                      onClick={() => navigate(`/fund/${r.code}`)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-[15.5px] font-medium text-ink">{r.name}</p>
                      <p className="tnum mt-0.5 text-[12.5px] text-ink-2">{r.code}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // 未登录：自选属于账号数据，先引导登录，不做内存级「已自选」
                        if (!user) {
                          openSheet();
                          return;
                        }
                        void toggleFavorite(r.code, r.name);
                      }}
                      className={[
                        'ml-3 h-[30px] shrink-0 rounded-full px-3 text-[13px] font-medium transition-colors',
                        fav
                          ? 'border border-line bg-field text-ink-2'
                          : 'bg-primary text-white active:opacity-90',
                      ].join(' ')}
                    >
                      {fav ? '已自选' : '＋自选'}
                    </button>
                  </div>
                  {i < results.length - 1 ? <div className="ml-4 border-b border-line" /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </PhoneFrame>
  );
}
