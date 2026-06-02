import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

/**
 * Bloqueia paginas admin-only.
 *
 * Admin = isSuperAdmin OU role 'owner'/'admin' no primeiro account.
 * Cliente final (manager/sdr) e redirecionado pro /dashboard.
 *
 * Importante: e uma defesa de fachada — autorizacao real e no backend.
 * Mesmo que o cliente force a URL, as APIs admin-only rejeitam.
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'allow' | 'deny' | 'auth'>('loading');

  useEffect(() => {
    let alive = true;
    api
      .get<MeResponse>('/auth/me')
      .then((me) => {
        if (!alive) return;
        const account = me.accounts[0];
        const isAdmin =
          me.user.isSuperAdmin ||
          account?.role === 'owner' ||
          account?.role === 'admin';
        setState(isAdmin ? 'allow' : 'deny');
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          setState('auth');
        } else {
          setState('deny');
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm" style={{ color: 'var(--text-3)' }}>
        Carregando…
      </div>
    );
  }
  if (state === 'auth') return <Navigate to="/auth" replace />;
  if (state === 'deny') return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
