import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar, LabelList,
} from 'recharts';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import KPI from '../components/ui/KPI';
import Section from '../components/ui/Section';
import { CountUp } from '../components/ui/CountUp';

// Lê as cores do tema atual (OKLCH) das CSS vars, e re-lê quando o usuário
// troca tema/direção (cedro/indigo/brasa, light/dark) — pra os gráficos
// Recharts (que precisam de cores concretas) acompanharem o tema.
function readThemeColors() {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string, fb: string) => s.getPropertyValue(n).trim() || fb;
  return {
    primary: g('--primary', '#3a7878'),
    primaryText: g('--primary-text', '#2c5c5c'),
    success: g('--success', '#3a9d5a'),
    warning: g('--warning', '#c98a2e'),
    danger: g('--danger', '#d14a3a'),
    info: g('--info', '#3a78b5'),
    dani: g('--dani', '#7c5cdb'),
    text1: g('--text-1', '#1a1a1a'),
    text2: g('--text-2', '#555'),
    text3: g('--text-3', '#999'),
    border: g('--border', '#e4e4e4'),
    bgSurface: g('--bg-surface', '#fff'),
  };
}

function useThemeColors() {
  const [colors, setColors] = useState(readThemeColors);
  useEffect(() => {
    const read = () => setColors(readThemeColors());
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-dir', 'class'],
    });
    return () => obs.disconnect();
  }, []);
  return colors;
}

// Tooltip customizado (combina com o design, sem o box branco feio padrão)
function ChartTooltip({ active, payload, label, suffix }: {
  active?: boolean;
  payload?: Array<{ value: number; name?: string; payload?: { label?: string } }>;
  label?: string;
  suffix?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0];
  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        padding: '8px 12px',
        boxShadow: 'var(--sh-md)',
        fontSize: 12,
      }}
    >
      <div style={{ color: 'var(--text-3)', fontSize: 10.5, marginBottom: 2 }}>
        {p.payload?.label ?? label ?? p.name}
      </div>
      <div style={{ color: 'var(--text-1)', fontWeight: 700, fontSize: 15 }}>
        {p.value}{suffix ?? ''}
      </div>
    </div>
  );
}

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

  const colors = useThemeColors();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  // Dados formatados pros graficos
  const volumeData = (kpis?.messagesLast7Days ?? []).map((d) => {
    const date = new Date(d.day + 'T12:00:00');
    return { label: `${date.getDate()}/${date.getMonth() + 1}`, count: d.count };
  });

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
                  className="rounded-xl p-4 pt-5"
                  style={{
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    boxShadow: 'var(--sh-sm)',
                  }}
                >
                  {volumeData.length === 0 ? (
                    <div className="h-[200px] flex items-center justify-center text-sm" style={{ color: 'var(--text-3)' }}>
                      Sem dados ainda
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={volumeData} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                        <defs>
                          <linearGradient id="volGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={colors.primary} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={colors.primary} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke={colors.border} vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: colors.text3 }}
                          axisLine={false}
                          tickLine={false}
                          dy={4}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: colors.text3 }}
                          axisLine={false}
                          tickLine={false}
                          allowDecimals={false}
                          width={40}
                        />
                        <Tooltip content={<ChartTooltip suffix=" msgs" />} cursor={{ stroke: colors.border }} />
                        <Area
                          type="monotone"
                          dataKey="count"
                          stroke={colors.primary}
                          strokeWidth={2.5}
                          fill="url(#volGrad)"
                          dot={{ r: 3, fill: colors.primary, strokeWidth: 0 }}
                          activeDot={{ r: 5, fill: colors.primary, stroke: colors.bgSurface, strokeWidth: 2 }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
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

          {/* Funil de conversão + Donut de status */}
          {kpis && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {kpis.funnel && (
                <Section
                  title="Funil de conversão"
                  subtitle="Últimos 30 dias · cliente → ganho"
                  className="lg:col-span-2"
                >
                  <div
                    className="rounded-xl p-5"
                    style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--sh-sm)' }}
                  >
                    <ConversionFunnel funnel={kpis.funnel} colors={colors} />
                  </div>
                </Section>
              )}
              <Section title="Conversas por status" subtitle="Distribuição atual">
                <div
                  className="rounded-xl p-4"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--sh-sm)' }}
                >
                  <StatusDonut conversations={kpis.conversations} colors={colors} />
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

type ThemeColors = ReturnType<typeof readThemeColors>;

function ConversionFunnel({
  funnel,
  colors,
}: {
  funnel: { contatos: number; qualificados: number; dealsCriados: number; ganhos: number; valorGanho: number };
  colors: ThemeColors;
}) {
  // Barras horizontais (nao "funil" trapezoidal): as etapas NAO sao
  // monotonicas decrescentes (ex: deals criados pode passar qualificados,
  // pois a DANI cria deal por intencao de compra direto). Barras mostram
  // cada valor proporcional, sem distorcer.
  const data = [
    { label: 'Contatos', value: funnel.contatos, fill: colors.info },
    { label: 'Qualificados', value: funnel.qualificados, fill: colors.warning },
    { label: 'Deals criados', value: funnel.dealsCriados, fill: colors.primary },
    { label: 'Ganhos', value: funnel.ganhos, fill: colors.success },
  ];
  const overall = funnel.contatos > 0 ? Math.round((funnel.ganhos / funnel.contatos) * 100) : 0;
  const allZero = data.every((d) => d.value === 0);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
          Taxa de conversão geral
        </span>
        <span className="text-2xl font-bold" style={{ color: 'var(--primary-text)' }}>
          {overall}%
        </span>
      </div>
      {allZero ? (
        <div className="h-[190px] flex items-center justify-center text-sm" style={{ color: 'var(--text-3)' }}>
          Sem dados no período
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 32, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.border} horizontal={false} />
            <XAxis type="number" hide allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 12, fill: colors.text2 }}
              axisLine={false}
              tickLine={false}
              width={92}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'transparent' }} />
            <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={24} isAnimationActive>
              {data.map((d, i) => (
                <Cell key={i} fill={d.fill} />
              ))}
              <LabelList
                dataKey="value"
                position="right"
                fill={colors.text1}
                fontSize={13}
                fontWeight={700}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
      {funnel.valorGanho > 0 && (
        <div
          className="mt-1 p-2.5 rounded-md text-xs flex items-center gap-1.5"
          style={{ background: 'var(--success-bg)', color: 'var(--success)' }}
        >
          💰 Valor ganho:
          <span className="font-bold tabular-nums">{fmtBRL(funnel.valorGanho)}</span>
        </div>
      )}
    </div>
  );
}

function StatusDonut({
  conversations,
  colors,
}: {
  conversations: { nina: number; human: number; paused: number; closed: number };
  colors: ThemeColors;
}) {
  const data = [
    { label: 'DANI', value: conversations.nina, fill: colors.dani },
    { label: 'Humano', value: conversations.human, fill: colors.success },
    { label: 'Pausado', value: conversations.paused, fill: colors.warning },
    { label: 'Fechado', value: conversations.closed, fill: colors.text3 },
  ].filter((d) => d.value > 0);
  const total = data.reduce((a, b) => a + b.value, 0);

  if (total === 0) {
    return (
      <div className="h-[180px] flex items-center justify-center text-sm" style={{ color: 'var(--text-3)' }}>
        Nenhuma conversa
      </div>
    );
  }
  return (
    <div>
      <ResponsiveContainer width="100%" height={150}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={42}
            outerRadius={64}
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.fill} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-1">
        {data.map((d) => (
          <div key={d.label} className="flex items-center gap-1.5 text-[11.5px]">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.fill }} />
            <span style={{ color: 'var(--text-2)' }}>{d.label}</span>
            <span className="ml-auto font-bold tabular-nums" style={{ color: 'var(--text-1)' }}>
              {d.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
