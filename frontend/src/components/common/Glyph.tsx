/**
 * Three marks that used to be emoji.
 *
 * ⚡ 🔔 👤 were doing real work in Ledger — auto-pay, a reminder rather than a
 * bill, the person a shared bill falls to — but an emoji is a picture drawn by
 * whoever made the font, at whatever weight and colour they felt like, and it
 * lands differently on a Mac, a phone and Windows. Three lines of SVG each and
 * they take the app's own colour, sit on the text baseline, and look like part
 * of the same drawing as everything else.
 *
 * Deliberately tiny and inline — `currentColor`, `1em`-relative sizing, and
 * `aria-hidden` because every one of them sits beside the words it illustrates.
 */

interface GlyphProps {
  /** Tailwind size classes. Defaults suit inline use at text-xs / text-sm. */
  className?: string;
  title?: string;
}

/** Auto-pay / auto-complete — it happens without you. */
export function BoltGlyph({ className = 'w-3 h-3', title }: GlyphProps) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} inline-block shrink-0`} fill="currentColor" aria-hidden="true">
      {title ? <title>{title}</title> : null}
      <path d="M13.5 2 5 13.2h5.2L9.8 22 19 10.4h-5.4L13.5 2Z" />
    </svg>
  );
}

/** A reminder — a nudge on a date, as opposed to a bill with money attached. */
export function BellGlyph({ className = 'w-3 h-3', title }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24" className={`${className} inline-block shrink-0`} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {title ? <title>{title}</title> : null}
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/** Whose it is — the household member a shared bill is down to. */
export function PersonGlyph({ className = 'w-3 h-3', title }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24" className={`${className} inline-block shrink-0`} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {title ? <title>{title}</title> : null}
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
