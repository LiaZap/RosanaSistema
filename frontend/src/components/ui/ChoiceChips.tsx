interface Choice {
  value: string;
  label: string;
  desc?: string;
}

interface ChoiceChipsProps {
  choices: Choice[];
  value: string;
  onChange: (v: string) => void;
}

export function ChoiceChips({ choices, value, onChange }: ChoiceChipsProps) {
  return (
    <div className="flex gap-2.5 flex-wrap">
      {choices.map((c) => {
        const sel = c.value === value;
        return (
          <button
            key={c.value}
            onClick={() => onChange(c.value)}
            className="flex-1 min-w-[150px] text-left p-3.5 rounded-md border-[1.5px] transition-all"
            style={
              sel
                ? {
                    background: 'var(--primary-tint)',
                    borderColor: 'var(--primary)',
                    boxShadow: 'var(--sh-focus)',
                  }
                : {
                    background: 'var(--bg-surface)',
                    borderColor: 'var(--border)',
                  }
            }
          >
            <div
              className="text-sm font-bold"
              style={{ color: sel ? 'var(--primary-text)' : 'var(--text-1)' }}
            >
              {c.label}
            </div>
            {c.desc && (
              <div className="text-xs mt-1" style={{ color: 'var(--text-3)' }}>
                {c.desc}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
