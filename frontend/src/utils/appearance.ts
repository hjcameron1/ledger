/**
 * How Ledger LOOKS — the two views, and the one list of places the app has.
 *
 * ── The two views ────────────────────────────────────────────────────────────
 *   'technical'  every page on the bottom strip, charts with axes, gridlines and
 *                monospaced ticks. For reading numbers off the screen.
 *   'peaceful'   four tabs — Overview, Accounts, Investments, More — and charts
 *                stripped back to their shape. Everything else lives on the More
 *                page, one tap away. For looking at your money without being
 *                shouted at.
 *
 * The view changes what is IN FRONT of you and how a chart is drawn. It never
 * changes what the app holds: every destination below is reachable in both views,
 * which is what the "no destination goes missing" test pins down.
 *
 * ── Why the list lives here ──────────────────────────────────────────────────
 * The nav strip, the desktop sidebar and the More grid used to be three separate
 * hand-kept lists. Adding a page meant remembering all three, and forgetting one
 * hid a page rather than breaking a build. There is now ONE list; the strip, the
 * sidebar and the grid are all derived from it.
 *
 * PURE — no React, no store — so the derivations are unit-tested directly.
 */

export type ViewMode = 'technical' | 'peaceful';

export const VIEW_MODES: ViewMode[] = ['technical', 'peaceful'];

/** The icon keys `<NavIcon>` knows how to draw. */
export type IconName =
  | 'overview' | 'forecast' | 'ask' | 'accounts' | 'investments' | 'loans'
  | 'income' | 'tax' | 'documents' | 'insurance' | 'settings' | 'more';

/** The heading a destination sits under on the More page. */
export type MoreGroup = 'Money in and out' | 'Borrowing and cover' | 'Paperwork' | 'Tools';

export const MORE_GROUPS: MoreGroup[] = [
  'Money in and out', 'Borrowing and cover', 'Paperwork', 'Tools',
];

export interface Destination {
  to: string;
  label: string;
  /** One plain line saying what is behind the tile — shown on the More page. */
  blurb: string;
  icon: IconName;
  /** Only the exact path matches (react-router `end`) — the '/' route needs it. */
  end?: boolean;
  /** true = one of the four tabs the peaceful view keeps on the bar. */
  primary?: boolean;
  group?: MoreGroup;
  /** Tint for the icon tile. Full class strings — Tailwind can't see fragments. */
  tint: string;
}

/**
 * Every place in Ledger, in the order the technical strip lists them (which is
 * also the order the desktop sidebar uses). `primary` marks the three that stay
 * on the bar in the peaceful view; the rest are grouped onto the More page.
 */
export const DESTINATIONS: Destination[] = [
  { to: '/', label: 'Overview', end: true, primary: true, icon: 'overview',
    blurb: 'Net worth, bills, budgets and goals',
    tint: 'bg-brand/10 text-brand' },
  { to: '/forecast', label: 'Forecast', icon: 'forecast', group: 'Money in and out',
    blurb: 'Where your balance is heading',
    tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  { to: '/ask', label: 'Ask', icon: 'ask', group: 'Tools',
    blurb: 'Questions and what-ifs, in plain English',
    tint: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400' },
  { to: '/accounts', label: 'Accounts', primary: true, icon: 'accounts',
    blurb: 'Balances, cards and everything you spent',
    tint: 'bg-brand/10 text-brand' },
  { to: '/investments', label: 'Investments', primary: true, icon: 'investments',
    blurb: 'Holdings, super and property',
    tint: 'bg-brand/10 text-brand' },
  { to: '/loans', label: 'Loans', icon: 'loans', group: 'Borrowing and cover',
    blurb: 'Debts, repayments and payoff dates',
    tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  { to: '/income', label: 'Income', icon: 'income', group: 'Money in and out',
    blurb: 'Pay, dividends and everything coming in',
    tint: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  { to: '/tax', label: 'Tax', icon: 'tax', group: 'Paperwork',
    blurb: 'Your position this financial year',
    tint: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  { to: '/documents', label: 'Documents', icon: 'documents', group: 'Paperwork',
    blurb: 'Statements, policies and paperwork',
    tint: 'bg-teal-500/10 text-teal-600 dark:text-teal-400' },
  { to: '/insurance', label: 'Insurance', icon: 'insurance', group: 'Borrowing and cover',
    blurb: 'Policies, premiums and renewals',
    tint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  { to: '/settings', label: 'Settings', icon: 'settings', group: 'Tools',
    blurb: 'Households, categories, connections, account',
    tint: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-300' },
];

/** The More tab itself — a destination in the nav, not a tile on its own page. */
export const MORE_TAB: Destination = {
  to: '/more', label: 'More', icon: 'more', primary: true,
  blurb: 'Everything else in Ledger',
  tint: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
};

/**
 * What goes on the bottom strip / sidebar for a view.
 *   technical → all of it, in order (the strip scrolls).
 *   peaceful  → the three primaries, then More.
 */
export function navFor(mode: ViewMode): Destination[] {
  if (mode !== 'peaceful') return DESTINATIONS;
  return [...DESTINATIONS.filter(d => d.primary), MORE_TAB];
}

/** The More page, grouped and in group order. Empty groups are dropped. */
export function moreSections(): { group: MoreGroup; items: Destination[] }[] {
  return MORE_GROUPS
    .map(group => ({ group, items: DESTINATIONS.filter(d => d.group === group) }))
    .filter(s => s.items.length > 0);
}

/** Everything the More page lists, flat — the counterpart to `navFor`. */
export function moreDestinations(): Destination[] {
  return moreSections().flatMap(s => s.items);
}

/** The destination a path belongs to, for page titles and highlighting. */
export function destinationFor(path: string): Destination | undefined {
  if (path === '/more') return MORE_TAB;
  return DESTINATIONS.find(d => (d.end ? d.to === path : path === d.to || path.startsWith(`${d.to}/`)));
}

/**
 * Put the current view on <html> as `data-view`, so stylesheet rules can key off
 * it the same way `dark` does. Only one thing needs this today — money is set in
 * Inter's tabular figures in the peaceful view and in the monospace in the
 * technical one (see `.amount` in index.css) — but the alternative was threading
 * the mode through every component that renders a figure, which is most of them.
 *
 * Mirrors applyTheme: no-op without a document, so tests and SSR are unaffected.
 */
export function applyViewMode(mode: ViewMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.view = mode;
}

/** A view mode from anything (an old localStorage value, a stale API field). */
export function toViewMode(value: unknown): ViewMode {
  return value === 'peaceful' ? 'peaceful' : 'technical';
}

export const VIEW_MODE_COPY: Record<ViewMode, { title: string; blurb: string }> = {
  technical: {
    title: 'Technical',
    blurb: 'Every page on the bar, and charts with axes, gridlines and figures you can read off.',
  },
  peaceful: {
    title: 'Peaceful',
    blurb: 'Four tabs — Overview, Accounts, Investments, More — and charts pared back to the shape.',
  },
};
