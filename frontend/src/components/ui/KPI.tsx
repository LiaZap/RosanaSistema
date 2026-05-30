import type { ReactNode } from 'react';

interface KPIProps {
  label: string;
  value: ReactNode;
  delta?: { value: number; direction?: 'up' | 'down' | 'neutral' };
  icon?: ReactNode;
  hint?: ReactNode;
  accent?: 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}

const accentRing: Record<NonNullable<KPIProps['accent']>, string> = {
  brand: 'before:bg-primary',
  success: 'before:bg-fce-green',
  warning: 'before:bg-yellow-500',
  danger: 'before:bg-destructive',
  info: 'before:bg-blue-500',
  neutral: 'before:bg-muted-foreground',
};

export default function KPI({ label, value, delta, icon, hint, accent = 'neutral' }: KPIProps) {
  return (
    <div
      className={`kpi-card relative overflow-hidden
        before:content-[''] before:absolute before:top-0 before:left-0 before:right-0 before:h-px before:opacity-60
        ${accentRing[accent]}`}
    >
      <div className="flex items-start justify-between">
        <span className="kpi-label">{label}</span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
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
            <span className="text-muted-foreground/70 font-normal">vs ontem</span>
          </span>
        )}
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}
