import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell, { PageCard } from '../components/AppShell';

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
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(n);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [meRes, healthRes] = await Promise.allSettled([
        api.get<MeResponse>('/auth/me'),
        api.get<HealthResponse>('/health'),
      ]);

      if (meRes.status === 'fulfilled') {
        setMe(meRes.value);
        const acc = meRes.value.accounts[0];
        if (acc) {
          try {
            const data = await api.get<DashboardKpis>(`/crm/dashboard?accountId=${acc.accountId}`);
            setKpis(data);
          } catch {
            // ignore
          }
          try {
            const sched = await api.get<{ jobs: CronJob[] }>('/cron/schedule');
            setCronJobs(sched.jobs);
          } catch {
            // ignore
          }
        }
      } else if (meRes.reason instanceof ApiError && meRes.reason.status === 401) {
        navigate('/auth');
        return;
      }

      if (healthRes.status === 'fulfilled') setHealth(healthRes.value);
      setLoading(false);
    }
    load();
  }, [navigate]);

  const max7d = Math.max(...(kpis?.messagesLast7Days.map((d) => d.count) ?? [1]), 1);

  return (
    <AppShell
      title={`Bom dia, ${me?.profile?.fullName ?? me?.user.email.split('@')[0] ?? ''}`}
      subtitle={
        new Date().toLocaleDateString('pt-BR', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })
      }
    >
      {loading ? (
        <p className="text-muted-foreground text-sm">Carregando...</p>
      ) : (
        <div className="space-y-6">
          {/* KPIs */}
          {kpis && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiCard label="Mensagens hoje" value={kpis.messagesToday} />
              <KpiCard
                label="DANI ativa"
                value={kpis.conversations.nina}
                accent="pink"
                hint={`${kpis.conversations.human} humano · ${kpis.conversations.paused} pausado`}
              />
              <KpiCard label="Agendamentos semana" value={kpis.appointmentsThisWeek} />
              <KpiCard
                label="Deals do mes"
                value={kpis.dealsThisMonth.count}
                accent="green"
                hint={fmtBRL(kpis.dealsThisMonth.value)}
              />
            </div>
          )}

          {/* 7-day chart */}
          {kpis && (
            <PageCard>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">Volume nos ultimos 7 dias</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Mensagens recebidas e enviadas
                  </p>
                </div>
                <div className="text-xs text-muted-foreground">
                  <span className="text-foreground font-medium">{kpis.contactsTotal}</span> contatos ·{' '}
                  <span className="text-foreground font-medium">{kpis.produtosTotal}</span> produtos
                </div>
              </div>
              <div className="flex items-end gap-2 h-32">
                {kpis.messagesLast7Days.length === 0 && (
                  <div className="flex-1 text-center text-xs text-muted-foreground self-center">
                    Sem dados ainda
                  </div>
                )}
                {kpis.messagesLast7Days.map((d) => {
                  const h = Math.max(4, (d.count / max7d) * 100);
                  const date = new Date(d.day);
                  return (
                    <div key={d.day} className="flex-1 flex flex-col items-center gap-1.5">
                      <div className="text-[10px] font-medium text-foreground">{d.count}</div>
                      <div className="w-full rounded-md gradient-pink" style={{ height: `${h}%` }} />
                      <div className="text-[10px] text-muted-foreground">
                        {date.getDate()}/{date.getMonth() + 1}
                      </div>
                    </div>
                  );
                })}
              </div>
            </PageCard>
          )}

          {/* Cron + Health side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {/* Cron */}
            {cronJobs.length > 0 && (
              <PageCard>
                <h2 className="text-sm font-semibold text-foreground mb-3">Tarefas automaticas</h2>
                <div className="space-y-2">
                  {cronJobs.map((j) => (
                    <div key={j.id} className="flex items-center gap-3 text-sm">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          j.enabled ? 'bg-fce-green' : 'bg-muted-foreground'
                        }`}
                      />
                      <span className="font-medium text-foreground flex-1">{j.name}</span>
                      <span className="text-xs text-muted-foreground">{j.humanReadable}</span>
                    </div>
                  ))}
                </div>
              </PageCard>
            )}

            {/* Health */}
            {health && (
              <PageCard>
                <div className="flex items-center gap-2 mb-3">
                  <div
                    className={`w-2 h-2 rounded-full ${
                      health.status === 'ok' ? 'bg-fce-green' : 'bg-fce-red'
                    }`}
                  />
                  <h2 className="text-sm font-semibold text-foreground">
                    Sistema {health.status === 'ok' ? 'OK' : 'degradado'}
                  </h2>
                  <span className="text-xs text-muted-foreground ml-auto">v{health.version}</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(health.checks).map(([name, status]) => (
                    <div
                      key={name}
                      className={`rounded-lg p-2 text-center text-xs ${
                        status === 'ok'
                          ? 'bg-fce-green/10 text-fce-green'
                          : 'bg-fce-red/10 text-fce-red'
                      }`}
                    >
                      <div className="uppercase font-medium opacity-70 text-[10px]">{name}</div>
                      <div className="font-bold mt-0.5">{status === 'ok' ? 'OK' : 'ERROR'}</div>
                    </div>
                  ))}
                </div>
              </PageCard>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | string;
  hint?: string;
  accent?: 'pink' | 'green';
}) {
  return (
    <div className="bg-card/40 border border-border/60 rounded-xl p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`text-3xl font-bold mt-1 ${
          accent === 'pink'
            ? 'text-fce-pink'
            : accent === 'green'
            ? 'text-fce-green'
            : 'text-foreground'
        }`}
      >
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </div>
  );
}
