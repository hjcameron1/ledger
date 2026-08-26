import { ReactNode, ButtonHTMLAttributes } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives every app builds pages from (copied from ~/design-kit so
// Ledger, PAssistant, and future apps render a "card" / "stat" identically).
// Themed via the design-kit tokens: zinc neutrals + the `brand` accent + `.card`.
// (Ledger keeps its blue brand rather than the kit's purple.)
// ─────────────────────────────────────────────────────────────────────────────

// Ledger's base `.card` has no padding (so common <Card padding="none"> works),
// so the design-kit Card supplies the kit's p-5 itself. Override via className.
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
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

/** Time-of-day greeting text, e.g. "Good morning". Pass an hour (0–23) to
 *  override; defaults to the device's local hour. Keep this shared so every
 *  app greets the user with the same wording and cut-offs. */
export function greetingFor(hour = new Date().getHours()) {
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** The family's standard top-of-page welcome header:
 *  "Good morning, <name>" with a date/subtitle and an optional action button.
 *  Built on PageHeader so it lines up with every other page header. */
export function Greeting({
  name, subtitle, action, hour,
}: { name?: string; subtitle?: ReactNode; action?: ReactNode; hour?: number }) {
  const first = name?.split(' ')[0] ?? '';
  const title = first ? `${greetingFor(hour)}, ${first}` : greetingFor(hour);
  return <PageHeader title={title} subtitle={subtitle} action={action} />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary = brand-filled CTA · ghost = subtle neutral. Default primary. */
  variant?: 'primary' | 'ghost';
  /** true = the big, important call-to-action size (px-6 py-3). */
  large?: boolean;
};

/** The family button. Use this for the big important actions ("+ New", "Save",
 *  "Connect") so they look identical across apps. Falls through to the
 *  .btn-primary / .btn-ghost / .btn-lg classes from index.css. */
export function Button({ variant = 'primary', large = false, className = '', ...rest }: ButtonProps) {
  const base = variant === 'ghost' ? 'btn-ghost' : 'btn-primary';
  return <button className={`${base}${large ? ' btn-lg' : ''} ${className}`} {...rest} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center py-12 text-zinc-500 dark:text-zinc-400">{children}</div>;
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
    <Card>
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </Card>
  );
}
