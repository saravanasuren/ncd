/**
 * In-page confirm / prompt, replacing window.confirm and window.prompt.
 *
 * Browsers suppress repeated native dialogs ("Don't allow this page to create
 * more dialogs"). A suppressed confirm() returns false and a suppressed
 * prompt() returns null — both of which the calling code reads as "the user
 * said no". The button then does nothing at all: no request, no error, no
 * message. That is how "Mark as paid", "Cancel batch" and "Reject" all
 * silently stopped working (owner reports 2026-07-28).
 *
 * These dialogs are rendered by the app, so nothing can suppress them, and a
 * pending action is visible rather than invisible.
 *
 * Promise-based so call sites keep their shape:
 *   if (await confirm({ ... })) { … }              ← was window.confirm
 *   const reason = await promptText({ ... });      ← was window.prompt
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface ConfirmOpts {
  title: string;
  /** Extra detail under the title. Plain text or nodes. */
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button — use for destructive or irreversible actions. */
  danger?: boolean;
}

export interface PromptOpts extends ConfirmOpts {
  label?: string;
  placeholder?: string;
  /** Pre-filled value — the second argument window.prompt used to take. */
  defaultValue?: string;
  /** 'date' gives a native date picker; 'text' (default) a plain field. */
  inputType?: 'text' | 'date';
  /** Confirm stays disabled until the trimmed value is at least this long.
   *  0 allows an empty answer (an OPTIONAL reason), which still resolves to ''
   *  rather than null — so the caller can tell "no reason" from "cancelled". */
  minLength?: number;
}

interface ConfirmApi {
  confirm(opts: ConfirmOpts): Promise<boolean>;
  promptText(opts: PromptOpts): Promise<string | null>;
}

const Ctx = createContext<ConfirmApi | null>(null);

/** Throws if the provider is missing — a silently no-op confirm is exactly the
 * failure mode this component exists to remove. */
export function useConfirm(): ConfirmApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return api;
}

interface Pending extends PromptOpts {
  kind: 'confirm' | 'prompt';
  resolve: (v: never) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');

  const api = useMemo<ConfirmApi>(() => ({
    confirm: (opts) => new Promise<boolean>((resolve) => {
      setValue('');
      setPending({ ...opts, kind: 'confirm', resolve: resolve as never });
    }),
    promptText: (opts) => new Promise<string | null>((resolve) => {
      setValue(opts.defaultValue ?? '');
      setPending({ ...opts, kind: 'prompt', resolve: resolve as never });
    }),
  }), []);

  const close = useCallback((answer: boolean | string | null) => {
    setPending((p) => { p?.resolve(answer as never); return null; });
    setValue('');
  }, []);

  // Escape cancels, and the page behind stays put: autoFocus on the input
  // otherwise scrolls the background, so dismissing the dialog leaves the
  // operator somewhere they did not ask to be.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(pending.kind === 'prompt' ? null : false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [pending, close]);

  const isPrompt = pending?.kind === 'prompt';
  const min = pending?.minLength ?? (isPrompt ? 2 : 0);
  const tooShort = isPrompt && value.trim().length < min;

  return (
    <Ctx.Provider value={api}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto py-16 px-4"
          onClick={() => close(isPrompt ? null : false)}
        >
          <div
            role="dialog" aria-modal="true" aria-label={pending.title}
            className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-lg p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold m-0 mb-1">{pending.title}</h2>
            {pending.body && <div className="text-sm text-text-muted mb-3">{pending.body}</div>}
            {isPrompt && pending.label && <div className="text-xs text-text-label mb-1">{pending.label}</div>}
            {isPrompt && (
              <input
                autoFocus
                type={pending.inputType ?? 'text'}
                className="w-full px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary mb-1"
                placeholder={pending.placeholder ?? pending.label ?? 'Reason'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !tooShort) close(value.trim()); }}
              />
            )}
            {isPrompt && tooShort && (
              <div className="text-xs text-text-muted mb-2">Please type at least {min} characters.</div>
            )}
            <div className="flex gap-2 items-center mt-3">
              <button
                autoFocus={!isPrompt}
                disabled={tooShort}
                onClick={() => close(isPrompt ? value.trim() : true)}
                className={`text-xs rounded px-3 py-1.5 text-white disabled:opacity-40 ${pending.danger ? 'bg-danger hover:opacity-90' : 'bg-primary hover:bg-primary-hover'}`}
              >
                {pending.confirmLabel ?? (pending.danger ? 'Yes, do it' : 'Confirm')}
              </button>
              <button
                onClick={() => close(isPrompt ? null : false)}
                className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg"
              >
                {pending.cancelLabel ?? 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
