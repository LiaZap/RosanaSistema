import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  profile: { fullName?: string } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// SVG icons - clean, monocromáticos
const I = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
  ),
  chat: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
  ),
  pipeline: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="18" rx="1.5" /><rect x="10" y="6" width="5" height="12" rx="1.5" /><rect x="17" y="9" width="4" height="6" rx="1.5" /></svg>
  ),
  calendar: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
  ),
  agent: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
  ),
  testTube: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2v17.5c0 1.4-1.1 2.5-2.5 2.5h0c-1.4 0-2.5-1.1-2.5-2.5V2" /><path d="M8.5 2h7" /><path d="M14.5 16h-5" /></svg>
  ),
  whatsapp: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /><path d="M9 9c0 1 .5 2 1 3" /></svg>
  ),
  bling: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14.7 14.7 0 0 1 0 18 14.7 14.7 0 0 1 0-18z" /></svg>
  ),
  cloud: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
  ),
  logout: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
  ),
  chevron: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
  ),
  menu: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
  ),
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Visao geral',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: I.dashboard }],
  },
  {
    label: 'Operacoes',
    items: [
      { to: '/conversations', label: 'Conversas', icon: I.chat },
      { to: '/pipeline', label: 'Pipeline', icon: I.pipeline },
      { to: '/appointments', label: 'Agendamentos', icon: I.calendar },
    ],
  },
  {
    label: 'DANI',
    items: [
      { to: '/agent', label: 'Configuracao', icon: I.agent },
      { to: '/dani', label: 'Teste de chat', icon: I.testTube },
    ],
  },
  {
    label: 'Integracoes',
    items: [
      { to: '/whatsapp', label: 'WhatsApp', icon: I.whatsapp },
      { to: '/bling', label: 'Bling ERP', icon: I.bling },
      { to: '/cloudinary', label: 'Cloudinary', icon: I.cloud },
    ],
  },
];

interface AppShellProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Se true, remove o padding/scroll do main pra layouts custom (ex: kanban full-width) */
  bare?: boolean;
  children: ReactNode;
}

export default function AppShell({ title, subtitle, actions, bare, children }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
      });
  }, [navigate]);

  useEffect(() => {
    // Fecha sidebar mobile ao navegar
    setMobileOpen(false);
  }, [location.pathname]);

  async function handleLogout() {
    await api.post('/auth/logout').catch(() => {});
    navigate('/auth');
  }

  const account = me?.accounts[0];

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar overlay (mobile) */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-30"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:sticky top-0 left-0 h-screen w-64 shrink-0 z-40
          bg-card/80 backdrop-blur-xl border-r border-border/60
          flex flex-col
          transition-transform duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Logo */}
        <div className="h-16 flex items-center gap-3 px-5 border-b border-border/60">
          <div className="w-9 h-9 rounded-xl gradient-pink flex items-center justify-center shrink-0">
            <span className="text-white font-bold">F</span>
          </div>
          <div className="min-w-0">
            <div className="font-bold text-foreground text-sm leading-tight">FCE</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              {account?.accountName ?? 'Filhos com Estilo'}
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="mb-5">
              <div className="px-3 mb-1.5 text-[10px] uppercase font-semibold tracking-wider text-muted-foreground">
                {section.label}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                        isActive
                          ? 'bg-fce-pink/15 text-fce-pink font-medium'
                          : 'text-muted-foreground hover:bg-card hover:text-foreground'
                      }`
                    }
                  >
                    <span className="shrink-0">{item.icon}</span>
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User mini-card */}
        {me && (
          <div className="border-t border-border/60 p-3">
            <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-card group">
              <div className="w-8 h-8 rounded-full gradient-pink flex items-center justify-center text-white text-xs font-bold shrink-0">
                {(me.profile?.fullName?.[0] ?? me.user.email[0]).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">
                  {me.profile?.fullName ?? me.user.email.split('@')[0]}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {account?.role ?? 'sem conta'}
                </div>
              </div>
              <button
                onClick={handleLogout}
                title="Sair"
                className="text-muted-foreground hover:text-fce-red opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                {I.logout}
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-16 sticky top-0 z-20 bg-background/80 backdrop-blur-xl border-b border-border/60 flex items-center px-4 lg:px-8 gap-4">
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden text-muted-foreground hover:text-foreground"
            aria-label="Menu"
          >
            {I.menu}
          </button>

          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-foreground truncate leading-tight">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>

        {/* Content */}
        {bare ? (
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">{children}</main>
        ) : (
          <main className="flex-1 overflow-y-auto">
            <div className="p-4 lg:p-8 max-w-6xl mx-auto">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}

/** Small helper components used across pages */

export function PageCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-card/40 border border-border/60 rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

export function PageSection({
  title,
  description,
  actions,
  children,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3">
          {title && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {title}
              </h2>
              {description && (
                <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
              )}
            </div>
          )}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-sm',
  }[size];

  const variantClass = {
    primary: 'gradient-pink text-white font-semibold hover:opacity-90',
    secondary: 'border border-border bg-card/30 text-foreground hover:bg-card',
    ghost: 'text-muted-foreground hover:text-foreground hover:bg-card',
    danger: 'border border-fce-red/40 text-fce-red hover:bg-fce-red/10',
  }[variant];

  return (
    <button
      {...props}
      className={`rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${sizeClass} ${variantClass} ${className}`}
    />
  );
}

export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
}: {
  to: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  children: ReactNode;
}) {
  const sizeClass = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-sm',
  }[size];

  const variantClass = {
    primary: 'gradient-pink text-white font-semibold hover:opacity-90',
    secondary: 'border border-border bg-card/30 text-foreground hover:bg-card',
    ghost: 'text-muted-foreground hover:text-foreground hover:bg-card',
    danger: 'border border-fce-red/40 text-fce-red hover:bg-fce-red/10',
  }[variant];

  return (
    <Link
      to={to}
      className={`inline-flex items-center rounded-lg transition-colors ${sizeClass} ${variantClass} ${className}`}
    >
      {children}
    </Link>
  );
}
