import { describe, it, expect } from 'vitest';
import type { Merchant, MerchantAlias, TransactionRule, RuleCondition } from '../types';
import { resolveMerchant, merchantMatchToken } from './merchantResolution';
import { matchRule, applyRules, orderedUserRules, type RuleCandidate } from './transactionRules';
import { classifyTransaction, type ClassifyContext } from './transactionClassify';
import { normaliseCategory, UNCATEGORISED } from './categoryTaxonomy';
import { planCorrection } from './corrections';
import { stampIngest } from './transactionCore';

const ME = 'user-1';
const OTHER = 'user-2';

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return { merchants: [], aliases: [], rules: [], customCategories: [], userId: ME, ...over };
}

function rule(over: Partial<TransactionRule> & { conditions: RuleCondition }): TransactionRule {
  return {
    id: over.id ?? `r-${Math.random().toString(36).slice(2)}`,
    user_id: over.user_id ?? ME,
    priority: over.priority ?? 100,
    enabled: over.enabled ?? true,
    conditions: over.conditions,
    actions: over.actions ?? {},
    created_at: over.created_at ?? '2026-01-01T00:00:00Z',
  };
}

function candidate(over: Partial<RuleCandidate> = {}): RuleCandidate {
  return {
    merchant_normalized: 'woolworths',
    raw_description: 'WOOLWORTHS 1234 ROBINA',
    merchant: 'Woolworths',
    account_id: 'acc-1',
    amount: -50,
    source: 'basiq',
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MERCHANT RECOGNITION
// ═══════════════════════════════════════════════════════════════════════════
describe('merchant recognition', () => {
  it('resolves Woolworths description variants all to the same merchant (via seeds)', () => {
    for (const raw of ['WOOLWORTHS 1234 ROBINA', 'WOOLWORTHS ONLINE', 'W/WORTHS ROBINA']) {
      const r = resolveMerchant(raw, { merchants: [], aliases: [], userId: ME });
      expect(r?.displayName, raw).toBe('Woolworths');
      expect(r?.defaultCategory, raw).toBe('Groceries');
    }
  });

  it('returns null when nothing matches', () => {
    expect(resolveMerchant("Bob's Corner Store", { merchants: [], aliases: [], userId: ME })).toBeNull();
  });

  it('a USER alias overrides a GLOBAL alias for the same pattern', () => {
    const userMerchant: Merchant = { id: 'm-user', user_id: ME, display_name: 'User Coffee', merchant_normalized: 'the roastery' };
    const globalMerchant: Merchant = { id: 'm-global', user_id: null, display_name: 'Global Coffee', merchant_normalized: 'the roastery' };
    const userAlias: MerchantAlias = { id: 'a1', user_id: ME, merchant_id: 'm-user', pattern: 'the roastery', match_type: 'normalized' };
    const globalAlias: MerchantAlias = { id: 'a2', user_id: null, merchant_id: 'm-global', pattern: 'the roastery', match_type: 'normalized' };

    const r = resolveMerchant('THE ROASTERY', {
      merchants: [globalMerchant, userMerchant],
      aliases: [globalAlias, userAlias],
      userId: ME,
    });
    expect(r?.displayName).toBe('User Coffee');
    expect(r?.matchedBy).toBe('user_alias');
  });

  it('another user\'s alias does NOT resolve for me', () => {
    const merchant: Merchant = { id: 'm', user_id: OTHER, display_name: 'Their Merchant', merchant_normalized: 'zzz shop' };
    const alias: MerchantAlias = { id: 'a', user_id: OTHER, merchant_id: 'm', pattern: 'zzz shop', match_type: 'normalized' };
    expect(resolveMerchant('ZZZ SHOP', { merchants: [merchant], aliases: [alias], userId: ME })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CATEGORY TAXONOMY
// ═══════════════════════════════════════════════════════════════════════════
describe('category taxonomy', () => {
  it('maps provider (Basiq ANZSIC) categories into the Ledger taxonomy', () => {
    expect(normaliseCategory('Supermarket and grocery stores')).toBe('Groceries');
    expect(normaliseCategory('Cafes and restaurants')).toBe('Dining');
    expect(normaliseCategory('Automotive fuel retailing')).toBe('Fuel');
    expect(normaliseCategory('Health and fitness centres and gymnasia operation')).toBe('Fitness');
  });

  it('maps statement-parser categories', () => {
    expect(normaliseCategory('Groceries')).toBe('Groceries');
    expect(normaliseCategory('Software')).toBe('Electronics');
    expect(normaliseCategory('Telecommunications')).toBe('Telecommunications');
  });

  it('preserves a user custom category verbatim', () => {
    expect(normaliseCategory('Boat Fund', { customCategories: ['Boat Fund'] })).toBe('Boat Fund');
  });

  it('unknown provider category → Uncategorised (never invents a name)', () => {
    expect(normaliseCategory('Blorp Category XYZ')).toBe(UNCATEGORISED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  RULES ENGINE
// ═══════════════════════════════════════════════════════════════════════════
describe('rules engine', () => {
  it('matches when every present condition holds (AND)', () => {
    const cond: RuleCondition = { merchant_normalized: 'woolworths', direction: 'debit', amount_min: 10 };
    expect(matchRule(cond, candidate({ amount: -50 }))).toBe(true);
    expect(matchRule(cond, candidate({ amount: -5 }))).toBe(false);  // below amount_min
    expect(matchRule(cond, candidate({ amount: 50 }))).toBe(false);   // wrong direction
  });

  it('description_contains matches case-insensitively on raw description', () => {
    expect(matchRule({ description_contains: 'robina' }, candidate())).toBe(true);
    expect(matchRule({ description_contains: 'sydney' }, candidate())).toBe(false);
  });

  it('a disabled rule does nothing', () => {
    const r = rule({ enabled: false, conditions: { merchant_normalized: 'woolworths' }, actions: { category: 'Groceries' } });
    expect(applyRules(candidate(), [r], ME)).toBeNull();
  });

  it('higher-priority rule wins', () => {
    const low = rule({ id: 'low', priority: 10, conditions: { merchant_normalized: 'woolworths' }, actions: { category: 'Shopping' } });
    const high = rule({ id: 'high', priority: 99, conditions: { merchant_normalized: 'woolworths' }, actions: { category: 'Groceries' } });
    const match = applyRules(candidate(), [low, high], ME);
    expect(match?.rule.id).toBe('high');
    expect(match?.actions.category).toBe('Groceries');
  });

  it('account-specific rules stay account-specific', () => {
    const r = rule({ conditions: { merchant_normalized: 'woolworths', account_id: 'acc-1' }, actions: { category: 'Groceries' } });
    expect(applyRules(candidate({ account_id: 'acc-1' }), [r], ME)?.actions.category).toBe('Groceries');
    expect(applyRules(candidate({ account_id: 'acc-2' }), [r], ME)).toBeNull();
  });

  it('a rule never applies to another user', () => {
    const theirs = rule({ user_id: OTHER, conditions: { merchant_normalized: 'woolworths' }, actions: { category: 'Groceries' } });
    expect(applyRules(candidate(), [theirs], ME)).toBeNull();
    expect(orderedUserRules([theirs], ME)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CLASSIFICATION ORCHESTRATOR (priority order + parity across sources)
// ═══════════════════════════════════════════════════════════════════════════
describe('classification priority order', () => {
  const base = {
    merchant: 'WOOLWORTHS 1234 ROBINA',
    raw_description: 'WOOLWORTHS 1234 ROBINA',
    amount: -50,
    account_id: 'acc-1',
  };

  it('explicit user choice beats everything', () => {
    const r = rule({ conditions: { merchant_normalized: 'woolworths' }, actions: { category: 'Shopping' } });
    const cls = classifyTransaction(
      { ...base, source: 'manual', category: 'Boat Fund', category_source: 'user' },
      ctx({ rules: [r], customCategories: ['Boat Fund'] }),
    );
    expect(cls.category).toBe('Boat Fund');
    expect(cls.category_source).toBe('user');
    expect(cls.confidence).toBe(1);
  });

  it('a user-chosen CATEGORY still lets the display merchant be recognised', () => {
    // Manual add: user types the raw bank string AND picks a category. Picking a
    // category (category_source:'user') must NOT suppress merchant recognition —
    // the display name should still canonicalise to "Woolworths".
    const cls = classifyTransaction(
      { ...base, source: 'manual', category: 'Groceries', category_source: 'user' },
      ctx(),
    );
    expect(cls.merchant).toBe('Woolworths');
    expect(cls.merchant_id).toBe('seed:woolworths');
    expect(cls.category).toBe('Groceries');
    expect(cls.category_source).toBe('user'); // category choice preserved
  });

  it('an explicitly curated merchant (merchant_source:user) is left untouched', () => {
    const cls = classifyTransaction(
      { ...base, source: 'manual', merchant: 'My Woolies Run', merchant_source: 'user' },
      ctx(),
    );
    expect(cls.merchant).toBe('My Woolies Run');
  });

  it('user rule overrides merchant default category', () => {
    // Seed would give Groceries; a rule forcing Shopping must win.
    const r = rule({ conditions: { merchant_contains: 'WOOLWORTHS' }, actions: { category: 'Shopping' } });
    const cls = classifyTransaction({ ...base, source: 'basiq' }, ctx({ rules: [r] }));
    expect(cls.category).toBe('Shopping');
    expect(cls.category_source).toBe('rule');
  });

  it('merchant default beats provider category', () => {
    // Basiq says "Other"; the resolved Woolworths merchant default (Groceries) wins.
    const cls = classifyTransaction(
      { ...base, source: 'basiq', category: 'Other', category_source: 'basiq' },
      ctx(),
    );
    expect(cls.category).toBe('Groceries');
    expect(cls.category_source).toBe('merchant');
  });

  it('provider category is used when there is no merchant/rule match', () => {
    const cls = classifyTransaction(
      { merchant: 'SOME OBSCURE SHOP', raw_description: 'SOME OBSCURE SHOP', amount: -20, account_id: 'a',
        source: 'basiq', category: 'Cafes and restaurants', category_source: 'basiq' },
      ctx(),
    );
    expect(cls.category).toBe('Dining');
    expect(cls.category_source).toBe('basiq');
  });

  it('falls back to keyword autoCategory, then Uncategorised', () => {
    const kw = classifyTransaction(
      { merchant: 'BP Connect Southport', raw_description: 'BP CONNECT', amount: -80, account_id: 'a', source: 'manual' },
      ctx(),
    );
    expect(kw.category).toBe('Fuel'); // BP seed → Fuel (merchant), still Fuel

    const none = classifyTransaction(
      { merchant: 'Zxqw Unknown', raw_description: 'ZXQW UNKNOWN', amount: -5, account_id: 'a', source: 'manual' },
      ctx(),
    );
    expect(none.category).toBe(UNCATEGORISED);
  });

  it('classifies manual / statement / basiq IDENTICALLY for the same description', () => {
    const shared = { merchant: 'WOOLWORTHS 1234', raw_description: 'WOOLWORTHS 1234', amount: -33, account_id: 'a' };
    const manual = classifyTransaction({ ...shared, source: 'manual' }, ctx());
    const statement = classifyTransaction({ ...shared, source: 'statement' }, ctx());
    const basiq = classifyTransaction({ ...shared, source: 'basiq' }, ctx());
    expect(manual.category).toBe('Groceries');
    expect(statement.category).toBe('Groceries');
    expect(basiq.category).toBe('Groceries');
    expect(manual.merchant).toBe('Woolworths');
    expect(statement.merchant).toBe('Woolworths');
    expect(basiq.merchant).toBe('Woolworths');
  });

  it('rule stamps tags / entity / tax without touching an explicit user category', () => {
    const r = rule({
      conditions: { merchant_contains: 'WOOLWORTHS' },
      actions: { tags: ['work'], entity: 'business', is_tax_deductible: true, category: 'Shopping' },
    });
    const cls = classifyTransaction(
      { ...base, source: 'manual', category: 'Groceries', category_source: 'user' },
      ctx({ rules: [r] }),
    );
    expect(cls.category).toBe('Groceries');       // user choice preserved
    expect(cls.tags).toContain('work');            // rule metadata still applied
    expect(cls.entity).toBe('business');
    expect(cls.is_tax_deductible).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  RAW DESCRIPTION IMMUTABILITY  +  LEARN-FROM-CORRECTIONS PLANNER
// ═══════════════════════════════════════════════════════════════════════════
describe('raw_description is never mutated by classification', () => {
  it('keeps raw_description while cleaning the display merchant', () => {
    const stamped = stampIngest({
      merchant: 'WOOLWORTHS 1234 ROBINA', amount: -50, source: 'basiq',
    });
    const cls = classifyTransaction(
      { merchant: 'WOOLWORTHS 1234 ROBINA', raw_description: stamped.raw_description, amount: -50, account_id: 'a', source: 'basiq' },
      ctx(),
    );
    // Display merchant is cleaned…
    expect(cls.merchant).toBe('Woolworths');
    // …but the raw description we fed in is untouched (classifier never returns it).
    expect(stamped.raw_description).toBe('WOOLWORTHS 1234 ROBINA');
    expect('raw_description' in cls).toBe(false);
  });
});

describe('learn-from-corrections planner', () => {
  it('a one-off edit ("only") creates NO rule and NO alias', () => {
    const plan = planCorrection({ type: 'normalized', pattern: 'woolworths' }, { category: 'Dining' }, 'only');
    expect(plan.rule).toBeUndefined();
    expect(plan.merchant).toBeUndefined();
    expect(plan.applyToExisting).toBe(false);
  });

  it('"future" (unrecognised merchant) keys the rule on the exact normalised key', () => {
    const plan = planCorrection({ type: 'normalized', pattern: 'bob corner store' }, { category: 'Dining' }, 'future');
    expect(plan.rule?.conditions.merchant_normalized).toBe('bob corner store');
    expect(plan.rule?.actions.category).toBe('Dining');
    expect(plan.applyToExisting).toBe(false);
  });

  it('"future" (recognised merchant) keys the rule on a BROAD brand contains-match', () => {
    const plan = planCorrection({ type: 'contains', pattern: 'WOOLWORTHS' }, { category: 'Dining' }, 'future');
    expect(plan.rule?.conditions.merchant_contains).toBe('WOOLWORTHS');
    expect(plan.rule?.conditions.merchant_normalized).toBeUndefined();
  });

  it('"future" with a merchant change creates a merchant + matching alias', () => {
    const plan = planCorrection(
      { type: 'contains', pattern: 'WOOLWORTHS' },
      { merchant: 'Woolies', category: 'Dining' },
      'future',
    );
    expect(plan.merchant?.display_name).toBe('Woolies');
    expect(plan.merchant?.merchant_normalized).toBe('woolworths');
    expect(plan.merchant?.default_category).toBe('Dining');
    expect(plan.alias).toEqual({ pattern: 'WOOLWORTHS', match_type: 'contains' });
  });

  it('a pure rename inherits the recognised default category (never strips it)', () => {
    const plan = planCorrection(
      { type: 'contains', pattern: 'WOOLWORTHS' },
      { merchant: 'Woolies' }, // no category change
      'future',
      { merchantDefaultCategory: 'Groceries' },
    );
    expect(plan.rule).toBeUndefined();                     // category untouched
    expect(plan.merchant?.default_category).toBe('Groceries'); // but kept
  });

  it('"existing" additionally requests retro-apply', () => {
    expect(planCorrection({ type: 'contains', pattern: 'WOOLWORTHS' }, { category: 'Dining' }, 'existing').applyToExisting).toBe(true);
  });

  it('never keys learning on an empty pattern', () => {
    const plan = planCorrection({ type: 'normalized', pattern: '' }, { category: 'Dining' }, 'future');
    expect(plan.rule).toBeUndefined();
    expect(plan.merchant).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 2D.2 — BUSINESS vs PERSONAL classification (planner + engine)
//  The entity choice reuses the SAME rules engine as category; these guard that
//  a "future"/"existing" classification teaches a rule, that a category and an
//  entity for one merchant live in ONE rule, and that the engine stamps + isolates
//  entity exactly like every other rule action.
// ═══════════════════════════════════════════════════════════════════════════
describe('business/personal classification learning', () => {
  it('"only" classifies just the row — no rule taught', () => {
    const plan = planCorrection({ type: 'contains', pattern: 'WOOLWORTHS' }, { entity: 'business' }, 'only');
    expect(plan.rule).toBeUndefined();
  });

  it('"future" with entity alone teaches a rule that stamps the entity', () => {
    const plan = planCorrection({ type: 'contains', pattern: 'WOOLWORTHS' }, { entity: 'business' }, 'future');
    expect(plan.rule?.conditions.merchant_contains).toBe('WOOLWORTHS');
    expect(plan.rule?.actions.entity).toBe('business');
    expect(plan.rule?.actions.category).toBeUndefined();
  });

  it('a category + entity correction produces ONE rule carrying both actions', () => {
    const plan = planCorrection(
      { type: 'contains', pattern: 'WOOLWORTHS' },
      { category: 'Office supplies', entity: 'business' },
      'future',
    );
    expect(plan.rule?.actions.category).toBe('Office supplies');
    expect(plan.rule?.actions.entity).toBe('business');
    expect(plan.rule?.label).toBe('WOOLWORTHS → Office supplies · business');
  });

  it('the engine stamps entity from an entity-only rule, over any prior value', () => {
    const r = rule({ conditions: { merchant_contains: 'WOOLWORTHS' }, actions: { entity: 'business' } });
    const cls = classifyTransaction(
      { raw_description: 'WOOLWORTHS 1234', merchant: 'Woolworths', account_id: 'a', amount: -20, source: 'basiq', entity: 'personal' },
      ctx({ rules: [r] }),
    );
    expect(cls.entity).toBe('business');
  });

  it('an entity rule owned by ANOTHER user never classifies my transaction', () => {
    const foreign = rule({ user_id: OTHER, conditions: { merchant_contains: 'WOOLWORTHS' }, actions: { entity: 'business' } });
    const c = candidate({ raw_description: 'WOOLWORTHS 1234', merchant: 'Woolworths' });
    expect(applyRules(c, [foreign], ME)).toBeNull();                 // dropped for me
    expect(applyRules(c, [foreign], OTHER)?.actions.entity).toBe('business'); // still theirs
  });

  it('a learned entity rule fires across all of a merchant\'s variants (historical breadth)', () => {
    const plan = planCorrection({ type: 'contains', pattern: 'WOOLWORTHS' }, { entity: 'business' }, 'existing');
    expect(plan.applyToExisting).toBe(true);
    const r = rule({ conditions: plan.rule!.conditions, actions: plan.rule!.actions });
    for (const raw of ['WOOLWORTHS 5678 SYDNEY', 'WOOLWORTHS ONLINE']) {
      const c = candidate({ raw_description: raw, merchant: raw, merchant_normalized: 'x' });
      expect(applyRules(c, [r], ME)?.actions.entity, raw).toBe('business');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  CORRECTION BREADTH — a correction must cover ALL of a merchant's variants,
//  not just the one transaction it was made on.
// ═══════════════════════════════════════════════════════════════════════════
describe('a learned correction generalises across a merchant\'s variants', () => {
  const mctx = { merchants: [], aliases: [], userId: ME };

  it('derives the SAME brand token across store numbers / locations / online', () => {
    // A real account uses ONE spelling per merchant; the token is that spelling,
    // shared by every store number, suburb and the online charge.
    const variants = ['WOOLWORTHS 1234 ROBINA', 'WOOLWORTHS ONLINE', 'WOOLWORTHS 5678 SYDNEY', 'WOOLWORTHS'];
    for (const raw of variants) {
      expect(merchantMatchToken(resolveMerchant(raw, mctx), raw), raw).toBe('WOOLWORTHS');
    }
  });

  it('still yields a broad (non-null) token for an alternate bank spelling', () => {
    // A bank that abbreviates gets its OWN family token — still broad, not the one line.
    expect(merchantMatchToken(resolveMerchant('W/WORTHS ROBINA', mctx), 'W/WORTHS ROBINA')).toBe('W/WORTHS');
  });

  it('a rule learned on one Woolworths store matches a DIFFERENT Woolworths transaction', () => {
    // Learn from the Robina store…
    const learnedFrom = 'WOOLWORTHS 1234 ROBINA';
    const token = merchantMatchToken(resolveMerchant(learnedFrom, mctx), learnedFrom);
    const plan = planCorrection({ type: 'contains', pattern: token! }, { category: 'Dining' }, 'future');

    // …and it fires on the Sydney store + the online charge, not just Robina.
    const rule: TransactionRule = {
      id: 'learned', user_id: ME, priority: plan.rule!.priority, enabled: true,
      conditions: plan.rule!.conditions, actions: plan.rule!.actions, created_at: '2026-02-01T00:00:00Z',
    };
    for (const raw of ['WOOLWORTHS 5678 SYDNEY', 'WOOLWORTHS ONLINE']) {
      const c = candidate({ raw_description: raw, merchant: raw, merchant_normalized: 'x' });
      expect(applyRules(c, [rule], ME)?.actions.category, raw).toBe('Dining');
    }
    // …but leaves an unrelated merchant alone.
    const other = candidate({ raw_description: 'COLES 999', merchant: 'Coles', merchant_normalized: 'coles' });
    expect(applyRules(other, [rule], ME)).toBeNull();
  });

  it('unrecognised merchant → null token (caller uses the narrow exact key)', () => {
    const raw = "BOB'S CORNER STORE";
    expect(merchantMatchToken(resolveMerchant(raw, mctx), raw)).toBeNull();
  });
});
