import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { WHATSAPP_TYPES, WHATSAPP_SETTING_PREFIX, type WhatsappTypeConfig, type WhatsappTypeDef } from '@new-wealth/shared';
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
          {group === 'WhatsApp' && (
            <p className="text-xs text-text-muted mb-2 -mt-1">
              The message <em>wording</em> is approved inside WappCloud — here you choose which approved template each
              message uses, turn it on/off, and map each variable. A blank template name falls back to the built-in default.
            </p>
          )}
          <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
            {items.map((s) => (
              s.type === 'json' && s.key.startsWith(WHATSAPP_SETTING_PREFIX)
                ? <WhatsappTemplateRow key={s.key} s={s} onSave={(value) => save.mutate({ key: s.key, value })} saving={save.isPending} />
                : <SettingRow key={s.key} s={s} onSave={(value) => save.mutate({ key: s.key, value })} saving={save.isPending} />
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

/**
 * Editor for one WhatsApp message type: approved template name, on/off, and the
 * {{n}} → data-field mapping. The available fields come from the shared registry
 * keyed off the setting's type suffix (whatsapp.tpl.<type>).
 */
function WhatsappTemplateRow({ s, onSave, saving }: { s: SettingView; onSave: (v: unknown) => void; saving: boolean }) {
  const type = s.key.slice(WHATSAPP_SETTING_PREFIX.length);
  const def = WHATSAPP_TYPES.find((d: WhatsappTypeDef) => d.type === type);
  const initial = s.value as WhatsappTypeConfig;
  const [cfg, setCfg] = useState<WhatsappTypeConfig>(initial);
  const dirty = JSON.stringify(cfg) !== JSON.stringify(s.value);
  const [testPhone, setTestPhone] = useState('');
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>('/api/settings/whatsapp/test', { type, phone: testPhone.trim() }),
    onSuccess: (r) => setTestMsg(r.ok ? { ok: true, text: `Test sent to ${testPhone.trim()}` } : { ok: false, text: r.error || 'Send failed' }),
    onError: (e) => setTestMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Send failed' }),
  });
  if (!def) return null;

  const fieldLabel = (k: string) => def.fields.find((f) => f.key === k)?.label ?? k;
  const setVar = (i: number, field: string) => setCfg({ ...cfg, variables: cfg.variables.map((v, j) => (j === i ? field : v)) });
  const removeVar = (i: number) => setCfg({ ...cfg, variables: cfg.variables.filter((_, j) => j !== i) });
  const addVar = () => setCfg({ ...cfg, variables: [...cfg.variables, def.fields[0]!.key] });

  const cls = 'px-2 py-1 text-sm border border-border-strong rounded outline-none focus:border-primary';
  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{def.label}</div>
          <div className="mt-0.5 text-[11px] text-text-muted font-mono">{s.key}</div>
        </div>
        <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          {cfg.enabled ? 'On' : 'Off'}
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-label w-28">Template name</span>
        <input className={`${cls} w-56`} value={cfg.template_name} placeholder={def.defaultTemplateName || '(none)'}
          onChange={(e) => setCfg({ ...cfg, template_name: e.target.value })} />
        <span className="text-[11px] text-text-muted">must be an approved WappCloud template</span>
      </div>

      <div className="mt-3">
        <div className="text-xs text-text-label mb-1.5">
          Variables {def.hasDocument && <span className="text-text-muted">(the PDF is attached automatically)</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          {cfg.variables.map((field, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs font-mono text-text-muted w-10">{`{{${i + 1}}}`}</span>
              <select className={cls} value={field} onChange={(e) => setVar(i, e.target.value)}>
                {def.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              <button type="button" onClick={() => removeVar(i)} className="text-text-muted hover:text-danger text-xs" aria-label={`Remove {{${i + 1}}}`}>✕</button>
            </div>
          ))}
          {cfg.variables.length === 0 && <span className="text-xs text-text-muted italic">No variables — this template takes only a name/header.</span>}
          {cfg.variables.length < def.fields.length && (
            <button type="button" onClick={addVar} className="text-xs text-primary hover:underline self-start mt-0.5">+ add variable</button>
          )}
        </div>
        <div className="mt-1 text-[11px] text-text-muted">Available: {def.fields.map((f) => fieldLabel(f.key)).join(', ')}</div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {/* Send a real sample of THIS template to a chosen number — verify wiring
            without touching a customer. Uses the saved config, so Save first if
            you just changed the name/mapping. */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-label">Send test to</span>
          <input className={`${cls} w-40`} placeholder="phone number" value={testPhone}
            onChange={(e) => { setTestPhone(e.target.value); setTestMsg(null); }} />
          <button type="button" disabled={!testPhone.trim() || test.isPending}
            onClick={() => { setTestMsg(null); test.mutate(); }}
            className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40">
            {test.isPending ? 'Sending…' : 'Send test'}
          </button>
          {testMsg && <span className={`text-xs ${testMsg.ok ? 'text-success' : 'text-danger'}`}>{testMsg.text}</span>}
        </div>
        <button disabled={!dirty || saving} onClick={() => onSave(cfg)}
          className="text-xs bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-3 py-1.5">Save</button>
      </div>
    </div>
  );
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
