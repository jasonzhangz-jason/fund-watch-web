import { useEffect, useRef } from 'react';
import { FolderSync, Pencil, Plus, Search, Settings } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export type MenuAnchor = 'ledger' | 'watchlist';

/**
 * 账本操作菜单（对应截图「主页-2」）
 * 锚定在列表头左侧图标正下方，无全屏遮罩，点击外部/Esc 收起。
 */
export function ActionMenu({
  anchor,
  onClose,
}: {
  anchor: MenuAnchor;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items =
    anchor === 'ledger'
      ? [
          { label: '搜索基金', icon: <Search size={18} />, run: () => navigate('/search') },
          { label: '同步持仓', icon: <FolderSync size={18} />, run: () => navigate('/add') },
          { label: '添加持仓', icon: <Plus size={18} />, run: () => navigate('/add') },
          { label: '修改持仓', icon: <Pencil size={18} />, run: () => navigate('/edit') },
          { label: '账本设置', icon: <Settings size={18} />, run: () => navigate('/settings') },
        ]
      : [
          { label: '搜索基金', icon: <Search size={18} />, run: () => navigate('/search') },
          { label: '修改持仓', icon: <Pencil size={18} />, run: () => navigate('/edit') },
          { label: '账本设置', icon: <Settings size={18} />, run: () => navigate('/settings') },
        ];

  return (
    <div
      ref={ref}
      role="menu"
      className="anim-pop absolute left-3 top-[calc(100%+6px)] z-30 w-[132px] rounded-[10px] bg-white py-1.5 shadow-pop"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            it.run();
          }}
          className="flex h-[43px] w-full items-center gap-2 px-3.5 text-left text-[15px] text-ink active:bg-field"
        >
          <span className="text-[#3A3F47]">{it.icon}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
