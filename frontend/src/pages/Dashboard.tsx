import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import KPI from '../components/ui/KPI';
import Section from '../components/ui/Section';
import { CountUp } from '../components/ui/CountUp';

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
  messagesYesterday: number;
  messagesDelta: number;
  messagesLast7Days: Array<{ day: string; count: number }>;
  conversations: { nina: number; human: number; paused: number; closed: number };
  contactsTotal: number;
  appointmentsThisWeek: number;
  dealsThisMonth: { count: number; value: number };
  produtosTotal: number;
  aiPerformance: { nina: number; human: number; total: number; autonomyPct: number };
  avgResponseMs: number;
  topProducts: Array<{ name: string; count: number }>;
}

interface CronJob {
  id: string;
  name: string;
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

function fmtDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}min`;
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
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  return (
    <AppShell
      title={`${greeting}, ${me?.profile?.fullName ?? me?.user.email.split('@')[0] ?? ''}`}
      subtitle={new Date().toLocaleDateString('pt-BR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })}
    >
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-[110px] rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* KPIs primários — primeiro destacado com Sparkline */}
          {kpis && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KPI
                label="Mensagens hoje"
                featured
                value={<CountUp value={kpis.messagesToday} />}
                delta={{
                  value: kpis.messagesDelta,
                  direction:
                    kpis.messagesDelta > 0 ? 'up' : kpis.messagesDelta < 0 ? 'down' : 'neutral',
                }}
                hint={`${kpis.messagesYesterday} ontem`}
                spark={kpis.messagesLast7Days.map((d) => d.count)}
              />
              <KPI
                label="DANI atendendo"
                value={<CountUp value={kpis.conversations.nina} />}
                hint={`${kpis.conversations.human} humano · ${kpis.conversations.paused} pausado`}
              />
              <KPI
                label="Autonomia DANI"
                value={
                  <span className="mono">
                    <CountUp value={kpis.aiPerformance.autonomyPct} />%
                  </span>
                }
                hint={`${kpis.aiPerformance.total} conversas 7d`}
              />
              <KPI
                label="Tempo médio resposta"
                value={fmtDuration(kpis.avgResponseMs)}
                hint="DANI nos últimos 7 dias"
              />
            </div>
          )}

          {/* KPIs secundários */}
          {kpis && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KPI label="Contatos" value={<CountUp value={kpis.contactsTotal} />} />
              <KPI
                label="Produtos sincronizados"
                value={<CountUp value={kpis.produtosTotal} />}
                hint="Bling ERP"
              />
              <KPI
                label="Agendamentos semana"
                value={<CountUp value={kpis.appointmentsThisWeek} />}
              />
              <KPI
                label="Deals do mês"
                value={<CountUp value={kpis.dealsThisMonth.count} />}
                hint={fmtBRL(kpis.dealsThisMonth.value)}
              />
            </div>
          )}

          {/* Volume + Top produtos lado a lado */}
          {kpis && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Volume 7d (col-span-2) */}
              <Section
                title="Volume últimos 7 dias"
                subtitle="Mensagens recebidas + enviadas"
                className="lg:col-span-2"
              >
                <div className="card-elev p-5">
                  <div className="flex items-end gap-3 h-44">
                    {kpis.messagesLast7Days.length === 0 ? (
                      <div className="flex-1 text-center text-sm text-muted-foreground self-center">
                        Sem dados ainda
                      </div>
                    ) : (
                      kpis.messagesLast7Days.map((d) => {
                        const h = Math.max(4, (d.count / max7d) * 100);
                        const date = new Date(d.day);
                        const isToday = date.toDateString() === new Date().toDateString();
                        return (
                          <div
                            key={d.day}
                            className="flex-1 flex flex-col items-center gap-1.5 group"
                          >
                            <div className="text-xs font-semibold text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                              {d.count}
                            </div>
                            <div className="w-full rounded-md relative overflow-hidden flex items-end">
                              <div
                                className={`w-full rounded-md transition-all group-hover:brightness-125 ${
                                  isToday
                                    ? 'gradient-pink'
                                    : 'bg-gradient-to-t from-primary/40 to-primary/10'
                                }`}
                                style={{ height: `${h}%`, minHeight: '8px' }}
                              />
                            </div>
                            <div
                              className={`text-[10px] ${
                                isToday ? 'text-foreground font-semibold' : 'text-muted-foreground'
                              }`}
                            >
                              {date.getDate()}/{date.getMonth() + 1}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </Section>

              {/* Top produtos */}
              <Section title="Top produtos" subtitle="Mais estoque disponível">
                <div className="card-elev p-4">
                  {kpis.topProducts.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-6">
                      Sem produtos disponíveis
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {kpis.topProducts.map((p, i) => (
                        <li key={p.name} className="flex items-center gap-2.5 text-sm">
                          <span className="w-5 h-5 rounded-md bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">
                            {i + 1}
                          </span>
                          <span className="flex-1 truncate text-foreground">{p.name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {p.count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Section>
            </div>
          )}

          {/* Cron + Health */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {cronJobs.length > 0 && (
              <Section title="Tarefas automáticas">
                <div className="card-elev p-4 space-y-2.5">
                  {cronJobs.map((j) => (
                    <div key={j.id} className="flex items-center gap-3 text-sm">
                      <span
                        className={`badge-dot ${
                          j.enabled ? 'bg-fce-green animate-pulse-dot' : 'bg-muted-foreground'
                        }`}
                      />
                      <span className="font-medium text-foreground flex-1">{j.name}</span>
                      <span className="text-xs text-muted-foreground">{j.humanReadable}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {health && (
              <Section
                title={`Sistema ${health.status === 'ok' ? 'saudável' : 'degradado'}`}
                subtitle={`fce-api v${health.version}`}
              >
                <div className="grid grid-cols-3 gap-2">
                  {Object.entries(health.checks).map(([name, status]) => (
                    <div
                      key={name}
                      className={`card-elev p-3 text-center ${
                        status === 'ok'
                          ? 'border-fce-green/30 bg-fce-green/5'
                          : 'border-destructive/30 bg-destructive/5'
                      }`}
                    >
                      <div className="uppercase text-[10px] text-muted-foreground font-medium">
                        {name}
                      </div>
                      <div
                        className={`font-bold mt-0.5 text-sm ${
                          status === 'ok' ? 'text-fce-green' : 'text-destructive'
                        }`}
                      >
                        {status === 'ok' ? 'OK' : 'ERROR'}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
