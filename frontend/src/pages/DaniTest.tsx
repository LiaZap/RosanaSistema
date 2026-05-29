import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface ChatTurn {
  role: 'user' | 'model';
  text: string;
  meta?: { modelMode: string; durationMs: number; fillerStripped: boolean };
}

export default function DaniTestPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        setMe(data);
        if (data.accounts[0]) setAccountId(data.accounts[0].accountId);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
      });
  }, [navigate]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !accountId || sending) return;
    const userText = input.trim();
    setInput('');
    setError(null);

    const newTurns: ChatTurn[] = [...turns, { role: 'user', text: userText }];
    setTurns(newTurns);
    setSending(true);

    try {
      const history = turns.map((t) => ({ role: t.role, text: t.text }));
      const res = await api.post<{
        reply: string;
        meta: { modelMode: string; durationMs: number; fillerStripped: boolean };
      }>('/dani/chat', { accountId, message: userText, history });

      setTurns([...newTurns, { role: 'model', text: res.reply, meta: res.meta }]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Erro desconhecido';
      setError(msg);
      // Remove a mensagem do user pra deixar tentar de novo
      setTurns(turns);
    } finally {
      setSending(false);
    }
  }

  function handleReset() {
    setTurns([]);
    setError(null);
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">D</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">DANI - Teste</h1>
              <p className="text-sm text-muted-foreground">
                {me?.accounts[0]?.accountName ?? 'Conta'}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleReset}
              className="px-3 py-2 rounded-lg border border-border text-sm
                         text-muted-foreground hover:bg-card transition-colors"
            >
              Limpar
            </button>
            <Link
              to="/dashboard"
              className="px-3 py-2 rounded-lg border border-border text-sm
                         text-muted-foreground hover:bg-card transition-colors"
            >
              Voltar
            </Link>
          </div>
        </div>

        {/* Chat */}
        <div className="glass rounded-xl p-5 min-h-[400px] max-h-[60vh] overflow-y-auto space-y-3">
          {turns.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-12">
              Mande uma mensagem pra DANI testar o orchestrator
            </p>
          )}
          {turns.map((t, i) => (
            <div
              key={i}
              className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  t.role === 'user'
                    ? 'gradient-pink text-white'
                    : 'bg-card border border-border text-foreground'
                }`}
              >
                {t.text}
                {t.meta && (
                  <div className="mt-1.5 pt-1.5 border-t border-white/10 text-[10px] opacity-60">
                    {t.meta.modelMode} · {t.meta.durationMs}ms
                    {t.meta.fillerStripped ? ' · filler stripped' : ''}
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-card border border-border rounded-xl px-4 py-2.5 text-sm text-muted-foreground">
                ...
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && (
          <div className="rounded-lg border border-fce-red/40 bg-fce-red/10 p-3 text-sm text-fce-red">
            {error}
          </div>
        )}

        {/* Input */}
        <form onSubmit={handleSend} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending || !accountId}
            placeholder="Oi DANI, queria ver os precos do Windi..."
            className="flex-1 px-4 py-3 rounded-lg bg-card border border-border
                       text-foreground placeholder:text-muted-foreground
                       focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || !accountId}
            className="px-6 py-3 rounded-lg gradient-pink text-white font-semibold
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
