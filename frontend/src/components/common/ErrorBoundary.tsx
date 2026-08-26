import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Last-resort recovery for an unexpected render crash. Without this, one thrown
 * component unmounts the entire React tree and the user is left staring at a
 * blank white page with no way forward but knowing to hard-refresh. No user
 * data is at risk here: local state is persisted and the sync queue holds any
 * unconfirmed writes, so "Try again" / "Reload" genuinely recovers.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] render crash:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-white dark:bg-zinc-900 flex flex-col items-center justify-center p-4 text-center">
        <div className="w-full max-w-sm">
          <h1 className="text-brand font-semibold text-3xl tracking-wide mb-6">Ledger</h1>
          <div className="card p-8">
            <h2 className="text-xl font-semibold mb-3 text-zinc-900 dark:text-zinc-100">
              Something went wrong
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed mb-6">
              The app hit an unexpected error. Your data is safe — anything you
              saved is stored, and anything still syncing will finish after a reload.
            </p>
            <div className="space-y-2">
              <button
                onClick={() => window.location.reload()}
                className="w-full py-2.5 rounded-[8px] bg-brand text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Reload the app
              </button>
              <button
                onClick={() => this.setState({ error: null })}
                className="w-full py-2.5 rounded-[8px] border border-zinc-200 dark:border-zinc-800 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Try again without reloading
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
