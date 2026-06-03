import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import RequireAdmin from '../components/RequireAdmin';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface TokenUsage {
  currentMonth: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    calls: number;
    cost: { usd: number; brl: number };
  };
  byMonth: Array<{
    month: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    calls: number;
    cost: { usd: number; brl: number };
  }>;
  note: string;
}

function fmtNum(n: number) {
  return new Intl.NumberFormat('pt-BR').format(n);
}

export default function TokenCostPage() {
  return (
    <RequireAdmin>
      <TokenCostInner />
    </RequireAdmin>
  );
}

function TokenCostInner() {
  const navigate = useNavigate();
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<TokenUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<MeResponse>('/auth/me')
      .then((me) => {
        if (me.accounts[0]) setAccountId(me.accounts[0].accountId);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
      });
  }, [navigate]);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    api.get<TokenUsage>(`/crm/token-usage?accountId=${accountId}`)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Erro ao carregar'))
      .finally(() => setLoading(false));
  }, [accountId]);

  // Agrupa byMonth por mês (soma modelos)
  const byMonthAgg = data?.byMonth.reduce<Record<string, { month: string; total: number; input: number; output: number; calls: number; brl: number }>>((acc, r) => {
    if (!acc[r.month]) acc[r.month] = { month: r.month, total: 0, input: 0, output: 0, calls: 0, brl: 0 };
    acc[r.month].total   += r.total_tokens;
    acc[r.month].input   += r.input_tokens;
    acc[r.month].output  += r.output_tokens;
    acc[r.month].calls   += r.calls;
    acc[r.month].brl     += r.cost.brl;
    return acc;
  }, {}) ?? {};

  const months = Object.values(byMonthAgg).sort((a, b) => b.month.localeCompare(a.month));

  // Barra do mês com maior uso
  const maxTotal = Math.max(...months.map((m) => m.total), 1);

  return (
    <AppShell
      title="Custo de tokens"
      subtitle="Gemini API · estimativa mensal · admin only"
    >
      {error && (
        <div
          className="rounded-lg p-3 text-sm mb-4"
          style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-xl" />)}
        </div>
      ) : data && (
        <div className="space-y-6">
          {/* Cards mês atual */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Total tokens', value: fmtNum(data.currentMonth.total_tokens), color: 'var(--primary)' },
              { label: 'Input tokens', value: fmtNum(data.currentMonth.input_tokens), color: 'var(--info)' },
              { label: 'Output tokens', value: fmtNum(data.currentMonth.output_tokens), color: 'var(--warning)' },
              { label: 'Chamadas IA', value: fmtNum(data.currentMonth.calls), color: 'var(--dani)' },
            ].map((kpi) => (
              <div
                key={kpi.label}
                className="material p-4"
              >
                <div
                  className="text-[22px] font-bold tabular-nums"
                  style={{ color: kpi.color }}
                >
                  {kpi.value}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-3)' }}>
                  {kpi.label}
                </div>
              </div>
            ))}
          </div>

          {/* Custo estimado mês atual */}
          <div
            className="material p-5 flex items-center justify-between"
          >
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                Custo estimado este mês
              </div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                {data.note}
              </div>
            </div>
            <div className="text-right">
              <div
                className="text-[28px] font-bold tabular-nums"
                style={{ color: 'var(--success)' }}
              >
                R$ {data.currentMonth.cost.brl.toFixed(2)}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                US$ {data.currentMonth.cost.usd.toFixed(3)}
              </div>
            </div>
          </div>

          {/* Histórico meses */}
          {months.length > 0 && (
            <div className="material overflow-hidden">
              <div
                className="px-5 py-3 border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                  Histórico últimos 6 meses
                </h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {['Mês', 'Total tokens', 'Input', 'Output', 'Chamadas', 'Custo (BRL)'].map((h) => (
                      <th
                        key={h}
                        className="px-4 py-2.5 text-left text-[11px] uppercase tracking-wider font-semibold"
                        style={{ color: 'var(--text-3)' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {months.map((m, i) => (
                    <tr
                      key={m.month}
                      style={{ borderBottom: i < months.length - 1 ? '1px solid var(--border)' : 'none' }}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-1.5 rounded-full"
                            style={{
                              width: `${Math.max(8, Math.round((m.total / maxTotal) * 80))}px`,
                              background: 'var(--primary)',
                            }}
                          />
                          <span className="font-medium" style={{ color: 'var(--text-1)' }}>
                            {m.month}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--text-1)' }}>
                        {fmtNum(m.total)}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--text-2)' }}>
                        {fmtNum(m.input)}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--text-2)' }}>
                        {fmtNum(m.output)}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--text-2)' }}>
                        {fmtNum(m.calls)}
                      </td>
                      <td
                        className="px-4 py-3 tabular-nums font-semibold"
                        style={{ color: 'var(--success)' }}
                      >
                        R$ {m.brl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {months.length === 0 && (
            <div
              className="text-center py-12 text-sm"
              style={{ color: 'var(--text-3)' }}
            >
              Sem histórico ainda. Os dados aparecem conforme a DANI responde.
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
