/**
 * The nav's one law: CHOOSING A VIEW CHANGES WHAT IS IN FRONT OF YOU, NEVER WHAT
 * THE APP HOLDS.
 *
 * The peaceful view is only a simplification if everything it takes off the bar
 * turns up on the More page. If it doesn't, a page is just gone — and gone
 * quietly, since nothing breaks and no test fails on its own. That is what the
 * "nothing goes missing" test below exists to prevent, and it is why the strip,
 * the sidebar and the More grid are all derived from one list.
 */

import { describe, it, expect } from 'vitest';
import {
  DESTINATIONS, MORE_TAB, navFor, moreSections, moreDestinations,
  destinationFor, toViewMode, VIEW_MODES, VIEW_MODE_COPY, applyViewMode
} from './appearance';

describe('the technical view', () => {
  it('puts every page on the bar, in order', () => {
    expect(navFor('technical')).toEqual(DESTINATIONS);
  });

  it('starts at the Overview and ends at Settings, as it always has', () => {
    const nav = navFor('technical');
    expect(nav[0].to).toBe('/');
    expect(nav[nav.length - 1].to).toBe('/settings');
  });
});

describe('the peaceful view', () => {
  it('is exactly four tabs', () => {
    const nav = navFor('peaceful');
    expect(nav.map(d => d.label)).toEqual(['Overview', 'Accounts', 'Investments', 'More']);
  });

  it('ends with More — the way to everything it took off the bar', () => {
    expect(navFor('peaceful').at(-1)).toBe(MORE_TAB);
  });
});

describe('nothing goes missing', () => {
  it('every page is either a peaceful tab or a tile on the More page', () => {
    const onBar = navFor('peaceful').filter(d => d !== MORE_TAB).map(d => d.to);
    const onMore = moreDestinations().map(d => d.to);
    expect([...onBar, ...onMore].sort()).toEqual(DESTINATIONS.map(d => d.to).sort());
  });

  it('and is in exactly one of the two — never both, never neither', () => {
    const onBar = navFor('peaceful').filter(d => d !== MORE_TAB).map(d => d.to);
    const onMore = moreDestinations().map(d => d.to);
    const all = [...onBar, ...onMore];
    expect(new Set(all).size).toBe(all.length);
    for (const d of DESTINATIONS) {
      expect(Boolean(d.primary) !== Boolean(d.group), d.label).toBe(true);
    }
  });

  it('the More page is grouped, and no group is empty', () => {
    const sections = moreSections();
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect(s.items.length).toBeGreaterThan(0);
  });

  it('every tile can say what is behind it', () => {
    for (const d of moreDestinations()) {
      expect(d.blurb.length, d.label).toBeGreaterThan(8);
      expect(d.icon, d.label).toBeTruthy();
      expect(d.tint, d.label).toContain('bg-');
    }
  });

  it('no two pages claim the same path', () => {
    const paths = DESTINATIONS.map(d => d.to);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).not.toContain(MORE_TAB.to);
  });
});

describe('working out which page you are on', () => {
  it('matches the plain paths', () => {
    expect(destinationFor('/documents')?.label).toBe('Documents');
    expect(destinationFor('/more')).toBe(MORE_TAB);
  });

  it('does not let the Overview swallow every other route', () => {
    // '/' is an `end` match — without that, every path starts with '/' and the
    // Overview would light up on all of them.
    expect(destinationFor('/')?.label).toBe('Overview');
    expect(destinationFor('/tax')?.label).toBe('Tax');
  });

  it('shrugs at something it does not know', () => {
    expect(destinationFor('/nowhere')).toBeUndefined();
  });
});

describe('reading the stored preference', () => {
  it('accepts the two views', () => {
    expect(toViewMode('peaceful')).toBe('peaceful');
    expect(toViewMode('technical')).toBe('technical');
  });

  it('falls back to technical for anything else — a bad value never blanks the nav', () => {
    for (const junk of [undefined, null, '', 'PEACEFUL', 'calm', 7, {}]) {
      expect(toViewMode(junk)).toBe('technical');
    }
  });

  it('has copy for both, so the setting can describe itself', () => {
    for (const m of VIEW_MODES) {
      expect(VIEW_MODE_COPY[m].title.length).toBeGreaterThan(3);
      expect(VIEW_MODE_COPY[m].blurb.length).toBeGreaterThan(20);
    }
  });
});

describe('putting the view on the document', () => {
  const stub = () => {
    const el = { dataset: {} as Record<string, string> };
    (globalThis as { document?: unknown }).document = { documentElement: el };
    return el;
  };
  const clear = () => { delete (globalThis as { document?: unknown }).document; };

  it('stamps the mode on <html>, so CSS can respond to it', () => {
    const el = stub();
    applyViewMode('peaceful');
    expect(el.dataset.view).toBe('peaceful');
    applyViewMode('technical');
    expect(el.dataset.view).toBe('technical');
    clear();
  });

  it('does nothing without a document, like applyTheme', () => {
    clear();
    expect(() => applyViewMode('peaceful')).not.toThrow();
  });
});
