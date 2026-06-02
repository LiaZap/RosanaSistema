import type { ReactNode } from 'react';
import { Sparkline } from './Sparkline';

interface KPIProps {
  label: string;
  value: ReactNode;
  delta?: { value: number; direction?: 'up' | 'down' | 'neutral' };
  icon?: ReactNode;
  hint?: ReactNode;
  /** Quando true, usa fundo com primary-tint (KPI destacado) */
  featured?: boolean;
  /** Dados pra mostrar Sparkline embaixo */
  spark?: number[];
}

export default function KPI({ label, value, delta, icon, hint, featured, spark }: KPIProps) {
  return (
    <div className={`kpi-card material lift overflow-hidden ${featured ? 'feat' : ''}`}>
      <div className="flex items-start justify-between">
        <span className="kpi-label">{label}</span>
        {icon && <span style={{ color: 'var(--text-3)' }}>{icon}</span>}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="flex items-center justify-between min-h-[18px]">
        {delta && (
          <span
            className={`kpi-delta ${
              delta.direction === 'up'
                ? 'kpi-delta-up'
                : delta.direction === 'down'
                  ? 'kpi-delta-down'
                  : 'kpi-delta-neutral'
            }`}
          >
            {delta.direction === 'up' && '↑'}
            {delta.direction === 'down' && '↓'}
            {delta.direction === 'neutral' && '→'} {delta.value > 0 ? '+' : ''}
            {delta.value}%
            <span className="font-normal" style={{ color: 'var(--text-3)' }}>vs ontem</span>
          </span>
        )}
        {hint && <span className="text-xs" style={{ color: 'var(--text-3)' }}>{hint}</span>}
      </div>
      {spark && spark.length >= 2 && (
        <div className="-mx-5 -mb-4 mt-3">
          <Sparkline data={spark} width={300} height={56} />
        </div>
      )}
    </div>
  );
}
