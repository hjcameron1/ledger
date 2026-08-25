import type { IconName } from '../../utils/appearance';

/**
 * The nav's icon set — line art, drawn inline.
 *
 * Deliberately hand-drawn rather than an icon package: eleven glyphs is not
 * worth a dependency, and shipping them as paths keeps them theme-aware
 * (`currentColor`) and free of a runtime font/sprite fetch. Every glyph is on
 * the same 24-unit grid with the same 1.75 stroke, so a row of them reads as one
 * family rather than as clip-art.
 */

const PATHS: Record<IconName, JSX.Element> = {
  // Dashboard — four panes, the shape of the page itself.
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
    </>
  ),
  // Forecast — a line heading somewhere.
  forecast: (
    <>
      <polyline points="3 16 9 10 13 14 21 6" />
      <polyline points="16 6 21 6 21 11" />
    </>
  ),
  // Ask — a question in a bubble.
  ask: (
    <>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.2A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8z" />
      <path d="M10 9.5a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.5" />
      <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  // Accounts — a wallet with its clasp.
  accounts: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M3 10h18" />
      <circle cx="17" cy="14.5" r="1.1" />
    </>
  ),
  // Investments — bars, tallest last.
  investments: (
    <>
      <path d="M4 20V13" />
      <path d="M9.33 20V9" />
      <path d="M14.67 20v-6" />
      <path d="M20 20V4" />
    </>
  ),
  // Loans — a bank, columns and all.
  loans: (
    <>
      <path d="M3 9.5 12 4l9 5.5" />
      <path d="M5 10v8M10 10v8M14 10v8M19 10v8" />
      <path d="M3 20.5h18" />
    </>
  ),
  // Income — a note coming in.
  income: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 12h.01M18 12h.01" />
    </>
  ),
  // Tax — a percentage on a page.
  tax: (
    <>
      <path d="M5 3.5h14v17l-2.3-1.6-2.3 1.6-2.4-1.6-2.3 1.6-2.4-1.6L5 20.5z" />
      <path d="M9.5 14.5 15 8.5" />
      <circle cx="9.7" cy="9" r="1.1" />
      <circle cx="14.5" cy="14" r="1.1" />
    </>
  ),
  // Documents — a filed page.
  documents: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  // Insurance — cover.
  insurance: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6z" />
      <polyline points="9 12 11.2 14.2 15.4 10" />
    </>
  ),
  // Settings — dials, not the usual gear.
  settings: (
    <>
      <path d="M4 7h6M14 7h6M4 17h10M18 17h2" />
      <circle cx="12" cy="7" r="2.2" />
      <circle cx="16" cy="17" r="2.2" />
    </>
  ),
  // More — the rest of it.
  more: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="8.3" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15.7" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
};

export default function NavIcon({ name, size = 22, className = '' }: {
  name: IconName; size?: number; className?: string;
}) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
