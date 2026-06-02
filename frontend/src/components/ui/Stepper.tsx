interface StepperProps {
  steps: string[];
  current: number; // 0-based
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <div className="flex items-center pt-1">
      {steps.map((label, i) => {
        const isDone = i < current;
        const isCurrent = i === current;
        return (
          <div key={label} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-2 flex-none">
              <span
                className="w-[38px] h-[38px] rounded-full grid place-items-center border-[1.5px]"
                style={
                  isDone
                    ? {
                        background: 'var(--primary-tint)',
                        color: 'var(--primary-text)',
                        borderColor: 'color-mix(in oklch, var(--primary) 35%, var(--border))',
                      }
                    : isCurrent
                      ? {
                          background: 'var(--primary)',
                          color: 'var(--text-on-primary)',
                          borderColor: 'var(--primary)',
                          boxShadow: 'var(--sh-focus)',
                        }
                      : {
                          background: 'var(--bg-subtle)',
                          color: 'var(--text-3)',
                          borderColor: 'var(--border)',
                        }
                }
              >
                {isDone ? (
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
                    <path d="M5 12l5 5L20 6" />
                  </svg>
                ) : (
                  <span className="text-sm font-semibold">{i + 1}</span>
                )}
              </span>
              <span
                className="text-xs font-medium whitespace-nowrap"
                style={{
                  color: isCurrent || isDone ? 'var(--text-1)' : 'var(--text-3)',
                  fontWeight: isCurrent ? 700 : 600,
                }}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                className="flex-1 h-[2px] mx-2.5 -mt-6 rounded"
                style={{ background: isDone ? 'var(--primary)' : 'var(--border)' }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
