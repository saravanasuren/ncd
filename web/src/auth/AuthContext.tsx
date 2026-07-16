import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Permission, Role } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

export interface SessionUser {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  branchIds: number[];
  agentId: number | null;
  customerId: number | null;
}

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (...perms: Permission[]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadMe() {
    try {
      const r = await api.get<{ user: SessionUser }>('/api/auth/me');
      setUser(r.user);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // try a refresh once
        try {
          await api.post('/api/auth/refresh');
          const r = await api.get<{ user: SessionUser }>('/api/auth/me');
          setUser(r.user);
        } catch {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMe();
  }, []);

  const value: AuthState = {
    user,
    loading,
    login: async (email, password) => {
      const r = await api.post<{ user: SessionUser }>('/api/auth/login', { email, password });
      setUser(r.user);
    },
    logout: async () => {
      await api.post('/api/auth/logout');
      setUser(null);
    },
    can: (...perms) => !!user && perms.some((p) => user.permissions.includes(p)),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
