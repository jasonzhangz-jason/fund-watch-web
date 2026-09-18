import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, KeyRound, RefreshCw, Trash2, X } from 'lucide-react';
import { api, ApiError, type AdminUser } from '../lib/api';

export type ActionMode = 'reset' | 'delete';

/** 生成一个便于转达的随机密码（数字+大小写字母，12 位） */
function randomPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

/**
 * 用户操作弹层：重置登录密码 / 级联删除用户（仅管理员）
 *   - 重置：两次输入校验 + 随机生成；成功后展示新密码便于转达
 *   - 删除：列出将被级联清理的数据，并要求输入用户名二次确认
 *   - 手机与 PC 均自适应（居中卡片，窄屏留边距）
 */
export function UserActionModal({
  mode,
  user,
  onClose,
  onDone,
}: {
  mode: ActionMode;
  user: AdminUser;
  onClose: () => void;
  /** 操作成功回调：keepOpen=true 时保持弹层（重置密码需展示新密码供转达） */
  onDone: (message: string, opts?: { keepOpen?: boolean }) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [donePassword, setDonePassword] = useState('');

  const resetValid = useMemo(() => {
    if (password.length < 6 || password.length > 72) return false;
    return password === confirm;
  }, [password, confirm]);

  const deleteValid = confirmName.trim() === user.username;

  const doReset = async () => {
    if (busy || !resetValid) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.adminResetPassword(user.id, password);
      setDonePassword(password);
      // 保持弹层打开：管理员需要看到/复制刚设置的新密码
      onDone(`已重置「${r.username}」的登录密码，其既有会话已全部失效`, { keepOpen: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '重置失败');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (busy || !deleteValid) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.adminDeleteUser(user.id);
      onDone(`已删除用户「${r.username}」，其自选 / 持仓 / 会话 / 快照已级联清理`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const isReset = mode === 'reset';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask px-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="anim-sheet w-full max-w-sm rounded-card bg-white p-5 shadow-modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <span
            className={[
              'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
              isReset ? 'bg-primary-tint text-primary' : 'bg-[#FFF1F1] text-up',
            ].join(' ')}
          >
            {isReset ? <KeyRound size={16} /> : <Trash2 size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-ink">{isReset ? '重置登录密码' : '删除用户'}</h3>
            <p className="mt-0.5 truncate text-[12.5px] text-ink-2">
              {user.username} · #{user.id} · {user.role === 'admin' ? '管理员' : '普通用户'}
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-field"
          >
            <X size={15} />
          </button>
        </div>

        {isReset ? (
          <>
            <label className="mt-4 flex h-11 items-center gap-3 rounded-card bg-field px-3">
              <span className="w-[62px] shrink-0 text-[13px] text-ink-2">新密码</span>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value.slice(0, 72))}
                placeholder="6-72 位"
                aria-label="新密码"
                className="h-full w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              />
              <button
                type="button"
                aria-label="生成随机密码"
                onClick={() => {
                  const p = randomPassword();
                  setPassword(p);
                  setConfirm(p);
                }}
                className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2 py-1 text-[11.5px] text-primary hover:bg-primary-tint"
              >
                <RefreshCw size={11} />
                随机
              </button>
            </label>
            <label className="mt-2.5 flex h-11 items-center gap-3 rounded-card bg-field px-3">
              <span className="w-[62px] shrink-0 text-[13px] text-ink-2">确认密码</span>
              <input
                type="text"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value.slice(0, 72))}
                onKeyDown={(e) => e.key === 'Enter' && void doReset()}
                placeholder="再次输入"
                aria-label="确认密码"
                className="h-full w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              />
            </label>
            {password && confirm && password !== confirm ? (
              <p className="mt-2 text-[12.5px] text-up">两次输入的密码不一致</p>
            ) : null}

            {donePassword ? (
              <div className="mt-3 rounded-card bg-primary-tint px-3 py-2.5">
                <p className="text-[12px] text-ink-2">新密码（请转达给用户并提示尽快修改）</p>
                <div className="mt-1 flex items-center gap-2">
                  <code data-testid="new-password" className="tnum flex-1 break-all text-[14px] font-semibold text-primary">
                    {donePassword}
                  </code>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(donePassword)}
                    className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11.5px] text-primary"
                  >
                    <Copy size={11} />
                    复制
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="mt-4 rounded-card bg-[#FFF7F7] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-up">
                <AlertTriangle size={13} />
                该操作不可恢复，将级联删除：
              </p>
              <ul className="mt-1.5 space-y-0.5 text-[12px] text-ink-2">
                <li>· 登录会话（立即退出登录）</li>
                <li>· 自选基金 {user.fundCount} 条</li>
                <li>· 持仓（账本）与该用户的每日快照</li>
              </ul>
            </div>
            <label className="mt-3 flex h-11 items-center gap-3 rounded-card bg-field px-3">
              <span className="shrink-0 text-[13px] text-ink-2">输入用户名确认</span>
              <input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doDelete()}
                placeholder={user.username}
                aria-label="输入用户名确认删除"
                className="h-full w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              />
            </label>
          </>
        )}

        {error ? <p className="mt-2.5 text-[12.5px] text-up">{error}</p> : null}

        <div className="mt-4 flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-11 flex-1 rounded-full bg-field text-[14.5px] font-medium text-ink-2 hover:bg-line"
          >
            {donePassword ? '关闭' : '取消'}
          </button>
          {!donePassword ? (
            <button
              type="button"
              aria-label={isReset ? '确认重置密码' : '确认删除用户'}
              disabled={busy || (isReset ? !resetValid : !deleteValid)}
              onClick={() => void (isReset ? doReset() : doDelete())}
              className={[
                'h-11 flex-1 rounded-full text-[14.5px] font-semibold text-white',
                busy || (isReset ? !resetValid : !deleteValid)
                  ? 'bg-primary-soft'
                  : isReset
                    ? 'bg-primary hover:opacity-90'
                    : 'bg-up hover:opacity-90',
              ].join(' ')}
            >
              {busy ? '处理中…' : isReset ? '确认重置' : '确认删除'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
