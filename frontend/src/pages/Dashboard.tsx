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

interface DashboardKpis {
  messagesToday: number;
  messagesLast7Days: Array<{ day: string; count: number }>;
  conversations: { nina: number; human: number; paused: number; closed: number };
  contactsTotal: number;
  appointmentsThisWeek: number;
  dealsThisMonth: { count: number; value: number };
  produtosTotal: number;
}

interface CronJob {
  id: string;
  name: string;
  description: string;
  cron: string;
  humanReadable: string;
  enabled: boolean;
}

function fmtBRL(n: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
}

const NAV_LINKS = [
  { to: '/conversations', label: 'Conversas', primary: true },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/appointments', label: 'Agendamentos' },
  { to: '/agent', label: 'Agente' },
  { to: '/dani', label: 'Testar DANI' },
  { to: '/whatsapp', label: 'WhatsApp' },
  { to: '/bling', label: 'Bling' },
  { to: '/cloudinary', label: 'Cloudinary' },
];

export default function DashboardPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
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
        // Load KPIs after we have the account
        const acc = meRes.value.accounts[0];
        if (acc) {
          try {
            const data = await api.get<DashboardKpis>(`/crm/dashboard?accountId=${acc.accountId}`);
            setKpis(data);
          } catch {
            // KPIs falham silenciosamente - sistema ainda funciona sem
          }
          try {
            const sched = await api.get<{ jobs: CronJob[] }>('/cron/schedule');
            setCronJobs(sched.jobs);
          } catch {
            // ignore
          }
        }
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

  // Sparkline 7d
  const max7d = Math.max(...(kpis?.messagesLast7Days.map((d) => d.count) ?? [1]), 1);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">F</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">FCE Dashboard</h1>
              <p className="text-sm text-muted-foreground">
                {me?.accounts[0]?.accountName ?? 'Filhos com Estilo'}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground
                       hover:bg-card transition-colors"
          >
            Sair
          </button>
        </div>

        {/* Navigation */}
        <div className="flex gap-2 flex-wrap">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`px-4 py-2 rounded-lg text-sm transition-colors ${
                link.primary
                  ? 'gradient-pink text-white font-semibold hover:opacity-90'
                  : 'border border-border text-foreground hover:bg-card'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* KPIs */}
        {kpis && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="glass rounded-xl p-4">
                <div className="text-xs uppercase text-muted-foreground">Mensagens hoje</div>
                <div className="text-3xl font-bold text-foreground mt-1">{kpis.messagesToday}</div>
              </div>
              <div className="glass rounded-xl p-4">
                <div className="text-xs uppercase text-muted-foreground">DANI ativa</div>
                <div className="text-3xl font-bold text-fce-pink mt-1">
                  {kpis.conversations.nina}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {kpis.conversations.human} humano · {kpis.conversations.paused} pausado
                </div>
              </div>
              <div className="glass rounded-xl p-4">
                <div className="text-xs uppercase text-muted-foreground">Agendamentos semana</div>
                <div className="text-3xl font-bold text-foreground mt-1">{kpis.appointmentsThisWeek}</div>
              </div>
              <div className="glass rounded-xl p-4">
                <div className="text-xs uppercase text-muted-foreground">Deals do mes</div>
                <div className="text-3xl font-bold text-fce-green mt-1">{kpis.dealsThisMonth.count}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {fmtBRL(kpis.dealsThisMonth.value)}
                </div>
              </div>
            </div>

            {/* 7-day chart */}
            <div className="glass rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-foreground text-sm">Mensagens nos ultimos 7 dias</h2>
                <span className="text-xs text-muted-foreground">
                  {kpis.contactsTotal} contatos · {kpis.produtosTotal} produtos
                </span>
              </div>
              <div className="flex items-end gap-1 h-32">
                {kpis.messagesLast7Days.length === 0 && (
                  <div className="flex-1 text-center text-xs text-muted-foreground self-center">
                    Sem dados ainda
                  </div>
                )}
                {kpis.messagesLast7Days.map((d) => {
                  const h = Math.max(2, (d.count / max7d) * 100);
                  const date = new Date(d.day);
                  return (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1">
                      <div className="text-[10px] text-muted-foreground">{d.count}</div>
                      <div
                        className="w-full rounded-t gradient-pink"
                        style={{ height: `${h}%` }}
                      />
                      <div className="text-[10px] text-muted-foreground">
                        {date.getDate()}/{date.getMonth() + 1}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Cron jobs */}
        {cronJobs.length > 0 && (
          <div className="glass rounded-xl p-5 space-y-2">
            <h2 className="font-semibold text-foreground text-sm">Tarefas automaticas</h2>
            <div className="space-y-1.5">
              {cronJobs.map((j) => (
                <div
                  key={j.id}
                  className="flex items-center gap-3 text-sm"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      j.enabled ? 'bg-fce-green' : 'bg-muted-foreground'
                    }`}
                  />
                  <span className="font-medium text-foreground">{j.name}</span>
                  <span className="text-xs text-muted-foreground">{j.humanReadable}</span>
                  <span className="text-[10px] font-mono text-muted-foreground ml-auto">
                    {j.cron}
                  </span>
                </div>
              ))}
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
              <h2 className="font-semibold text-foreground text-sm">
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
                  className={`rounded-lg p-2 text-center ${
                    status === 'ok'
                      ? 'bg-fce-green/10 text-fce-green'
                      : 'bg-fce-red/10 text-fce-red'
                  }`}
                >
                  <div className="text-xs uppercase font-medium opacity-70">{name}</div>
                  <div className="font-bold text-sm">{status === 'ok' ? 'OK' : 'ERROR'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Errors */}
        {(meError || healthError) && (
          <div className="rounded-xl border border-fce-red/40 bg-fce-red/10 p-5 space-y-2">
            <h3 className="font-semibold text-fce-red">Falha de comunicacao com o backend</h3>
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
          </div>
        )}
      </div>
    </div>
  );
}
