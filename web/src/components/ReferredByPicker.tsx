import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

interface Payee { kind: 'agent' | 'staff'; id: number; code: string | null; full_name: string }

/**
 * Referred-by combo: searchable agent/staff dropdown, free text still allowed.
 * Picking a payee stores their CODE (falls back to the name when they have none),
 * which is what the attribution engine matches on. Shared by the enrol wizard and
 * the approval review so both offer the same list.
 */
export function ReferredByPicker({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const q = value.trim();
  const search = useQuery({
    queryKey: ['payee-search', q],
    queryFn: () => api.get<{ rows: Payee[] }>(`/api/agents/payee-search?q=${encodeURIComponent(q)}`),
    enabled: open && q.length >= 2,
  });
  const rows = search.data?.rows ?? [];
  return (
    <span className="relative block">
      <input className={className ?? 'w-full px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary'}
        value={value} placeholder="Code or name…"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && rows.length > 0 && (
        <span className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded shadow-card z-20 block max-h-44 overflow-auto">
          {rows.map((r) => (
            <button key={`${r.kind}-${r.id}`} type="button" className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg block"
              onMouseDown={(e) => { e.preventDefault(); onChange(r.code || r.full_name); setOpen(false); }}>
              {r.full_name} <span className="font-mono text-text-muted">{r.code ?? ''}</span>
              <span className={`float-right text-[10px] rounded px-1 ${r.kind === 'staff' ? 'bg-bg' : 'bg-[color:var(--warn-bg)]'}`}>{r.kind}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
