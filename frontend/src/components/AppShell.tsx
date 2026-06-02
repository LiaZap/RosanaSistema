import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { CommandPalette, useCmdK } from './ui/CommandPalette';
import { DirSegment, ThemeToggle } from './ui/ThemeControls';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  profile: { fullName?: string } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Se true, esta entrada so aparece pra owner/admin/superadmin (AX) */
  adminOnly?: boolean;
  /** Se true, so aparece pra isSuperAdmin */
  superAdminOnly?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
  /** Se true, secao inteira so aparece pra admin */
  adminOnly?: boolean;
  /** Se true, secao inteira so aparece pra superAdmin */
  superAdminOnly?: boolean;
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
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
  ),
  users: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
  ),
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Visao geral',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: I.dashboard },
      { to: '/onboarding', label: 'Onboarding', icon: I.testTube, adminOnly: true },
    ],
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
    adminOnly: true,
    items: [
      { to: '/agent', label: 'Configuracao', icon: I.agent, adminOnly: true },
      { to: '/knowledge', label: 'Base de conhecimento', icon: I.dashboard, adminOnly: true },
      { to: '/library', label: 'Biblioteca', icon: I.cloud, adminOnly: true },
      { to: '/dani', label: 'Teste de chat', icon: I.testTube, adminOnly: true },
    ],
  },
  {
    label: 'Integracoes',
    adminOnly: true,
    items: [
      { to: '/whatsapp', label: 'WhatsApp', icon: I.whatsapp, adminOnly: true },
      { to: '/bling', label: 'Bling ERP', icon: I.bling, adminOnly: true },
      { to: '/cloudinary', label: 'Cloudinary', icon: I.cloud, adminOnly: true },
    ],
  },
  {
    label: 'Super Admin',
    superAdminOnly: true,
    items: [
      { to: '/admin/users', label: 'Usuarios & Logins', icon: I.users, superAdminOnly: true },
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
  const [cmdkOpen, setCmdkOpen] = useState(false);

  useCmdK(() => setCmdkOpen(true));

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

  // Admin = super admin OU owner/admin no account ativo
  // Cliente final (Rosana) = manager/sdr → ve so o basico
  const isSuperAdmin = !!me?.user.isSuperAdmin;
  const isAdmin =
    !!me &&
    (isSuperAdmin ||
      (account?.role === 'owner' || account?.role === 'admin'));

  // Enquanto carrega o /me, esconde itens admin pra evitar flash
  const visibleSections = NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (item.superAdminOnly) return isSuperAdmin;
        if (item.adminOnly) return isAdmin;
        return true;
      }),
    }))
    .filter((section) => {
      if (section.superAdminOnly) return isSuperAdmin && section.items.length > 0;
      if (section.adminOnly) return isAdmin && section.items.length > 0;
      return section.items.length > 0;
    });

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
          fixed lg:sticky top-0 left-0 h-screen w-60 shrink-0 z-40
          bg-card border-r border-border
          flex flex-col
          transition-transform duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
      >
        {/* Logo */}
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-border">
          <div className="w-7 h-7 rounded-md gradient-pink flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm">F</span>
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-foreground text-sm leading-tight">FCE</div>
            <div className="text-[10px] text-muted-foreground truncate">
              {account?.accountName ?? 'Filhos com Estilo'}
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {visibleSections.map((section) => (
            <div key={section.label} className="mb-4">
              <div className="px-2.5 mb-1 text-[10px] uppercase font-semibold tracking-wider text-muted-foreground/70">
                {section.label}
              </div>
              <div className="space-y-px">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition-colors relative ${
                        isActive
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-r" />
                        )}
                        <span className={`shrink-0 ${isActive ? 'text-primary' : ''}`}>
                          {item.icon}
                        </span>
                        <span>{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* User mini-card (clica pra perfil) */}
        {me && (
          <div className="border-t border-border p-2">
            <Link
              to="/perfil"
              className="flex items-center gap-2.5 p-2 rounded-md hover:bg-muted group transition-colors no-underline"
            >
              <div className="w-7 h-7 rounded-full bg-secondary border border-border flex items-center justify-center text-foreground text-[11px] font-semibold shrink-0">
                {(me.profile?.fullName?.[0] ?? me.user.email[0]).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">
                  {me.profile?.fullName ?? me.user.email.split('@')[0]}
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {account?.role ?? 'sem conta'} · workspace
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleLogout();
                }}
                title="Sair"
                className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              >
                {I.logout}
              </button>
            </Link>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-14 sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border flex items-center px-4 lg:px-6 gap-3">
          {/* Mobile menu button */}
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden text-muted-foreground hover:text-foreground"
            aria-label="Menu"
          >
            {I.menu}
          </button>

          <div className="flex-1 min-w-0">
            <h1 className="text-[15px] font-semibold text-foreground truncate leading-tight">
              {title}
            </h1>
            {subtitle && (
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">{subtitle}</p>
            )}
          </div>

          {/* Controles globais: ⌘K + direção + tema */}
          <div className="hidden md:flex items-center gap-2 shrink-0">
            <button
              onClick={() => setCmdkOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-bg-subtle hover:bg-bg-surface transition-colors text-xs text-text-2"
              title="Abrir comandos (⌘K)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <span className="font-medium">Comandos</span>
              <span className="kbd">⌘K</span>
            </button>
            <DirSegment />
            <ThemeToggle />
          </div>

          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>

        {/* Command Palette */}
        <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />

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
    <div className={`card-base p-5 ${className}`}>
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
