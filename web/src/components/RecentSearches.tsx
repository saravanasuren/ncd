import { useState } from 'react';

/**
 * Per-box recent-search history, kept in localStorage (last `max` distinct
 * non-trivial terms, newest first). Keyed so each search box remembers its own
 * — e.g. the global header search and the customers list search don't share.
 * Reusable: call with a fresh key to add history to any other search box.
 */
export function useRecentSearches(key: string, max = 6) {
  const storageKey = `ncd:recent-search:${key}`;
  const read = (): string[] => {
    try { const v = JSON.parse(localStorage.getItem(storageKey) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
    catch { return []; }
  };
  const [recent, setRecent] = useState<string[]>(read);
  const write = (next: string[]) => { try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota / private mode — history is best-effort */ } setRecent(next); };
  const push = (term: string) => {
    const t = term.trim();
    if (t.length < 2) return;                                   // ignore blank / single-char
    write([t, ...read().filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, max));
  };
  const remove = (term: string) => write(read().filter((x) => x !== term));
  return { recent, push, remove };
}

/** Dropdown of recent searches, positioned under a `relative` search input.
 * onMouseDown (not onClick) so the pick fires BEFORE the input's blur closes it. */
export function RecentSearches({ items, onPick, onRemove }: {
  items: string[]; onPick: (term: string) => void; onRemove: (term: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded-lg shadow-card z-20 overflow-hidden">
      <div className="px-3 py-1 text-[11px] text-text-muted uppercase tracking-wide">Recent searches</div>
      {items.map((t) => (
        <div key={t} className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg">
          <button type="button" className="flex-1 text-left text-sm truncate" onMouseDown={(e) => { e.preventDefault(); onPick(t); }}>
            <span className="text-text-muted mr-1.5">↩</span>{t}
          </button>
          <button type="button" className="text-text-muted hover:text-danger text-sm leading-none shrink-0" aria-label={`Remove ${t}`}
            onMouseDown={(e) => { e.preventDefault(); onRemove(t); }}>×</button>
        </div>
      ))}
    </div>
  );
}
