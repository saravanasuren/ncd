/** Lightweight tab strip (matches the Segments tabs). Optional per-tab count. */
export interface TabDef<T extends string> {
  key: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: TabDef<T>[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex gap-1 mb-4 border-b border-border overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
            active === t.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-text-muted hover:text-text'
          }`}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 text-xs text-text-muted">({t.count})</span>}
        </button>
      ))}
    </div>
  );
}
