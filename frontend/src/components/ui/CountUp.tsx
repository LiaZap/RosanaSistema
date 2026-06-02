import { useEffect, useRef, useState } from 'react';

/**
 * Anima de 0 ao valor target quando o elemento entra na viewport.
 * Usa IntersectionObserver + easeOutCubic.
 */
export function CountUp({
  value,
  duration = 950,
  prefix = '',
  suffix = '',
  format = 'integer',
}: {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  format?: 'integer' | 'currency' | 'percent';
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(0);
  const fired = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !fired.current) {
            fired.current = true;
            const start = performance.now();
            const animate = (now: number) => {
              const t = Math.min(1, (now - start) / duration);
              const eased = 1 - Math.pow(1 - t, 3);
              setShown(Math.round(value * eased));
              if (t < 1) requestAnimationFrame(animate);
            };
            requestAnimationFrame(animate);
          }
        }
      },
      { threshold: 0.3 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [value, duration]);

  const formatted =
    format === 'currency'
      ? new Intl.NumberFormat('pt-BR').format(shown)
      : format === 'percent'
        ? `${shown}%`
        : new Intl.NumberFormat('pt-BR').format(shown);

  return (
    <span ref={ref} className="mono">
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
