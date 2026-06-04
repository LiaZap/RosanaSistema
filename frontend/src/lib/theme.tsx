import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';
type Direction = 'cedro' | 'indigo' | 'brasa';

interface ThemeCtx {
  theme: Theme;
  dir: Direction;
  setTheme: (t: Theme) => void;
  setDir: (d: Direction) => void;
}

const ThemeContext = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = localStorage.getItem('fce-theme') as Theme | null;
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // Direcao FIXA em 'cedro' (opcoes Indigo/Brasa removidas a pedido).
  // Mantemos dir/setDir na interface pra nao quebrar imports, mas e no-op.
  const dir: Direction = 'cedro';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-dir', 'cedro');
    // Limpa preferencia antiga de direcao (caso tenha indigo/brasa salvo)
    try {
      localStorage.removeItem('fce-dir');
    } catch {
      // ignore
    }
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem('fce-theme', t);
  };
  const setDir = (_d: Direction) => {
    // no-op: direcao fixa em cedro
  };

  return (
    <ThemeContext.Provider value={{ theme, dir, setTheme, setDir }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
