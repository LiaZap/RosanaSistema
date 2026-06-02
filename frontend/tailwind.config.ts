import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tokens FCE Design System v1.0 (OKLCH via CSS vars)
        'bg-app':         'var(--bg-app)',
        'bg-surface':     'var(--bg-surface)',
        'bg-subtle':      'var(--bg-subtle)',
        'bg-sunken':      'var(--bg-sunken)',
        'border-strong':  'var(--border-strong)',
        'text-1':         'var(--text-1)',
        'text-2':         'var(--text-2)',
        'text-3':         'var(--text-3)',
        'text-on-primary': 'var(--text-on-primary)',
        'primary-hover':  'var(--primary-hover)',
        'primary-press':  'var(--primary-press)',
        'primary-tint':   'var(--primary-tint)',
        'primary-tint-2': 'var(--primary-tint-2)',
        'primary-text':   'var(--primary-text)',
        'accent-tint':    'var(--accent-tint)',
        'success':        'var(--success)',
        'success-bg':     'var(--success-bg)',
        'warning':        'var(--warning)',
        'warning-bg':     'var(--warning-bg)',
        'danger':         'var(--danger)',
        'danger-bg':      'var(--danger-bg)',
        'info':           'var(--info)',
        'info-bg':        'var(--info-bg)',
        'dani':           'var(--dani)',
        'dani-2':         'var(--dani-2)',
        'dani-bg':        'var(--dani-bg)',
        'dani-text':      'var(--dani-text)',

        // Shadcn compat
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--text-on-primary)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },

        // Stage colors (mantidos pra Pipeline)
        'stage-new':         'var(--info)',
        'stage-qualified':   'var(--warning)',
        'stage-opportunity': 'oklch(0.60 0.16 290)',
        'stage-closing':     'var(--primary)',
        'stage-won':         'var(--success)',
        'stage-lost':        'var(--danger)',

        // Legacy FCE (mantém pra páginas antigas)
        fce: {
          pink: 'var(--primary)',
          'pink-dark': 'var(--primary-press)',
          green: 'var(--success)',
          red: 'var(--danger)',
        },
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xs: 'var(--r-xs)',
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
      },
      boxShadow: {
        sm: 'var(--sh-sm)',
        md: 'var(--sh-md)',
        lg: 'var(--sh-lg)',
        focus: 'var(--sh-focus)',
        glow: '0 0 24px -4px var(--primary-ring)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'pop': {
          from: { opacity: '0', transform: 'scale(.96)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-up': 'fade-up .34s cubic-bezier(.2,.7,.3,1)',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'pulse-dot': 'pulse-dot 1.4s ease-in-out infinite',
        'pop': 'pop .2s cubic-bezier(.2,.7,.3,1) both',
      },
    },
  },
  plugins: [],
};

export default config;
