import type { ReactNode } from 'react';
import { ChevronLeft, FileText, PlusCircle, User as UserIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AuthSheet } from './AuthSheet';

/* ============================ 设备外框 ============================ */
/** 手机外框：桌面端居中显示 393×852 机身；矮视口（横屏手机 / 小窗口）自动退化为全屏铺满，
 *  避免固定机身高度把底部 TabBar 裁掉（样式见 index.css 的 .phone-shell / .phone-frame）。
 *  账号弹层挂在这里，保证它相对手机机身定位（而不是整个浏览器窗口）。 */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="phone-shell flex h-full w-full items-center justify-center">
      <div className="phone-frame relative flex flex-col overflow-hidden bg-page pt-[env(safe-area-inset-top,0px)]">
        {children}
        <AuthSheet />
      </div>
    </div>
  );
}

/* ============================ 页面导航栏 ============================ */
type NavBarProps = {
  title: string;
  /** blue：详情页蓝底白字；white：白底深色字 */
  variant?: 'blue' | 'white';
  right?: ReactNode;
  onBack?: () => void;
};

export function NavBar({ title, variant = 'white', right, onBack }: NavBarProps) {
  const navigate = useNavigate();
  const blue = variant === 'blue';
  return (
    <div
      className={[
        'relative flex h-11 shrink-0 items-center px-2',
        blue ? 'bg-hero-to text-white' : 'border-b border-line-2 bg-white text-ink',
      ].join(' ')}
    >
      <button
        type="button"
        aria-label="返回"
        onClick={() => (onBack ? onBack() : navigate(-1))}
        className="flex h-9 w-9 items-center justify-center rounded-full active:bg-black/5"
      >
        <ChevronLeft size={24} strokeWidth={2.2} />
      </button>
      <h1 className="pointer-events-none absolute left-1/2 max-w-[65%] -translate-x-1/2 truncate text-[17px] font-semibold">
        {title}
      </h1>
      {right ? <div className="ml-auto pr-1">{right}</div> : null}
    </div>
  );
}

/* ============================ 底部 TabBar ============================ */
export function TabBar() {
  const navigate = useNavigate();
  const path = window.location.hash;
  const isWatch = path.includes('/watchlist');
  const isMine = path.includes('/mine');
  return (
    <nav className="shrink-0 border-t border-line-2 bg-white pb-[env(safe-area-inset-bottom,0px)]">
      <div className="flex h-14">
        <TabItem
          label="账本"
          active={!isWatch && !isMine}
          icon={<FileText size={22} strokeWidth={!isWatch && !isMine ? 2.1 : 1.8} />}
          onClick={() => navigate('/')}
        />
        <TabItem
          label="自选"
          active={isWatch}
          icon={<PlusCircle size={22} strokeWidth={isWatch ? 2.1 : 1.8} />}
          onClick={() => navigate('/watchlist')}
        />
        <TabItem
          label="我的"
          active={isMine}
          icon={<UserIcon size={22} strokeWidth={isMine ? 2.1 : 1.8} />}
          onClick={() => navigate('/mine')}
        />
      </div>
    </nav>
  );
}

function TabItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex flex-1 flex-col items-center justify-center gap-0.5 pt-1 transition-colors',
        active ? 'text-primary' : 'text-ink-2',
      ].join(' ')}
    >
      {icon}
      <span className="text-[10.5px] leading-none">{label}</span>
    </button>
  );
}
