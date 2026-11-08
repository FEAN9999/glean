import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, establishBrowserSession, hasSession, logout as apiLogout, onAuthChange, setSession } from './api';
import { connectRealtime, disconnectRealtime } from './realtime';

export interface User {
  id: number;
  username: string;
  twoFactorEnabled: boolean;
  createdAt: string;
}

type Status = 'loading' | 'setup' | 'anon' | 'authed';

interface AuthCtx {
  status: Status;
  user: User | null;
  acceptTokens: (d: { accessToken: string; refreshToken: string; userId: number; user: User }) => Promise<void>;
  reloadUser: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);

  const reloadUser = useCallback(async () => {
    const r = await api.get<User>('/auth/me', { quiet: true });
    setUser(r.data);
  }, []);

  const boot = useCallback(async () => {
    try {
      const st = await api.get<{ hasUser: boolean }>('/auth/status', { quiet: true });
      if (!st.data.hasUser) return setStatus('setup');
      if (!hasSession()) return setStatus('anon');
      await reloadUser();
      await establishBrowserSession();
      connectRealtime();
      setStatus('authed');
    } catch {
      setStatus(hasSession() ? 'anon' : 'anon');
    }
  }, [reloadUser]);

  useEffect(() => {
    void boot();
    return onAuthChange(() => {
      if (!hasSession()) {
        disconnectRealtime();
        setUser(null);
        setStatus((s) => (s === 'setup' ? s : 'anon'));
      }
    });
  }, [boot]);

  const acceptTokens: AuthCtx['acceptTokens'] = async (d) => {
    setSession({ accessToken: d.accessToken, refreshToken: d.refreshToken, userId: d.userId });
    setUser(d.user);
    await establishBrowserSession();
    connectRealtime();
    setStatus('authed');
  };

  const logout = async () => {
    await apiLogout();
    disconnectRealtime();
  };

  return <Ctx.Provider value={{ status, user, acceptTokens, reloadUser, logout }}>{children}</Ctx.Provider>;
}
