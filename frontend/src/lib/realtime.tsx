import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface FceToast {
  id: string;
  type: 'success' | 'info' | 'warning';
  title: string;
  description?: string;
  url?: string;
}

interface RealtimeCtx {
  toasts: FceToast[];
  dismiss: (id: string) => void;
  notify: (toast: Omit<FceToast, 'id'>) => void;
}

const RealtimeContext = createContext<RealtimeCtx | null>(null);

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<FceToast[]>([]);

  function notify(toast: Omit<FceToast, 'id'>) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((arr) => [...arr, { ...toast, id }]);
    // Notification API (se permitido)
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(toast.title, { body: toast.description, icon: '/icon-192.png' });
      } catch {
        // ignore
      }
    }
    // Auto-dismiss em 6s
    setTimeout(() => {
      setToasts((arr) => arr.filter((t) => t.id !== id));
    }, 6000);
  }

  function dismiss(id: string) {
    setToasts((arr) => arr.filter((t) => t.id !== id));
  }

  // Pede permissão de notificação na primeira visita
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // SSE: subscreve eventos quando user/account disponível
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // M16: o provider monta 1x (deps []) e na tela /auth o user esta
    // deslogado -> /auth/me falha -> sem SSE. Login e navigate(), nao reload,
    // entao o effect nao re-roda. Aqui reagendamos a conexao ate logar.
    function scheduleRetry() {
      if (cancelled || es) return;
      retryTimer = setTimeout(connect, 5000);
    }

    async function connect() {
      try {
        const me = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
        if (!me.ok) {
          scheduleRetry();
          return;
        }
        const data = (await me.json()) as { accounts?: Array<{ accountId: string }> };
        const accountId = data.accounts?.[0]?.accountId;
        if (cancelled) return;
        if (!accountId) {
          scheduleRetry();
          return;
        }

        const url = `${API_BASE}/events/stream?accountId=${accountId}`;
        es = new EventSource(url, { withCredentials: true });

        es.addEventListener('deal:created', (e) => {
          const ev = JSON.parse((e as MessageEvent).data) as {
            title: string;
            dealId: string;
            byAi: boolean;
          };
          notify({
            type: 'success',
            title: ev.byAi ? '✦ Novo lead da DANI' : 'Novo deal criado',
            description: ev.title,
            url: '/pipeline',
          });
        });

        es.addEventListener('lead:new', (e) => {
          const ev = JSON.parse((e as MessageEvent).data) as {
            contactName: string | null;
            phone: string;
            conversationId: string;
          };
          notify({
            type: 'info',
            title: 'Novo contato',
            description: ev.contactName ?? `+${ev.phone}`,
            url: `/conversations/${ev.conversationId}`,
          });
        });

        es.addEventListener('appointment:created', (e) => {
          const ev = JSON.parse((e as MessageEvent).data) as { title: string; when: string };
          notify({
            type: 'info',
            title: '📅 Agendamento criado',
            description: `${ev.title} · ${ev.when}`,
            url: '/appointments',
          });
        });

        es.onerror = () => {
          // Auto-reconnect handled by EventSource
        };
      } catch {
        scheduleRetry();
      }
    }
    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ toasts, dismiss, notify }}>
      {children}
      <ToastContainer toasts={toasts} dismiss={dismiss} />
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used within RealtimeProvider');
  return ctx;
}

function ToastContainer({ toasts, dismiss }: { toasts: FceToast[]; dismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 10,
        maxWidth: 360,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="material lift"
          style={{
            padding: 14,
            borderLeft: `3px solid ${
              t.type === 'success'
                ? 'var(--success)'
                : t.type === 'warning'
                  ? 'var(--warning)'
                  : 'var(--info)'
            }`,
            animation: 'fadeUpToast .25s ease-out',
            cursor: t.url ? 'pointer' : 'default',
            background: 'var(--bg-surface)',
          }}
          onClick={() => {
            if (t.url) window.location.href = t.url;
            dismiss(t.id);
          }}
        >
          <div className="flex items-start gap-2.5">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                {t.title}
              </div>
              {t.description && (
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>
                  {t.description}
                </div>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                dismiss(t.id);
              }}
              style={{ color: 'var(--text-3)', border: 0, background: 'transparent', cursor: 'pointer' }}
              aria-label="Fechar"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      <style>
        {`@keyframes fadeUpToast { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }`}
      </style>
    </div>
  );
}
