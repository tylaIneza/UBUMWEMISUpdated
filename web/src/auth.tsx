import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setCsrfToken, setUnauthenticatedHandler } from './api';

export interface Me {
  user: { id: string; name: string; email: string; roles: string[]; permissions: string[]; mustChangePassword: boolean; emailVerifiedAt: string | null };
  organization: { id: string; name: string; currency: string; isDemo: boolean; today: string };
  csrfToken: string;
  unreadNotifications: number;
  environment: string;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (...anyOf: string[]) => boolean;
  refresh: () => Promise<unknown>;
  /** Global property filter: '' means all buildings. */
  buildingId: string;
  setBuildingId: (id: string) => void;
}

const Ctx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [buildingId, setBuilding] = useState(() => sessionStorage.getItem('buildingId') ?? '');
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api.get<Me>('/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000, retry: false,
  });
  useEffect(() => setUnauthenticatedHandler(() => qc.setQueryData(['me'], null)), [qc]);

  const value = useMemo<AuthState>(() => {
    const perms = new Set(q.data?.user.permissions ?? []);
    return {
      me: q.data ?? null, loading: q.isLoading, can: (...anyOf) => anyOf.some((p) => perms.has(p)), refresh: () => q.refetch(),
      buildingId, setBuildingId: (id) => { sessionStorage.setItem('buildingId', id); setBuilding(id); },
    };
  }, [q.data, q.isLoading, buildingId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Reference data used by forms and filters (buildings, payment methods, expense categories). */
export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get('/meta'), staleTime: 5 * 60_000 });
}
