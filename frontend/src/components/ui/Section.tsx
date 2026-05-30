import type { ReactNode } from 'react';

interface SectionProps {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Container de seção com título, subtítulo e ação opcional. */
export default function Section({ title, subtitle, action, children, className = '' }: SectionProps) {
  return (
    <section className={`space-y-3 ${className}`}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold text-foreground">{title}</h2>}
            {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
