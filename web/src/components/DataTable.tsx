import { Fragment, useMemo, useState, type ReactNode } from 'react';

/**
 * One reusable table for the whole app. Every column is sortable (click the
 * header — numeric-aware) and filterable (a per-column text box). Styling
 * matches the reports.dhanamfinance.com look already used across pages.
 */
export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right' | 'center';
  /** default true */
  sortable?: boolean;
  /** default true */
  filterable?: boolean;
  /** Value used for sorting + filtering. Defaults to (row as any)[key]. */
  value?: (row: T) => string | number | null | undefined;
  /** Display cell. Defaults to the value. */
  render?: (row: T) => ReactNode;
  thClassName?: string;
  tdClassName?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  empty?: string;
  /** Extra classes for the wrapping card. */
  className?: string;
  /** Optional full-width content under a row (e.g. a notes panel). Return null to collapse. */
  renderExpanded?: (row: T) => ReactNode;
  /** Optional DOM id for a row's <tr> (e.g. to scrollIntoView on deep-link). */
  rowId?: (row: T) => string;
}

const rawValue = <T,>(col: Column<T>, row: T): string | number | null | undefined =>
  col.value ? col.value(row) : (row as Record<string, unknown>)[col.key] as string | number | null | undefined;

/** Coerce to a comparable number if it looks numeric (strips ₹, commas, %). */
function asNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[₹,%\s]/g, '');
  if (s === '' || Number.isNaN(Number(s))) return null;
  return Number(s);
}

export function DataTable<T>({ columns, rows, rowKey, defaultSort, empty, className, renderExpanded, rowId }: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSort?.key ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSort?.dir ?? 'asc');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);

  const colByKey = useMemo(() => {
    const m: Record<string, Column<T>> = {};
    for (const c of columns) m[c.key] = c;
    return m;
  }, [columns]);

  const view = useMemo(() => {
    let out = rows;

    // filter (case-insensitive substring on each active column filter)
    const active = Object.entries(filters).filter(([, v]) => v.trim() !== '');
    if (active.length) {
      out = out.filter((row) =>
        active.every(([key, needle]) => {
          const col = colByKey[key];
          if (!col) return true;
          const v = rawValue(col, row);
          return String(v ?? '').toLowerCase().includes(needle.trim().toLowerCase());
        })
      );
    }

    // sort
    if (sortKey && colByKey[sortKey]) {
      const col = colByKey[sortKey];
      const dir = sortDir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const va = rawValue(col, a);
        const vb = rawValue(col, b);
        const na = asNumber(va);
        const nb = asNumber(vb);
        if (na != null && nb != null) return (na - nb) * dir;
        // nulls last regardless of direction
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
      });
    }
    return out;
  }, [rows, filters, sortKey, sortDir, colByKey]);

  const onHeaderClick = (col: Column<T>) => {
    if (col.sortable === false) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
  };

  const anyFilterable = columns.some((c) => c.filterable !== false);
  const alignCls = (a?: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');

  return (
    <div className={`bg-surface border border-border rounded-lg shadow-card overflow-hidden ${className ?? ''}`}>
      {anyFilterable && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-bg/40">
          <span className="text-xs text-text-muted">{view.length} of {rows.length}</span>
          <button
            type="button"
            onClick={() => { setShowFilters((s) => !s); if (showFilters) setFilters({}); }}
            className="text-xs text-primary hover:underline"
          >
            {showFilters ? 'Clear filters' : 'Filter'}
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold text-text-label border-b border-border">
              {columns.map((col) => {
                const sortable = col.sortable !== false;
                const active = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => onHeaderClick(col)}
                    className={`px-4 py-2.5 ${alignCls(col.align)} ${sortable ? 'cursor-pointer select-none hover:text-text' : ''} ${col.thClassName ?? ''}`}
                    aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {sortable && (
                        <span className={`text-[10px] ${active ? 'text-primary' : 'text-border-strong'}`}>
                          {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
            {showFilters && (
              <tr className="border-b border-border bg-bg/40">
                {columns.map((col) => (
                  <th key={col.key} className="px-2 py-1.5">
                    {col.filterable !== false ? (
                      <input
                        value={filters[col.key] ?? ''}
                        onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
                        placeholder="Filter…"
                        className="w-full min-w-0 rounded border border-border px-2 py-1 text-xs font-normal focus:outline-none focus:ring-2 focus:ring-[color:var(--primary-ring)]"
                      />
                    ) : null}
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody className="divide-y divide-border">
            {view.map((row) => {
              const expanded = renderExpanded ? renderExpanded(row) : null;
              return (
                <Fragment key={rowKey(row)}>
                  <tr className="hover:bg-bg" id={rowId ? rowId(row) : undefined}>
                    {columns.map((col) => (
                      <td key={col.key} className={`px-4 py-2.5 ${alignCls(col.align)} ${col.tdClassName ?? ''}`}>
                        {col.render ? col.render(row) : String(rawValue(col, row) ?? '')}
                      </td>
                    ))}
                  </tr>
                  {expanded != null && (
                    <tr>
                      <td colSpan={columns.length} className="p-0">{expanded}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {view.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-6 text-center text-text-muted">
                  {rows.length === 0 ? (empty ?? 'No records.') : 'No matches for the current filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
