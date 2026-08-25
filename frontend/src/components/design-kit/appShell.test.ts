/**
 * The sidebar's RESPONSIVE CONTRACT.
 *
 * There is no DOM harness in this repo, and jsdom would not compute Tailwind's
 * media queries anyway — so what is actually worth guarding is the class list,
 * because every part of the sticky behaviour is one utility that a careless edit
 * could drop. A missing `md:` would silently apply desktop layout to phones; a
 * missing `min-h-0` would silently make a long nav unreachable on a short
 * window. Both are invisible until someone hits them.
 */

import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_CLASS, SIDEBAR_NAV_CLASS,
  PEACEFUL_BAR_CLASS, PEACEFUL_BAR_INNER_CLASS, TECHNICAL_BAR_CLASS, contentPadClass,
} from './AppShell';

const classes = (s: string) => s.split(/\s+/).filter(Boolean);

describe('desktop / tablet sidebar', () => {
  const cls = classes(SIDEBAR_CLASS);

  it('sticks to the top of the viewport so it survives a long page', () => {
    expect(cls).toContain('md:sticky');
    expect(cls).toContain('md:top-0');
  });

  it('is exactly one viewport tall, which is what bounds its inner scroll', () => {
    expect(cls).toContain('md:h-screen');
  });

  it('stays in flow, so content is laid out beside it and never under it', () => {
    // `fixed` would take the aside out of flow and the content column would
    // slide underneath it. Sticky keeps the flex row intact.
    expect(cls).not.toContain('fixed');
    expect(cls).not.toContain('md:fixed');
    expect(cls).toContain('shrink-0');
    expect(cls).toContain('w-56');
  });

  it('sits above page content but below modals', () => {
    expect(cls).toContain('md:z-20');
  });
});

describe('the phone layout is untouched', () => {
  it('hides the sidebar entirely below the tablet breakpoint', () => {
    const cls = classes(SIDEBAR_CLASS);
    expect(cls).toContain('hidden');
    expect(cls).toContain('md:flex');
  });

  it('applies every sticky utility at md and up ONLY', () => {
    // Anything sticky that isn't `md:`-prefixed would reach the phone layout,
    // which has its own fixed bottom nav and must not change.
    const sticky = classes(SIDEBAR_CLASS).filter(c =>
      /(^|:)(sticky|top-0|h-screen|z-20)$/.test(c));
    expect(sticky.length).toBeGreaterThan(0);
    for (const c of sticky) expect(c.startsWith('md:'), c).toBe(true);
  });
});

describe('a nav taller than the window', () => {
  const cls = classes(SIDEBAR_NAV_CLASS);

  it('scrolls inside the sidebar rather than overflowing it', () => {
    expect(cls).toContain('overflow-y-auto');
    expect(cls).toContain('flex-1');
  });

  it('can actually shrink, which is what makes that scroll work', () => {
    // A flex child defaults to min-height:auto and refuses to shrink below its
    // content — overflow-y-auto on an element that never shrinks never scrolls,
    // and the last nav items become unreachable on a short laptop window.
    expect(cls).toContain('min-h-0');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The two bottom bars
// ═════════════════════════════════════════════════════════════════════════════
describe('the phone bottom bar, in both views', () => {
  const bars = { technical: TECHNICAL_BAR_CLASS, peaceful: PEACEFUL_BAR_CLASS };

  it('is a phone thing only — a desktop has the sidebar', () => {
    for (const [name, bar] of Object.entries(bars)) {
      expect(classes(bar), name).toContain('md:hidden');
    }
  });

  it('stays put at the bottom while the page scrolls under it', () => {
    for (const [name, bar] of Object.entries(bars)) {
      const cls = classes(bar);
      expect(cls, name).toContain('fixed');
      expect(cls, name).toContain('bottom-0');
      expect(cls, name).toContain('inset-x-0');
      expect(cls, name).toContain('z-30');
    }
  });

  it('clears the home indicator rather than sitting under it', () => {
    // Without pb-safe the last few pixels of the bar are behind the iPhone's
    // gesture bar — the tabs still render, and the bottom row of them is
    // untappable, which reads as the app ignoring your taps.
    for (const [name, bar] of Object.entries(bars)) {
      expect(classes(bar), name).toContain('pb-safe');
    }
  });
});

describe('the peaceful bar floats', () => {
  it('is a rounded, blurred slab rather than a full-width strip', () => {
    const cls = classes(PEACEFUL_BAR_INNER_CLASS);
    expect(cls).toContain('rounded-[26px]');
    expect(cls).toContain('backdrop-blur-xl');
  });

  it('lets taps through the gap around it, but not through the bar itself', () => {
    // The outer element spans the width so the bar can be centred; if it kept
    // pointer events it would eat every tap along the bottom of the page.
    expect(classes(PEACEFUL_BAR_CLASS)).toContain('pointer-events-none');
    expect(classes(PEACEFUL_BAR_INNER_CLASS)).toContain('pointer-events-auto');
  });
});

describe('the content clears whichever bar is showing', () => {
  it('leaves more room under the floating bar than under the flat strip', () => {
    const pad = (c: string) => Number(/pb-(\d+)/.exec(c)?.[1] ?? 0);
    expect(pad(contentPadClass('peaceful'))).toBeGreaterThan(pad(contentPadClass('technical')));
  });

  it('and reclaims that room on desktop, where there is no bar at all', () => {
    expect(classes(contentPadClass('peaceful'))).toContain('md:pb-0');
    expect(classes(contentPadClass('technical'))).toContain('md:pb-0');
  });
});
