import { useMemo, useState } from 'react';

interface CalendarEvent {
  id: string;
  title: string;
  date: string; // ISO
  time?: string | null;
  type?: string | null;
}

interface CalendarMonthProps {
  events: CalendarEvent[];
  onEventClick?: (e: CalendarEvent) => void;
  /** Cor por tipo (CSS var) */
  typeColors?: Record<string, string>;
}

const DEFAULT_TYPE_COLORS: Record<string, string> = {
  smart_baby: 'var(--primary)',
  estilosa: 'var(--info)',
  vip: 'oklch(0.60 0.16 290)',
  concierge: 'var(--accent)',
  premium: 'var(--success)',
  visita_loja: 'var(--warning)',
  consultation: 'var(--dani)',
};

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTHS = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export function CalendarMonth({ events, onEventClick, typeColors = DEFAULT_TYPE_COLORS }: CalendarMonthProps) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const monthLabel = `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  // Calcula grid 6×7 a partir do primeiro dia da semana
  const cells = useMemo(() => {
    const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const cellList: Array<{ date: Date; current: boolean }> = [];

    // Padding início (dias do mês anterior)
    for (let i = startWeekday - 1; i >= 0; i--) {
      cellList.push({
        date: new Date(cursor.getFullYear(), cursor.getMonth(), -i),
        current: false,
      });
    }
    // Dias do mês corrente
    for (let d = 1; d <= daysInMonth; d++) {
      cellList.push({
        date: new Date(cursor.getFullYear(), cursor.getMonth(), d),
        current: true,
      });
    }
    // Padding fim
    while (cellList.length % 7 !== 0 || cellList.length < 42) {
      const last = cellList[cellList.length - 1].date;
      cellList.push({
        date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1),
        current: false,
      });
      if (cellList.length >= 42) break;
    }
    return cellList;
  }, [cursor]);

  // Index eventos por dia (YYYY-MM-DD)
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const d = new Date(ev.date);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return map;
  }, [events]);

  const today = new Date();
  const isToday = (d: Date) =>
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  function prevMonth() {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
  }
  function nextMonth() {
    setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
  }
  function goToday() {
    const now = new Date();
    setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
  }

  return (
    <div className="material p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="btn btn-secondary btn-sm w-8 h-8 p-0 grid place-items-center"
            aria-label="Mês anterior"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            onClick={nextMonth}
            className="btn btn-secondary btn-sm w-8 h-8 p-0 grid place-items-center"
            aria-label="Próximo mês"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <h3 className="text-lg font-bold ml-2" style={{ color: 'var(--text-1)' }}>
            {monthLabel}
          </h3>
        </div>
        <button onClick={goToday} className="btn btn-ghost btn-sm">
          Hoje
        </button>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-px mb-1">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="text-center text-xs font-semibold py-2 font-mono"
            style={{ color: 'var(--text-3)', letterSpacing: '.06em' }}
          >
            {d.toUpperCase()}
          </div>
        ))}
      </div>

      {/* Grid 6×7 */}
      <div className="grid grid-cols-7 gap-px" style={{ background: 'var(--border)' }}>
        {cells.map(({ date, current }, i) => {
          const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
          const dayEvents = eventsByDay.get(key) ?? [];
          const isCurrentDay = isToday(date);
          return (
            <div
              key={i}
              className="min-h-[88px] p-1.5 relative flex flex-col gap-1"
              style={{
                background: 'var(--bg-surface)',
                opacity: current ? 1 : 0.4,
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-xs ${isCurrentDay ? 'font-bold' : 'font-medium'}`}
                  style={{
                    color: isCurrentDay ? 'var(--primary-text)' : 'var(--text-2)',
                  }}
                >
                  {isCurrentDay ? (
                    <span
                      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px]"
                      style={{
                        background: 'var(--primary)',
                        color: 'var(--text-on-primary)',
                      }}
                    >
                      {date.getDate()}
                    </span>
                  ) : (
                    date.getDate()
                  )}
                </span>
              </div>
              <div className="flex-1 space-y-0.5 overflow-hidden">
                {dayEvents.slice(0, 3).map((ev) => (
                  <button
                    key={ev.id}
                    onClick={() => onEventClick?.(ev)}
                    className="w-full text-left rounded px-1.5 py-0.5 text-[10px] font-medium truncate transition-opacity hover:opacity-80"
                    style={{
                      background: `color-mix(in oklch, ${typeColors[ev.type ?? 'consultation'] ?? 'var(--primary)'} 18%, transparent)`,
                      color: typeColors[ev.type ?? 'consultation'] ?? 'var(--primary)',
                      borderLeft: `2px solid ${typeColors[ev.type ?? 'consultation'] ?? 'var(--primary)'}`,
                    }}
                    title={`${ev.time ?? ''} ${ev.title}`}
                  >
                    {ev.time && <span className="font-mono opacity-70">{ev.time}</span>}{' '}
                    <span>{ev.title}</span>
                  </button>
                ))}
                {dayEvents.length > 3 && (
                  <div className="text-[10px] font-medium px-1" style={{ color: 'var(--text-3)' }}>
                    +{dayEvents.length - 3} mais
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
