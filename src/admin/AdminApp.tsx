import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogIn, LogOut, RefreshCw, Search, Shield, ShieldAlert } from 'lucide-react';
import { api, ApiError, type AdminStats, type AdminUser, type User } from '../lib/api';

/**
 * 后台管理页（独立入口 /admin.html，前台「我的」页的管理员按钮以新标签页打开）
 *   - 未登录：内联登录表单（同一套 /api/auth/* 与会话 Cookie）
 *   - 已登录但非管理员：提示权限不足，可切换账号
 *   - 管理员：系统运营数据 + 用户列表（60s 自动刷新）
 *   - 自适应：手机用卡片式列表、PC 用表格；顶栏在窄屏换行不溢出
 */
export default function AdminApp() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  /* ---------------- 登录表单 ---------------- */
  const [form, setForm] = useState({ username: '', password: '' });
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');

  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    setLoading(true);
    try {
      const [s, u] = await Promise.all([api.adminStats(), api.adminUsers({ q, size: 100 })]);
      setStats(s.stats);
      setUsers(u.items);
      setTotal(u.total);
      setUpdatedAt(new Date());
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [user, q]);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 60s 自动刷新（页面不可见时跳过）
  useEffect(() => {
    if (!isAdmin) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [isAdmin, load]);

  const submitLogin = async () => {
    if (loginBusy || !form.username.trim() || !form.password) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const { user: u } = await api.login(form.username.trim(), form.password);
      setUser(u);
      setForm({ username: '', password: '' });
    } catch (e) {
      setLoginError(e instanceof ApiError ? e.message : '登录失败');
    } finally {
      setLoginBusy(false);
    }
  };

  const cards = useMemo(() => {
    if (!stats) return [];
    return [
      { group: '账号', label: '注册用户', value: stats.users, hint: '含管理员' },
      { group: '账号', label: '管理员', value: stats.admins, hint: 'role = admin' },
      { group: '账号', label: '活跃会话', value: stats.activeSessions, hint: '未过期会话数' },
      { group: '自选', label: '自选条数', value: stats.watchlistItems, hint: 'watchlist 表' },
      { group: '自选', label: '有自选用户', value: stats.usersWithWatchlist, hint: '去重用户数' },
      { group: '账本', label: '持仓条数', value: stats.positionsItems, hint: 'positions 表' },
      { group: '账本', label: '有持仓用户', value: stats.usersWithPositions, hint: '去重用户数' },
      { group: '数据', label: '行情缓存', value: stats.quotesCached, hint: 'fund_quotes 条数' },
      { group: '数据', label: '快照天数', value: stats.snapshotDays, hint: `最新 ${stats.latestSnapshot || '—'}` },
      { group: '数据', label: '每日明细行', value: stats.positionDailyRows, hint: 'position_daily 行数' },
    ];
  }, [stats]);

  const fmtTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const roleChip = (role: string) => (
    <span
      className={[
        'shrink-0 rounded px-1.5 py-[1px] text-[11px]',
        role === 'admin' ? 'bg-primary-tint text-primary' : 'bg-field text-ink-2',
      ].join(' ')}
    >
      {role === 'admin' ? '管理员' : '普通用户'}
    </span>
  );

  return (
    <div className="min-h-screen bg-page">
      {/* 顶栏：窄屏换行，不横向溢出 */}
      <header className="border-b border-line-2 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:min-h-14 sm:flex-nowrap sm:px-5 sm:py-0">
          <div className="flex min-w-0 items-center gap-2">
            <Shield size={18} className="shrink-0 text-primary" />
            <h1 className="truncate text-[15px] font-semibold text-ink sm:text-[16px]">基金助手 · 后台管理</h1>
            <span className="hidden shrink-0 rounded bg-primary-tint px-1.5 py-[1px] text-[11px] text-primary sm:inline">运营数据</span>
          </div>
          <div className="ml-auto flex items-center gap-2 text-[12.5px] text-ink-2 sm:gap-3 sm:text-[13px]">
            {user ? (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-white">
                    {user.username.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-[92px] truncate sm:max-w-none">{user.username}</span>
                  <span className="hidden sm:inline">{roleChip(user.role)}</span>
                </span>
                <button
                  type="button"
                  aria-label="退出登录"
                  onClick={() => void api.logout().then(() => setUser(null))}
                  className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 hover:bg-field sm:px-3"
                >
                  <LogOut size={14} />
                  <span className="hidden sm:inline">退出</span>
                </button>
              </>
            ) : null}
            <a href="/" className="shrink-0 rounded-full px-2.5 py-1.5 text-primary hover:bg-primary-tint sm:px-3">
              返回前台
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-5 sm:px-5 sm:py-6">
        {/* 未登录：内联登录 */}
        {ready && !user ? (
          <div className="mx-auto mt-6 w-full max-w-sm rounded-card bg-white p-5 shadow-card sm:mt-10 sm:p-6">
            <div className="flex items-center gap-2">
              <LogIn size={16} className="text-primary" />
              <h2 className="text-[15px] font-semibold text-ink">管理员登录</h2>
            </div>
            <p className="mt-1 text-[12px] text-ink-2">使用系统管理员账号登录后可查看运营数据</p>
            <label className="mt-4 flex h-11 items-center gap-3 rounded-card bg-field px-3">
              <span className="w-[52px] shrink-0 text-[13px] text-ink-2">用户名</span>
              <input
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                aria-label="管理员用户名"
                className="h-full w-full bg-transparent text-[14px] text-ink outline-none"
              />
            </label>
            <label className="mt-2.5 flex h-11 items-center gap-3 rounded-card bg-field px-3">
              <span className="w-[52px] shrink-0 text-[13px] text-ink-2">密码</span>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && void submitLogin()}
                aria-label="管理员密码"
                className="h-full w-full bg-transparent text-[14px] text-ink outline-none"
              />
            </label>
            {loginError ? <p className="mt-2 text-[12.5px] text-up">{loginError}</p> : null}
            <button
              type="button"
              disabled={loginBusy || !form.username.trim() || !form.password}
              onClick={() => void submitLogin()}
              className={[
                'mt-4 h-11 w-full rounded-full text-[15px] font-semibold',
                loginBusy || !form.username.trim() || !form.password
                  ? 'bg-primary-soft text-white/70'
                  : 'bg-primary text-white hover:opacity-90',
              ].join(' ')}
            >
              {loginBusy ? '登录中…' : '登录'}
            </button>
          </div>
        ) : null}

        {/* 已登录但非管理员 */}
        {ready && user && !isAdmin ? (
          <div className="mx-auto mt-6 w-full max-w-sm rounded-card bg-white p-5 text-center shadow-card sm:mt-10 sm:p-6">
            <ShieldAlert size={28} className="mx-auto text-up" />
            <h2 className="mt-3 text-[15px] font-semibold text-ink">需要管理员权限</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              当前账号「{user.username}」是普通用户，无法查看运营数据。请用管理员账号登录。
            </p>
            <button
              type="button"
              onClick={() => void api.logout().then(() => setUser(null))}
              className="mt-4 h-11 w-full rounded-full bg-primary text-[15px] font-semibold text-white hover:opacity-90"
            >
              切换账号
            </button>
          </div>
        ) : null}

        {/* 管理员：运营数据 */}
        {isAdmin ? (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <h2 className="text-[15px] font-semibold text-ink">系统运营数据</h2>
              {updatedAt ? (
                <span className="text-[12px] text-ink-3">· {updatedAt.toTimeString().slice(0, 5)} 更新 · 60s 自动刷新</span>
              ) : null}
              <button
                type="button"
                onClick={() => void load()}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-[13px] text-ink-2 shadow-card hover:bg-field"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                刷新
              </button>
            </div>
            {error ? <p className="mt-2 text-[13px] text-up">{error}</p> : null}

            {/* 指标卡：手机 2 列 / 平板 3 列 / PC 5 列 */}
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5">
              {cards.map((c) => (
                <div key={`${c.group}-${c.label}`} className="rounded-card bg-white p-3 shadow-card sm:p-3.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-[12px] text-ink-2">{c.label}</span>
                    <span className="shrink-0 rounded bg-field px-1.5 py-[1px] text-[10.5px] text-ink-3">{c.group}</span>
                  </div>
                  <p className="tnum mt-1.5 text-[22px] font-bold leading-none text-ink sm:text-[24px]">{c.value}</p>
                  <p className="mt-1 truncate text-[11px] text-ink-3">{c.hint}</p>
                </div>
              ))}
            </div>

            {/* 用户列表 */}
            <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-[15px] font-semibold text-ink">用户列表</h2>
              <span className="text-[12px] text-ink-3">共 {total} 人</span>
              <div className="ml-auto flex h-9 w-full items-center gap-2 rounded-full bg-white px-3 shadow-card sm:w-[240px]">
                <Search size={14} className="shrink-0 text-ink-3" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="按用户名搜索"
                  aria-label="搜索用户"
                  className="h-full w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
                />
              </div>
            </div>

            {/* 手机：卡片式列表 */}
            <ul data-testid="admin-user-cards" className="mt-3 divide-y divide-line overflow-hidden rounded-card bg-white shadow-card md:hidden">
              {users.length === 0 ? (
                <li className="px-4 py-8 text-center text-[13px] text-ink-3">{loading ? '加载中…' : '暂无用户'}</li>
              ) : (
                users.map((u) => (
                  <li key={u.id} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-[14px] font-medium text-ink">{u.username}</span>
                      {roleChip(u.role)}
                      <span className="tnum ml-auto shrink-0 text-[11.5px] text-ink-3">#{u.id}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-4 text-[12px] text-ink-2">
                      <span>
                        自选 <b className="tnum text-ink">{u.fundCount}</b>
                      </span>
                      <span>
                        活跃会话 <b className="tnum text-ink">{u.activeSessions}</b>
                      </span>
                      <span className="tnum ml-auto shrink-0 text-[11.5px] text-ink-3">{fmtTime(u.createdAt)}</span>
                    </div>
                  </li>
                ))
              )}
            </ul>

            {/* PC / 平板：表格（容器可横向滚动，避免被裁切） */}
            <div data-testid="admin-user-table" className="mt-3 hidden overflow-hidden rounded-card bg-white shadow-card md:block">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead className="bg-field text-[12px] text-ink-2">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">ID</th>
                      <th className="px-4 py-2.5 font-medium">用户名</th>
                      <th className="px-4 py-2.5 font-medium">角色</th>
                      <th className="px-4 py-2.5 text-right font-medium">自选数</th>
                      <th className="px-4 py-2.5 text-right font-medium">活跃会话</th>
                      <th className="px-4 py-2.5 font-medium">注册时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-ink-3">
                          {loading ? '加载中…' : '暂无用户'}
                        </td>
                      </tr>
                    ) : (
                      users.map((u, i) => (
                        <tr key={u.id} className={i % 2 ? 'bg-[#FCFCFD]' : ''}>
                          <td className="tnum px-4 py-2.5 text-ink-2">{u.id}</td>
                          <td className="px-4 py-2.5 font-medium text-ink">{u.username}</td>
                          <td className="px-4 py-2.5">{roleChip(u.role)}</td>
                          <td className="tnum px-4 py-2.5 text-right text-ink">{u.fundCount}</td>
                          <td className="tnum px-4 py-2.5 text-right text-ink">{u.activeSessions}</td>
                          <td className="tnum px-4 py-2.5 text-ink-2">{fmtTime(u.createdAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-3 text-[11.5px] leading-relaxed text-ink-3">
              数据来源：GET /api/admin/stats、GET /api/admin/users（均按会话中的 role 鉴权）
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
