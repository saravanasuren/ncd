import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';

interface SettingView {
  key: string;
  group: string;
  label: string;
  description: string;
  type: string;
  value: unknown;
  options?: string[];
  editableBy: string;
}

/** Admin → Settings (docs/07). Grouped cards, typed editors, save per card. */
export function SettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ groups: Record<string, SettingView[]> }>('/api/settings'),
  });

  const save = useMutation({
    mutationFn: (v: { key: string; value: unknown }) => api.put(`/api/settings/${v.key}`, { value: v.value }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (isLoading) return <div className="text-text-muted">Loading settings…</div>;
  if (error) return <div className="text-danger">Failed to load settings.</div>;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Settings</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">
        Every business value is editable here — no hardcoded numbers anywhere.
      </p>
      {Object.entries(data!.groups).map(([group, items]) => (
        <section key={group} className="mb-6">
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">{group}</h2>
          <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
            {items.map((s) => (
              <SettingRow key={s.key} s={s} onSave={(value) => save.mutate({ key: s.key, value })} saving={save.isPending} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SettingRow({ s, onSave, saving }: { s: SettingView; onSave: (v: unknown) => void; saving: boolean }) {
  const [val, setVal] = useState<unknown>(s.value);
  const [err, setErr] = useState('');
  const dirty = JSON.stringify(val) !== JSON.stringify(s.value);

  function submit() {
    setErr('');
    try {
      onSave(val);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    }
  }

  return (
    <div className="p-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{s.label}</div>
        <div className="text-xs text-text-muted">{s.description}</div>
        <div className="mt-1 text-[11px] text-text-muted font-mono">{s.key}</div>
        {err && <div className="text-xs text-danger mt-1">{err}</div>}
      </div>
      <div className="flex items-center gap-2">
        <Editor s={s} val={val} setVal={setVal} />
        <button disabled={!dirty || saving} onClick={submit}
          className="text-xs bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-3 py-1.5">
          Save
        </button>
      </div>
    </div>
  );
}

function Editor({ s, val, setVal }: { s: SettingView; val: unknown; setVal: (v: unknown) => void }) {
  const cls = 'px-2 py-1 text-sm border border-border-strong rounded outline-none focus:border-primary';
  if (s.type === 'enum') {
    return (
      <select className={cls} value={String(val)} onChange={(e) => setVal(e.target.value)}>
        {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (s.type === 'number') {
    return <input className={`${cls} w-24`} type="number" value={Number(val)} onChange={(e) => setVal(Number(e.target.value))} />;
  }
  if (s.type === 'boolean') {
    return <input type="checkbox" checked={!!val} onChange={(e) => setVal(e.target.checked)} />;
  }
  if (s.type === 'rate') {
    const r = val as { mode: string; value: number };
    return (
      <div className="flex items-center gap-1">
        <input className={`${cls} w-20`} type="number" step="0.01" value={r.value}
          onChange={(e) => setVal({ ...r, value: Number(e.target.value) })} />
        <select className={cls} value={r.mode} onChange={(e) => setVal({ ...r, mode: e.target.value })}>
          <option value="pct">%</option>
          <option value="flat">₹ flat</option>
        </select>
      </div>
    );
  }
  if (s.type === 'list') {
    return <ListEditor val={(val as string[]) ?? []} setVal={setVal} />;
  }
  return <input className={`${cls} w-48`} value={String(val)} onChange={(e) => setVal(e.target.value)} />;
}

/** Add/remove-option editor for `list` settings (dropdown vocabularies). */
function ListEditor({ val, setVal }: { val: string[]; setVal: (v: string[]) => void }) {
  const [add, setAdd] = useState('');
  function addItem() {
    const v = add.trim();
    if (v && !val.includes(v)) setVal([...val, v]);
    setAdd('');
  }
  return (
    <div className="flex flex-col gap-1.5 w-72">
      <div className="flex flex-wrap gap-1">
        {val.length === 0 && <span className="text-xs text-text-muted italic">No options yet</span>}
        {val.map((o) => (
          <span key={o} className="inline-flex items-center gap-1 text-xs bg-bg border border-border rounded px-1.5 py-0.5">
            {o}
            <button type="button" onClick={() => setVal(val.filter((x) => x !== o))}
              className="text-text-muted hover:text-danger leading-none" aria-label={`Remove ${o}`}>✕</button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <input className="px-2 py-1 text-xs border border-border-strong rounded flex-1 min-w-0 outline-none focus:border-primary"
          placeholder="Add option…" value={add} onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }} />
        <button type="button" onClick={addItem} disabled={!add.trim()}
          className="text-xs bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-2 py-1 whitespace-nowrap">
          + Add
        </button>
      </div>
    </div>
  );
}
