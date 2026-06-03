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
  topProducts: Array<{ name: string; count: number; preco: number | null; codigo: string | null }>;
  funnel?: {
    contatos: number;
    qualificados: number;
    dealsCriados: number;
    ganhos: number;
    valorGanho: number;
  };
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

// Formato YYYY-MM-DD pra inputs
function toInputDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);

  // Exportar PDF
  const [showExport, setShowExport] = useState(false);
  const [exportFrom, setExportFrom] = useState(() =>
    toInputDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  );
  const [exportTo, setExportTo] = useState(() => toInputDate(new Date()));
  const [exporting, setExporting] = useState(false);

  function handleExport() {
    const acc = me?.accounts[0];
    if (!acc) return;
    setExporting(true);
    const url = `${import.meta.env.VITE_API_URL ?? '/api'}/crm/report/html?accountId=${acc.accountId}&dateFrom=${exportFrom}&dateTo=${exportTo}`;
    const win = window.open(url, '_blank');
    if (!win) {
      alert('Popup bloqueado. Permita popups para este site e tente novamente.');
    }
    setExporting(false);
    setShowExport(false);
  }

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
      actions={
        <button
          onClick={() => setShowExport(true)}
          className="btn btn-secondary btn-sm flex items-center gap-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Exportar PDF
        </button>
      }
    >
      {/* Modal de exportação */}
      {showExport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'oklch(0 0 0 / 0.45)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowExport(false); }}
        >
          <div className="material w-full max-w-sm mx-4 p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-1)' }}>
                Exportar relatório
              </h2>
              <button
                onClick={() => setShowExport(false)}
                className="btn-ghost btn-sm rounded-md px-2 py-1 text-lg leading-none"
              >
                ×
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="field-label">Data inicial</label>
                <input
                  type="date"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                  className="input-base"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
              <div>
                <label className="field-label">Data final</label>
                <input
                  type="date"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                  className="input-base"
                  style={{ colorScheme: 'dark' }}
                />
              </div>
            </div>

            <p className="text-xs" style={{ color: 'var(--text-3)' }}>
              O relatório abrirá em nova aba e o diálogo de impressão/PDF será aberto automaticamente.
            </p>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowExport(false)}
                className="btn btn-secondary btn-sm"
              >
                Cancelar
              </button>
              <button
                onClick={handleExport}
                disabled={exporting || !exportFrom || !exportTo}
                className="btn btn-primary btn-sm"
              >
                {exporting ? 'Abrindo…' : 'Gerar PDF'}
              </button>
            </div>
          </div>
        </div>
      )}
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

          {/* Volume + Catálogo produtos lado a lado */}
          {kpis && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Volume 7d (col-span-2) */}
              <Section
                title="Volume últimos 7 dias"
                subtitle="Mensagens recebidas + enviadas"
                className="lg:col-span-2"
              >
                <div
                  className="rounded-xl p-5"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    boxShadow: 'var(--sh-sm)',
                  }}
                >
                  <div className="flex items-end gap-2 h-44">
                    {kpis.messagesLast7Days.length === 0 ? (
                      <div
                        className="flex-1 text-center text-sm self-center"
                        style={{ color: 'var(--text-3)' }}
                      >
                        Sem dados ainda
                      </div>
                    ) : (
                      kpis.messagesLast7Days.map((d) => {
                        const h = Math.max(6, (d.count / max7d) * 100);
                        const date = new Date(d.day + 'T12:00:00');
                        const isToday = date.toDateString() === new Date().toDateString();
                        return (
                          <div
                            key={d.day}
                            className="flex-1 flex flex-col items-center gap-1.5 group"
                          >
                            {/* Tooltip */}
                            <div
                              className="text-[11px] font-bold opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ color: 'var(--text-1)' }}
                            >
                              {d.count}
                            </div>
                            {/* Barra */}
                            <div className="w-full flex-1 flex items-end">
                              <div
                                className="w-full rounded-t-md transition-all duration-300 group-hover:brightness-110"
                                style={{
                                  height: `${h}%`,
                                  minHeight: 8,
                                  background: isToday
                                    ? 'linear-gradient(to top, oklch(0.55 0.16 350), oklch(0.65 0.18 340))'
                                    : 'linear-gradient(to top, var(--primary), oklch(from var(--primary) l c h / 0.45))',
                                  borderRadius: '6px 6px 2px 2px',
                                }}
                              />
                            </div>
                            {/* Label data */}
                            <div
                              className="text-[10px] font-medium"
                              style={{
                                color: isToday ? 'var(--primary-text)' : 'var(--text-3)',
                                fontWeight: isToday ? 700 : 400,
                              }}
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

              {/* Catálogo completo com scroll */}
              <Section
                title="Catálogo em estoque"
                subtitle={`${kpis.topProducts.length} produtos disponíveis · ordenado por estoque`}
              >
                <div
                  className="rounded-xl"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    boxShadow: 'var(--sh-sm)',
                    overflow: 'hidden',
                  }}
                >
                  {kpis.topProducts.length === 0 ? (
                    <p
                      className="text-xs text-center py-6"
                      style={{ color: 'var(--text-3)' }}
                    >
                      Nenhum produto com estoque. Sincronize o Bling.
                    </p>
                  ) : (
                    <ul
                      className="divide-y"
                      style={{
                        maxHeight: 220,
                        overflowY: 'auto',
                        borderColor: 'var(--border)',
                      }}
                    >
                      {kpis.topProducts.map((p, i) => {
                        // Barra de estoque relativa ao maior
                        const maxStock = kpis.topProducts[0]?.count ?? 1;
                        const pct = Math.max(4, Math.round((p.count / maxStock) * 100));
                        return (
                          <li
                            key={`${p.name}-${i}`}
                            className="flex items-center gap-2.5 px-3 py-2.5 group"
                            style={{ borderColor: 'var(--border)' }}
                          >
                            {/* Rank */}
                            <span
                              className="text-[10px] font-bold tabular-nums w-4 shrink-0 text-right"
                              style={{ color: i < 3 ? 'var(--primary)' : 'var(--text-3)' }}
                            >
                              {i + 1}
                            </span>

                            {/* Nome + barra */}
                            <div className="flex-1 min-w-0">
                              <div
                                className="text-[12.5px] font-medium truncate leading-tight"
                                style={{ color: 'var(--text-1)' }}
                                title={p.name}
                              >
                                {p.name}
                              </div>
                              {/* Mini progress bar */}
                              <div
                                className="mt-1 h-1 rounded-full overflow-hidden"
                                style={{ background: 'var(--bg-sunken)' }}
                              >
                                <div
                                  className="h-full rounded-full transition-all"
                                  style={{
                                    width: `${pct}%`,
                                    background: i < 3
                                      ? 'var(--primary)'
                                      : 'var(--border-strong)',
                                  }}
                                />
                              </div>
                            </div>

                            {/* Estoque + preço */}
                            <div className="text-right shrink-0">
                              <div
                                className="text-[11px] font-bold tabular-nums"
                                style={{ color: 'var(--text-1)' }}
                              >
                                {p.count}
                              </div>
                              {p.preco != null && (
                                <div
                                  className="text-[10px] tabular-nums"
                                  style={{ color: 'var(--text-3)' }}
                                >
                                  {new Intl.NumberFormat('pt-BR', {
                                    style: 'currency',
                                    currency: 'BRL',
                                    maximumFractionDigits: 0,
                                  }).format(p.preco)}
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </Section>
            </div>
          )}

          {/* Funil de conversão */}
          {kpis?.funnel && (
            <Section
              title="Funil de conversão"
              subtitle="Últimos 30 dias · cliente → ganho"
            >
              <div className="material p-5">
                <FunnelChart funnel={kpis.funnel} />
              </div>
            </Section>
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

function FunnelChart({
  funnel,
}: {
  funnel: { contatos: number; qualificados: number; dealsCriados: number; ganhos: number; valorGanho: number };
}) {
  const steps = [
    { label: 'Contatos', value: funnel.contatos, color: 'var(--info)' },
    { label: 'Qualificados', value: funnel.qualificados, color: 'var(--warning)' },
    { label: 'Deals criados', value: funnel.dealsCriados, color: 'var(--primary)' },
    { label: 'Ganhos', value: funnel.ganhos, color: 'var(--success)' },
  ];
  const max = Math.max(...steps.map((s) => s.value), 1);
  const overallConv =
    funnel.contatos > 0 ? Math.round((funnel.ganhos / funnel.contatos) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-xs font-mono uppercase" style={{ color: 'var(--text-3)' }}>
          Taxa de conversão geral
        </span>
        <span className="text-2xl font-bold mono" style={{ color: 'var(--primary-text)' }}>
          {overallConv}%
        </span>
      </div>
      {steps.map((s, i) => {
        const w = Math.max(8, (s.value / max) * 100);
        const convFromPrev =
          i === 0 ? null : steps[i - 1].value > 0 ? Math.round((s.value / steps[i - 1].value) * 100) : 0;
        return (
          <div key={s.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium" style={{ color: 'var(--text-2)' }}>
                {s.label}
              </span>
              <div className="flex items-center gap-2">
                {convFromPrev != null && (
                  <span className="font-mono" style={{ color: 'var(--text-3)' }}>
                    {convFromPrev}%
                  </span>
                )}
                <span className="font-bold mono tabular-nums" style={{ color: 'var(--text-1)' }}>
                  {s.value}
                </span>
              </div>
            </div>
            <div
              className="h-7 rounded-md transition-all"
              style={{
                width: `${w}%`,
                background: `color-mix(in oklch, ${s.color} 25%, transparent)`,
                borderLeft: `3px solid ${s.color}`,
              }}
            />
          </div>
        );
      })}
      {funnel.valorGanho > 0 && (
        <div
          className="mt-3 p-2.5 rounded-md text-xs"
          style={{
            background: 'var(--success-bg)',
            color: 'var(--success)',
            border: '1px solid color-mix(in oklch, var(--success) 25%, transparent)',
          }}
        >
          💰 Valor ganho:{' '}
          <span className="font-mono font-bold tabular-nums">
            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
              funnel.valorGanho,
            )}
          </span>
        </div>
      )}
    </div>
  );
}
