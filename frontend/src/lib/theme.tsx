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

  const [dir, setDirState] = useState<Direction>(() => {
    if (typeof window === 'undefined') return 'cedro';
    const saved = localStorage.getItem('fce-dir') as Direction | null;
    if (saved === 'cedro' || saved === 'indigo' || saved === 'brasa') return saved;
    return 'cedro';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-dir', dir);
  }, [dir]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem('fce-theme', t);
  };
  const setDir = (d: Direction) => {
    setDirState(d);
    localStorage.setItem('fce-dir', d);
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
