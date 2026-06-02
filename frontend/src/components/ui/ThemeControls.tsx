import { useTheme } from '../../lib/theme';

const DIR_DOT = {
  cedro: 'oklch(0.50 0.075 182)',
  indigo: 'oklch(0.50 0.16 268)',
  brasa: 'oklch(0.585 0.16 36)',
} as const;

/** Segmented control de direção (cedro/indigo/brasa) */
export function DirSegment() {
  const { dir, setDir } = useTheme();
  return (
    <div className="seg" role="group" aria-label="Direção de cor">
      {(['cedro', 'indigo', 'brasa'] as const).map((d) => (
        <button
          key={d}
          aria-pressed={dir === d}
          onClick={() => setDir(d)}
          title={d.charAt(0).toUpperCase() + d.slice(1)}
        >
          <span className="dot" style={{ background: DIR_DOT[d] }} />
          <span className="capitalize">{d}</span>
        </button>
      ))}
    </div>
  );
}

/** Toggle simples claro/escuro com ícones */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="btn btn-ghost btn-sm"
      title={isDark ? 'Tema claro' : 'Tema escuro'}
      aria-label="Alternar tema"
    >
      {isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
