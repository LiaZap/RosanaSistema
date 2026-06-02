import { useEffect, useRef, useState } from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Sparkline SVG com gradiente da primária. Linha desenha via stroke-dashoffset.
 * Dot no último ponto.
 */
export function Sparkline({ data, width = 260, height = 64, className }: SparklineProps) {
  const ref = useRef<SVGPathElement | null>(null);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setDrawn(true)),
      { threshold: 0.3 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  if (data.length < 2) return null;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pad = 4;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * w;
    const y = pad + h - ((v - min) / range) * h;
    return [x, y] as const;
  });

  const pathD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${pts[pts.length - 1][0]} ${height - pad} L ${pts[0][0]} ${height - pad} Z`;
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
    >
      <defs>
        <linearGradient id="spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill="url(#spark-grad)" />
      <path
        ref={ref}
        d={pathD}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          strokeDasharray: drawn ? '1000 0' : '1000 1000',
          strokeDashoffset: drawn ? 0 : 1000,
          transition: 'stroke-dashoffset 1s ease-out',
        }}
      />
      <circle cx={lx} cy={ly} r="3" fill="var(--primary)" />
      <circle cx={lx} cy={ly} r="6" fill="var(--primary)" opacity="0.2" />
    </svg>
  );
}
