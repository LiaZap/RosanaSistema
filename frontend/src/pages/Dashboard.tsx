import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  profile: { fullName?: string } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string; accountSlug: string }>;
}

interface HealthResponse {
  status: string;
  service: string;
  version: string;
  checks: { postgres: string; redis: string; minio: string };
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [meRes, healthRes] = await Promise.allSettled([
        api.get<MeResponse>('/auth/me'),
        api.get<HealthResponse>('/health'),
      ]);

      if (meRes.status === 'fulfilled') {
        setMe(meRes.value);
      } else {
        if (meRes.reason instanceof ApiError && meRes.reason.status === 401) {
          navigate('/auth');
          return;
        }
        setMeError(meRes.reason?.message || 'Falha ao carregar /auth/me');
      }

      if (healthRes.status === 'fulfilled') {
        setHealth(healthRes.value);
      } else {
        setHealthError(healthRes.reason?.message || 'Falha ao carregar /health');
      }

      setLoading(false);
    }
    load();
  }, [navigate]);

  async function handleLogout() {
    await api.post('/auth/logout');
    navigate('/auth');
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Carregando...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">F</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">FCE Dashboard</h1>
              <p className="text-sm text-muted-foreground">Filhos com Estilo</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              to="/conversations"
              className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold
                         hover:opacity-90 transition-opacity"
            >
              Conversas
            </Link>
            <Link
              to="/dani"
              className="px-4 py-2 rounded-lg border border-border text-sm text-foreground
                         hover:bg-card transition-colors"
            >
              Testar DANI
            </Link>
            <Link
              to="/whatsapp"
              className="px-4 py-2 rounded-lg border border-border text-sm text-foreground
                         hover:bg-card transition-colors"
            >
              WhatsApp
            </Link>
            <Link
              to="/bling"
              className="px-4 py-2 rounded-lg border border-border text-sm text-foreground
                         hover:bg-card transition-colors"
            >
              Bling
            </Link>
            <button
              onClick={handleLogout}
              className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground
                         hover:bg-card transition-colors"
            >
              Sair
            </button>
          </div>
        </div>

        {/* User Card */}
        {me && (
          <div className="glass rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-foreground">
              Ola, {me.profile?.fullName || me.user.email}
            </h2>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-muted-foreground">Email:</span>{' '}
                <span className="text-foreground">{me.user.email}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Super Admin:</span>{' '}
                <span className="text-foreground">{me.user.isSuperAdmin ? 'Sim' : 'Nao'}</span>
              </div>
              {me.accounts.length > 0 && (
                <div className="col-span-2">
                  <span className="text-muted-foreground">Conta:</span>{' '}
                  <span className="text-foreground">
                    {me.accounts[0].accountName} ({me.accounts[0].role})
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Health Card */}
        {health && (
          <div className="glass rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${
                health.status === 'ok' ? 'bg-fce-green' : 'bg-fce-red'
              }`} />
              <h2 className="font-semibold text-foreground">
                System Health: {health.status.toUpperCase()}
              </h2>
              <span className="text-xs text-muted-foreground ml-auto">
                v{health.version}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {Object.entries(health.checks).map(([name, status]) => (
                <div
                  key={name}
                  className={`rounded-lg p-3 text-center ${
                    status === 'ok'
                      ? 'bg-fce-green/10 text-fce-green'
                      : 'bg-fce-red/10 text-fce-red'
                  }`}
                >
                  <div className="text-xs uppercase font-medium opacity-70">{name}</div>
                  <div className="font-bold">{status === 'ok' ? 'OK' : 'ERROR'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Errors (debug) */}
        {(meError || healthError) && (
          <div className="rounded-xl border border-fce-red/40 bg-fce-red/10 p-5 space-y-2">
            <h3 className="font-semibold text-fce-red">Falha de comunicação com o backend</h3>
            {meError && (
              <p className="text-sm text-fce-red/90">
                <span className="font-mono">/auth/me</span>: {meError}
              </p>
            )}
            {healthError && (
              <p className="text-sm text-fce-red/90">
                <span className="font-mono">/health</span>: {healthError}
              </p>
            )}
            <p className="text-xs text-muted-foreground pt-2 border-t border-fce-red/20">
              Veja a aba Network do navegador. Provável: nginx (frontend) não consegue
              alcançar o backend, ou env vars do fce-api estão erradas.
            </p>
          </div>
        )}

        {/* Phase info */}
        <div className="glass rounded-xl p-5 text-center text-muted-foreground text-sm">
          <p>Phase 1 — Setup minimo deployavel</p>
          <p className="mt-1">
            Auth + Health Check funcionando. Proximas fases: DANI, WhatsApp, Bling, CRM.
          </p>
        </div>
      </div>
    </div>
  );
}
