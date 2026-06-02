import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../../lib/theme';

interface Cmd {
  id: string;
  label: string;
  desc?: string;
  group: 'Navegar' | 'Integrações' | 'Conta' | 'Preferências';
  icon?: string;
  action: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { setTheme, setDir } = useTheme();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const cmds: Cmd[] = useMemo(
    () => [
      { id: 'nav-dash', label: 'Dashboard', desc: 'Visão geral e KPIs', group: 'Navegar', icon: '◫', action: () => navigate('/dashboard') },
      { id: 'nav-conv', label: 'Conversas', desc: 'Inbox WhatsApp', group: 'Navegar', icon: '◉', action: () => navigate('/conversations') },
      { id: 'nav-pipe', label: 'Pipeline', desc: 'Kanban de vendas', group: 'Navegar', icon: '▤', action: () => navigate('/pipeline') },
      { id: 'nav-appt', label: 'Agendamentos', desc: 'Calendário de visitas', group: 'Navegar', icon: '⌚', action: () => navigate('/appointments') },
      { id: 'nav-agent', label: 'Configuração da Dani', desc: 'Identidade, prompt, modelo', group: 'Navegar', icon: '✦', action: () => navigate('/agent') },
      { id: 'nav-know', label: 'Base de conhecimento', desc: 'Chunks RAG da DANI', group: 'Navegar', icon: '▦', action: () => navigate('/knowledge') },
      { id: 'nav-lib', label: 'Biblioteca', desc: 'PDFs / vídeos / áudios', group: 'Navegar', icon: '☁', action: () => navigate('/library') },
      { id: 'nav-test', label: 'Teste de chat', desc: 'Conversar com a Dani', group: 'Navegar', icon: '☼', action: () => navigate('/dani') },
      { id: 'int-wa', label: 'WhatsApp', desc: 'Evolution API', group: 'Integrações', icon: '✉', action: () => navigate('/whatsapp') },
      { id: 'int-bling', label: 'Bling ERP', desc: 'Catálogo + estoque', group: 'Integrações', icon: '⊞', action: () => navigate('/bling') },
      { id: 'int-cloud', label: 'Cloudinary', desc: 'Imagens', group: 'Integrações', icon: '☁', action: () => navigate('/cloudinary') },
      { id: 'pref-light', label: 'Tema claro', group: 'Preferências', icon: '☀', action: () => setTheme('light') },
      { id: 'pref-dark', label: 'Tema escuro', group: 'Preferências', icon: '☾', action: () => setTheme('dark') },
      { id: 'pref-cedro', label: 'Direção Cedro', desc: 'Verde-petróleo + argila', group: 'Preferências', icon: '●', action: () => setDir('cedro') },
      { id: 'pref-indigo', label: 'Direção Índigo', desc: 'Índigo + âmbar', group: 'Preferências', icon: '●', action: () => setDir('indigo') },
      { id: 'pref-brasa', label: 'Direção Brasa', desc: 'Coral + ouro', group: 'Preferências', icon: '●', action: () => setDir('brasa') },
    ],
    [navigate, setTheme, setDir],
  );

  // Filtro fuzzy: todos os termos devem bater
  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return cmds;
    return cmds.filter((c) => {
      const blob = `${c.label} ${c.desc ?? ''} ${c.group}`.toLowerCase();
      return terms.every((t) => blob.includes(t));
    });
  }, [cmds, q]);

  // Agrupa
  const grouped = useMemo(() => {
    const map = new Map<string, Cmd[]>();
    for (const c of filtered) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group)!.push(c);
    }
    return Array.from(map.entries());
  }, [filtered]);

  // Keyboard
  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[sel];
        if (cmd) {
          cmd.action();
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, sel, onClose]);

  if (!open) return null;

  let runningIdx = -1;
  return (
    <div className="cmdk-scrim" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        {/* Search */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ color: 'var(--text-3)' }}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder="Buscar comando ou tela…"
            className="flex-1 bg-transparent border-0 outline-none text-[15px]"
            style={{ color: 'var(--text-1)' }}
          />
          <span className="kbd">ESC</span>
        </div>

        {/* List */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {grouped.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-3)' }}>
              Nada encontrado
            </div>
          ) : (
            grouped.map(([groupName, items]) => (
              <div key={groupName}>
                <div className="section-title px-4 py-2 mt-1">{groupName}</div>
                {items.map((c) => {
                  runningIdx++;
                  const isSel = runningIdx === sel;
                  return (
                    <button
                      key={c.id}
                      onClick={() => {
                        c.action();
                        onClose();
                      }}
                      onMouseEnter={() => setSel(runningIdx)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                      style={{
                        background: isSel ? 'var(--primary-tint)' : 'transparent',
                        color: isSel ? 'var(--primary-text)' : 'var(--text-1)',
                      }}
                    >
                      <span
                        className="w-7 h-7 rounded-md flex items-center justify-center text-xs"
                        style={{
                          background: isSel ? 'var(--primary)' : 'var(--bg-subtle)',
                          color: isSel ? 'var(--text-on-primary)' : 'var(--text-2)',
                        }}
                      >
                        {c.icon ?? '·'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{c.label}</div>
                        {c.desc && (
                          <div className="text-[11.5px] truncate" style={{ color: 'var(--text-3)' }}>
                            {c.desc}
                          </div>
                        )}
                      </div>
                      {isSel && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-[11.5px]" style={{ color: 'var(--text-3)' }}>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5"><span className="kbd">↑↓</span> navegar</span>
            <span className="flex items-center gap-1.5"><span className="kbd">↵</span> abrir</span>
          </div>
          <span className="font-semibold" style={{ color: 'var(--text-2)' }}>
            FCE Studio
          </span>
        </div>
      </div>
    </div>
  );
}

/** Hook que escuta ⌘K / Ctrl+K global */
export function useCmdK(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpen]);
}
