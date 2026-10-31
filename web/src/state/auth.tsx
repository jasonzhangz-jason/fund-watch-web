import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, isOffline, type User } from '../lib/api';

type AuthStore = {
  user: User | null;
  /** 首次 /api/auth/me 是否完成 */
  ready: boolean;
  /** 后端是否可达（不可达时页面显示空态与提示，不使用任何静态数据） */
  online: boolean;
  /** 登录/注册弹层开关（由标题栏账号按钮触发，弹层在 PhoneFrame 内渲染） */
  sheetOpen: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  login: (username: string, password: string) => Promise<User>;
  register: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthStore | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api.me();
      setUser(me);
      setOnline(true);
    } catch (e) {
      setUser(null);
      if (isOffline(e)) setOnline(false);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const { user: u } = await api.login(username, password);
    setUser(u);
    setOnline(true);
    return u;
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const { user: u } = await api.register(username, password);
    setUser(u);
    setOnline(true);
    return u;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthStore>(
    () => ({
      user,
      ready,
      online,
      sheetOpen,
      openSheet: () => setSheetOpen(true),
      closeSheet: () => setSheetOpen(false),
      login,
      register,
      logout,
    }),
    [user, ready, online, sheetOpen, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthStore {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
