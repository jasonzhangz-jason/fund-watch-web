import { useState } from 'react';
import { LogOut, User as UserIcon, WifiOff, X } from 'lucide-react';
import { useAuth } from '../state/auth';
import { ApiError } from '../lib/api';

type Mode = 'login' | 'register';

/**
 * 账号弹层：登录 / 注册 / 退出登录
 * 自选与持仓保存在账号（SQLite）；未登录时各页面只显示空态与登录引导，不展示任何静态数据。
 */
export function AuthSheet() {
  const { user, sheetOpen, closeSheet, login, register, logout, online } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!sheetOpen) return null;

  const submit = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(username.trim(), password);
      else await register(username.trim(), password);
      setUsername('');
      setPassword('');
      closeSheet();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="anim-fade absolute inset-0 z-50 flex items-end bg-mask"
      onClick={(e) => e.target === e.currentTarget && closeSheet()}
    >
      {/* 阻止冒泡：弹层内部的点击绝不触发遮罩的关闭逻辑 */}
      <div
        className="anim-sheet w-full rounded-t-2xl bg-white pb-[max(16px,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 items-center justify-between px-4">
          <span className="text-[16px] font-semibold text-ink">{user ? '账号' : mode === 'login' ? '登录' : '注册'}</span>
          <button type="button" aria-label="关闭" onClick={closeSheet} className="flex h-8 w-8 items-center justify-center text-ink-2">
            <X size={18} />
          </button>
        </div>

        {user ? (
          /* ---------- 已登录 ---------- */
          <div className="px-4">
            <div className="flex items-center gap-3 rounded-card bg-field px-4 py-3.5">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-tint text-primary">
                <UserIcon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-semibold text-ink">{user.username}</p>
                <p className="text-[12px] text-ink-2">
                  {user.role === 'admin' ? '管理员' : '普通用户'} · 自选与持仓已同步到账号
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void logout().then(closeSheet)}
              className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-full border border-line-2 text-[16px] font-medium text-down active:bg-field"
            >
              <LogOut size={18} />
              退出登录
            </button>
            <p className="mt-3 text-center text-[12px] leading-relaxed text-ink-3">
              退出后自选列表将不再显示（数据仍保存在账号中，重新登录即可恢复）
            </p>
          </div>
        ) : (
          /* ---------- 未登录 ---------- */
          <div className="px-4">
            <div className="mb-3 flex rounded-full bg-field p-1">
              {(['login', 'register'] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  aria-label={m === 'login' ? '切换到登录' : '切换到注册'}
                  onClick={() => {
                    setMode(m);
                    setError('');
                  }}
                  className={[
                    'h-8 flex-1 rounded-full text-[14px] font-medium transition-colors',
                    mode === m ? 'bg-white text-primary shadow-card' : 'text-ink-2',
                  ].join(' ')}
                >
                  {m === 'login' ? '登录' : '注册'}
                </button>
              ))}
            </div>

            <label className="flex h-12 items-center gap-3 rounded-card bg-field px-4">
              <span className="w-[52px] shrink-0 text-[15px] text-ink-2">用户名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3-20 位，字母/数字/中文"
                aria-label="用户名"
                autoComplete="username"
                className="h-full w-full bg-transparent text-[15px] text-ink placeholder:text-ink-3"
              />
            </label>

            <label className="mt-2.5 flex h-12 items-center gap-3 rounded-card bg-field px-4">
              <span className="w-[52px] shrink-0 text-[15px] text-ink-2">密码</span>
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                type="password"
                placeholder="至少 6 位"
                aria-label="密码"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="h-full w-full bg-transparent text-[15px] text-ink placeholder:text-ink-3"
              />
            </label>

            {error ? <p className="mt-2.5 text-[13px] text-up">{error}</p> : null}
            {!online ? (
              <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-ink-2">
                <WifiOff size={13} />
                未检测到后端服务：请用 <code className="rounded bg-field px-1">pnpm start</code> 同时启动前后端
              </p>
            ) : null}

            <button
              type="button"
              disabled={busy || !username.trim() || !password}
              onClick={() => void submit()}
              className={[
                'mt-3 h-12 w-full rounded-full text-[16px] font-semibold transition-colors',
                busy || !username.trim() || !password ? 'bg-primary-soft text-white/70' : 'bg-primary text-white active:opacity-90',
              ].join(' ')}
            >
              {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
            </button>

            <p className="mt-3 text-center text-[12px] leading-relaxed text-ink-3">
              登录后「自选基金」将保存到你的账号（SQLite），换设备也能看到
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
