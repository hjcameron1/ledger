import { ReactNode } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives every app builds pages from (copied from ~/design-kit so
// Ledger, PAssistant, and future apps render a "card" / "stat" identically).
// Themed via the design-kit tokens: zinc neutrals + the `brand` accent + `.card`.
// ─────────────────────────────────────────────────────────────────────────────

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{title}</h1>
        {subtitle && <p className="text-zinc-500 dark:text-zinc-400 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center py-12 text-zinc-400">{children}</div>;
}

export function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
    </div>
  );
}

/** A labelled number tile — the family's standard summary stat. */
export function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </Card>
  );
}
