import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { hasError: boolean; message: string }

/**
 * Catches render-time errors from any page below it and shows a friendly card
 * instead of blanking the whole app. Pages that destructure `data!` and render
 * before an error branch would otherwise throw during render — this is the
 * safety net. Wrap it around the routed content (the <Outlet/>) with a key on
 * the current path so navigating away clears a caught error.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : 'Unexpected error' };
  }

  override componentDidCatch(err: unknown, info: ErrorInfo) {
    // Surface the crash in the console for debugging; the UI stays usable.
    console.error('[ErrorBoundary] render error:', err, info.componentStack);
  }

  override render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="w-full">
        <div className="bg-surface border border-border rounded-lg shadow-card p-6 max-w-lg">
          <h2 className="text-base font-bold text-danger m-0">Something went wrong on this page</h2>
          <p className="text-sm text-text-muted mt-2 mb-4">
            The page hit an unexpected error and couldn't be displayed. The rest of the app is still working — you can switch to another section from the menu, or reload to try again.
          </p>
          {this.state.message && (
            <p className="text-xs text-text-muted font-mono bg-bg rounded px-3 py-2 mb-4 break-words">{this.state.message}</p>
          )}
          <button onClick={() => window.location.reload()}
            className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold">
            Reload
          </button>
        </div>
      </div>
    );
  }
}
