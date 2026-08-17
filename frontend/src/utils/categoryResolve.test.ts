import { describe, it, expect } from 'vitest';
import {
  categoryKey, tidyCategoryName, sameCategory, editDistance, allowedDistance,
  resolveCategoryName, rememberDecision, pruneAliases, resolvedName, isDecided,
  isRemembered, isSeparable,
} from './categoryResolve';
import { BASE_TX_CATEGORIES } from './categories';

/** The built-in menu plus a couple of the user's own. */
const KNOWN = [...BASE_TX_CATEGORIES, 'Pet supplies', 'Eating out'];

// ═════════════════════════════════════════════════════════════════════════════
//  The deterministic key — case, whitespace, punctuation, accents
// ═════════════════════════════════════════════════════════════════════════════
describe('categoryKey', () => {
  it('collapses every spelling of the same name onto one key', () => {
    const variants = ['Groceries', 'groceries', 'GROCERIES', '  Groceries  ', 'Groceries!', 'gro-ceries'];
    const keys = new Set(variants.map(categoryKey));
    expect(keys).toEqual(new Set(['groceries']));
  });

  it('treats "&" and "and" as the same word', () => {
    expect(categoryKey('Health & Fitness')).toBe(categoryKey('Health and fitness'));
  });

  it('ignores where the spaces fall', () => {
    expect(categoryKey('Eating out')).toBe(categoryKey('eatingout'));
    expect(categoryKey('Pet supplies')).toBe(categoryKey('Pet-Supplies'));
  });

  it('folds accents so "Café" and "Cafe" are one category', () => {
    expect(categoryKey('Café')).toBe('cafe');
  });

  it('is empty for anything with no letters or digits in it', () => {
    expect(categoryKey('   ')).toBe('');
    expect(categoryKey('!!!')).toBe('');
    expect(categoryKey(null)).toBe('');
  });

  it('keeps genuinely different names apart', () => {
    expect(categoryKey('Transport')).not.toBe(categoryKey('Transfer'));
  });
});

describe('tidyCategoryName', () => {
  it('trims and collapses runs of whitespace without retyping the name', () => {
    expect(tidyCategoryName('  Pet   supplies ')).toBe('Pet supplies');
    expect(tidyCategoryName('eating out')).toBe('eating out');   // casing is the user's
  });
});

describe('sameCategory', () => {
  it('is true across spelling, false across meaning', () => {
    expect(sameCategory('Groceries', ' groceries ')).toBe(true);
    expect(sameCategory('Transport', 'Transfer')).toBe(false);
    expect(sameCategory('', 'Groceries')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Edit distance
// ═════════════════════════════════════════════════════════════════════════════
describe('editDistance', () => {
  it('counts single-character slips', () => {
    expect(editDistance('groceries', 'grocuries')).toBe(1);   // substitution
    expect(editDistance('groceries', 'grocries')).toBe(1);    // deletion
    expect(editDistance('groceries', 'grocceries')).toBe(1);  // insertion
  });

  it('gives up rather than computing a distance nobody will use', () => {
    // Bounded: anything past `max` is reported as max+1, not measured exactly.
    expect(editDistance('groceries', 'motorcycle', 2)).toBe(3);
  });

  it('is zero for identical strings and symmetric otherwise', () => {
    expect(editDistance('rent', 'rent')).toBe(0);
    expect(editDistance('rent', 'rant')).toBe(editDistance('rant', 'rent'));
  });
});

describe('allowedDistance', () => {
  it('refuses to guess at short names, where one edit is a different word', () => {
    expect(allowedDistance(3)).toBe(0);      // "Gas" / "Car" / "Tax"
    expect(allowedDistance(5)).toBe(1);
    expect(allowedDistance(9)).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Resolution — the deterministic tier
// ═════════════════════════════════════════════════════════════════════════════
describe('resolving a name that already exists', () => {
  it('resolves "groceries" to "Groceries"', () => {
    const r = resolveCategoryName('groceries', { known: KNOWN });
    expect(r.status).toBe('exact');
    expect(resolvedName(r)).toBe('Groceries');
  });

  it('resolves every punctuation and spacing variant to the same category', () => {
    for (const input of ['GROCERIES', ' Groceries ', 'Groceries!', 'gro ceries']) {
      const r = resolveCategoryName(input, { known: KNOWN });
      expect(resolvedName(r), input).toBe('Groceries');
      expect(isDecided(r), input).toBe(true);
    }
  });

  it('follows the taxonomy\'s own alias table, so typing matches importing', () => {
    // 'grocery' → 'Groceries' is the same mapping Basiq/parser data goes through.
    const r = resolveCategoryName('grocery', { known: KNOWN });
    expect(r.status).toBe('alias');
    expect(resolvedName(r)).toBe('Groceries');
  });

  it('keeps a user category the taxonomy would have swallowed', () => {
    // normaliseCategory() would keyword-match this to nothing and return
    // Uncategorised; a name the user typed must survive as itself.
    const r = resolveCategoryName('Sunday market', { known: KNOWN });
    expect(r.status).toBe('new');
    expect(resolvedName(r)).toBe('Sunday market');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Resolution — the guessing tier
// ═════════════════════════════════════════════════════════════════════════════
describe('resolving a name that is close to one that exists', () => {
  it('suggests Groceries for the typo "grocuries" — and does not apply it', () => {
    const r = resolveCategoryName('grocuries', { known: KNOWN });
    expect(r.status).toBe('suggestion');
    expect(r.status === 'suggestion' && r.canonical).toBe('Groceries');
    // The caller must ask. A suggestion is not a decision.
    expect(isDecided(r)).toBe(false);
  });

  it('expands an abbreviation that can only mean one thing', () => {
    const r = resolveCategoryName('groc', { known: KNOWN });
    expect(r.status).toBe('suggestion');
    expect(r.status === 'suggestion' && r.canonical).toBe('Groceries');
  });

  it('REFUSES to choose between two equally close categories', () => {
    // "Trans" begins both Transport and Transfer. Picking one silently would
    // file a user's spending under the wrong heading with no visible cause.
    const r = resolveCategoryName('Trans', { known: KNOWN });
    expect(r.status).toBe('ambiguous');
    expect(r.status === 'ambiguous' && r.candidates.sort()).toEqual(['Transfer', 'Transport']);
    expect(resolvedName(r)).toBe('Trans');       // kept as typed
  });

  it('does not guess at short names', () => {
    // Three letters is not evidence: "Cat" and "Car" are one edit apart and have
    // nothing to do with each other.
    expect(resolveCategoryName('Cat', { known: [...KNOWN, 'Car'] }).status).toBe('new');
  });

  it('still uses a curated alias for a short name, because that is a fact', () => {
    // 'gas' → Utilities is in the taxonomy's explicit map. Deterministic, so it
    // applies even below the fuzzy-matching floor.
    const r = resolveCategoryName('Gas', { known: KNOWN });
    expect(r.status).toBe('alias');
    expect(resolvedName(r)).toBe('Utilities');
  });

  it('leaves a clearly different name alone', () => {
    expect(resolveCategoryName('Childcare', { known: KNOWN }).status).toBe('new');
    expect(resolveCategoryName('Pet grooming', { known: KNOWN }).status).toBe('new');
  });

  it('never suggests when the name is already a category', () => {
    // "Food" and "Fuel" are 2 apart, but "Food" IS a category — exact wins.
    const r = resolveCategoryName('Food', { known: KNOWN });
    expect(r.status).toBe('exact');
    expect(resolvedName(r)).toBe('Food');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Remembering the user's answer
// ═════════════════════════════════════════════════════════════════════════════
describe('remembered decisions', () => {
  it('applies a confirmed merge without asking again', () => {
    const aliases = rememberDecision({}, 'grocuries', 'Groceries');
    const r = resolveCategoryName('grocuries', { known: KNOWN, aliases });
    expect(r.status).toBe('alias');
    expect(resolvedName(r)).toBe('Groceries');
  });

  it('remembers "no, it really is different" just as firmly', () => {
    // Without this the user is re-interrogated about the same name forever.
    const aliases = rememberDecision({}, 'Grocuries', 'Grocuries');
    const known = [...KNOWN, 'Grocuries'];
    const r = resolveCategoryName('grocuries', { known, aliases });
    expect(r.status).toBe('alias');
    expect(resolvedName(r)).toBe('Grocuries');
  });

  it('is keyed by spelling, so a different typo is still asked about', () => {
    const aliases = rememberDecision({}, 'grocuries', 'Groceries');
    expect(resolveCategoryName('grocerries', { known: KNOWN, aliases }).status).toBe('suggestion');
  });

  it('returns the same object when nothing changed, so no pointless write', () => {
    const first = rememberDecision({}, 'grocuries', 'Groceries');
    expect(rememberDecision(first, 'grocuries', 'Groceries')).toBe(first);
  });

  it('resolves through to the canonical SPELLING, not the one recorded', () => {
    const aliases = { grocuries: 'groceries' };
    expect(resolvedName(resolveCategoryName('grocuries', { known: KNOWN, aliases })))
      .toBe('Groceries');
  });
});

describe('pruneAliases', () => {
  it('drops decisions about categories that no longer exist', () => {
    const aliases = { grocuries: 'Groceries', wdgets: 'Widgets' };
    expect(pruneAliases(aliases, KNOWN)).toEqual({ grocuries: 'Groceries' });
  });

  it('follows a rename rather than being thrown away', () => {
    const aliases = { eatngout: 'Eating out' };
    // "Eating out" was renamed to "Dining out": the alias re-points, so the
    // user's earlier decision keeps working.
    expect(pruneAliases(aliases, [...BASE_TX_CATEGORIES, 'Dining out'])).toEqual({});
    expect(pruneAliases(aliases, [...BASE_TX_CATEGORIES, 'EATING OUT']))
      .toEqual({ eatngout: 'EATING OUT' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Which answers the user is allowed to give
// ═════════════════════════════════════════════════════════════════════════════
describe('isRemembered / isSeparable', () => {
  const known = ['Groceries', 'Transport', 'Transfer'];

  it('marks a decision the user already made', () => {
    const r = resolveCategoryName('grocuries', { known, aliases: { grocuries: 'Groceries' } });
    expect(isRemembered(r)).toBe(true);
    // A curated alias is being applied to them for the first time — worth
    // showing, so it must NOT read as already-answered.
    expect(isRemembered(resolveCategoryName('grocery', { known }))).toBe(false);
  });

  it('allows keeping a lookalike that has its own identity', () => {
    expect(isSeparable(resolveCategoryName('Grocery', { known }))).toBe(true);
    expect(isSeparable(resolveCategoryName('grocuries', { known }))).toBe(true);
    expect(isSeparable(resolveCategoryName('Childcare', { known }))).toBe(true);
  });

  it('refuses to pretend a re-spelling is a second category', () => {
    // Same key = same category to every lookup in the app. Two rows would be
    // one category with two labels, silently sharing all its transactions.
    expect(isSeparable(resolveCategoryName('groceries', { known }))).toBe(false);
    expect(isSeparable(resolveCategoryName(' GROCERIES! ', { known }))).toBe(false);
  });
});
