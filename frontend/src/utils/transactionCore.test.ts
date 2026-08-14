import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import {
  isSpendTransaction, spendAmount, totalSpend, spendByCategory,
  computeContentHash, findExactDuplicate, findTransferMatch,
  computeTransferExclusionIds, stampIngest, looksLikeCardRepayment,
  isMultiplicityDuplicate, classifyDuplicate, resolveTransferSiblings,
  isTransferTransaction, transferInAmount, transferOutAmount,
  totalTransferIn, totalTransferOut, netMovement,
  totalIncomeInflow, incomeInflowAmount, totalRefunds, refundReduction,
  type IncomingCandidate,
} from './transactionCore';
import type { TransactionSource } from '../types';
import { detectInternalTransferIds } from './recurringDetection';

// ── Test fixture factory ──────────────────────────────────────────────────────
let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1',
    account_id: 'acc-bank',
    account_type: 'bank',
    date: '2026-08-01',
    merchant: 'Merchant',
    currency: 'AUD',
    category: 'Other',
    is_duplicate_flagged: false,
    is_subscription: false,
    ...partial,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 3 — one canonical spend definition
// ═══════════════════════════════════════════════════════════════════════════════
describe('canonical spend definition', () => {
  it('counts a normal purchase as spending', () => {
    const t = tx({ amount: -50, category: 'Food', merchant: 'Woolworths' });
    expect(isSpendTransaction(t)).toBe(true);
    expect(spendAmount(t)).toBe(50);
  });

  it('does NOT count salary / income', () => {
    const t = tx({ amount: 5000, category: 'Income', merchant: 'ACME PAYROLL' });
    expect(isSpendTransaction(t)).toBe(false);
    expect(spendAmount(t)).toBe(0);
  });

  it('does NOT count a refund (inflow)', () => {
    const t = tx({ amount: 25, category: 'Shopping', merchant: 'Refund' });
    expect(isSpendTransaction(t)).toBe(false);
  });

  it('does NOT count a bank→savings transfer (both legs)', () => {
    const out = tx({ id: 'o', amount: -500, account_id: 'acc-bank', merchant: 'Transfer to xx1234' });
    const inc = tx({ id: 'i', amount: 500, account_id: 'acc-savings', merchant: 'Transfer from xx9999', date: '2026-08-01' });
    const set = computeTransferExclusionIds([out, inc], detectInternalTransferIds);
    expect(set.has('o')).toBe(true);
    expect(set.has('i')).toBe(true);
    expect(spendAmount(out, { excludeIds: set })).toBe(0);
    expect(spendAmount(inc, { excludeIds: set })).toBe(0);
  });

  it('does NOT count a credit-card repayment as spending', () => {
    const repay = tx({ amount: -300, account_type: 'bank', merchant: 'AMEX PAYMENT' });
    const set = computeTransferExclusionIds([repay], detectInternalTransferIds);
    expect(looksLikeCardRepayment('AMEX PAYMENT')).toBe(true);
    expect(spendAmount(repay, { excludeIds: set })).toBe(0);
  });

  it('DOES count a credit-card purchase as spending', () => {
    const t = tx({ amount: -80, account_type: 'credit_card', category: 'Food', merchant: 'Cafe' });
    expect(spendAmount(t)).toBe(80);
  });

  it('excludes a persisted transfer leg via is_transfer flag', () => {
    const t = tx({ amount: -200, is_transfer: true, transfer_pair_id: 'p1' });
    expect(isSpendTransaction(t)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Transfer flow — per-account money movement (in / out / net)
// ═══════════════════════════════════════════════════════════════════════════════
describe('per-account transfer flow', () => {
  it('a transaction_type=transfer leg is excluded from spend AND counted as flow', () => {
    const out = tx({ amount: -500, transaction_type: 'transfer', merchant: 'Transfer to savings' });
    // Not spending...
    expect(isSpendTransaction(out)).toBe(false);
    // ...but it IS an internal transfer leg and money leaving the account.
    expect(isTransferTransaction(out)).toBe(true);
    expect(transferOutAmount(out)).toBe(500);
    expect(transferInAmount(out)).toBe(0);
  });

  it('splits transfers into money in vs money out for one account', () => {
    const inLeg = tx({ id: 'in', amount: 500, is_transfer: true, transfer_pair_id: 'p1' });
    const outLeg = tx({ id: 'out', amount: -200, is_transfer: true, transfer_pair_id: 'p2' });
    const buy = tx({ id: 'buy', amount: -30, category: 'Food' });
    const rows = [inLeg, outLeg, buy];
    expect(totalTransferIn(rows)).toBe(500);
    expect(totalTransferOut(rows)).toBe(200);
    // The genuine purchase is NOT transfer flow.
    expect(transferInAmount(buy) + transferOutAmount(buy)).toBe(0);
  });

  it('honours the shared exclusion set (detected pairs + repayments) as transfer flow', () => {
    const debit = tx({ id: 'o', amount: -500, account_id: 'acc-bank', merchant: 'Transfer to xx1234' });
    const credit = tx({ id: 'i', amount: 500, account_id: 'acc-savings', merchant: 'Transfer from xx9999' });
    const set = computeTransferExclusionIds([debit, credit], detectInternalTransferIds);
    const opts = { excludeIds: set };
    expect(transferOutAmount(debit, opts)).toBe(500);
    expect(transferInAmount(credit, opts)).toBe(500);
  });

  it('prefers display_amount for the flow magnitude', () => {
    const leg = tx({ amount: -100, display_amount: -150, is_transfer: true, transfer_pair_id: 'p' });
    expect(transferOutAmount(leg)).toBe(150);
  });

  it('net movement sums ALL signed activity, transfers included', () => {
    const salary = tx({ amount: 5000, category: 'Income' });
    const inLeg = tx({ amount: 500, is_transfer: true, transfer_pair_id: 'p1' });
    const outLeg = tx({ amount: -200, is_transfer: true, transfer_pair_id: 'p2' });
    const buy = tx({ amount: -30, category: 'Food' });
    // 5000 + 500 - 200 - 30 = 5270 — distinct from spend (30) and transfers.
    expect(netMovement([salary, inLeg, outLeg, buy])).toBe(5270);
    expect(totalSpend([salary, inLeg, outLeg, buy], {
      excludeIds: computeTransferExclusionIds([salary, inLeg, outLeg, buy], detectInternalTransferIds),
    })).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 3 — every surface agrees on the same total
// ═══════════════════════════════════════════════════════════════════════════════
describe('Accounts, Budget and integrationSummary agree on spend', () => {
  // A representative mixed set (transfers already persisted, as after ingestion).
  const set: Transaction[] = [
    tx({ amount: -50, category: 'Food', merchant: 'Woolworths' }),      // spend 50
    tx({ amount: -80, category: 'Transport', merchant: 'Uber' }),        // spend 80
    tx({ amount: 5000, category: 'Income', merchant: 'PAYROLL' }),       // income
    tx({ amount: 30, category: 'Shopping', merchant: 'Refund' }),        // refund
    tx({ amount: -500, is_transfer: true, transfer_pair_id: 'p', merchant: 'Transfer to xx1' }),
    tx({ amount: 500, is_transfer: true, transfer_pair_id: 'p', account_id: 'acc-savings', merchant: 'Transfer from xx1' }),
    tx({ amount: -300, account_type: 'bank', merchant: 'AMEX PAYMENT', category: 'Other' }), // repayment
    tx({ amount: -120, account_type: 'credit_card', category: 'Food', merchant: 'Restaurant' }), // spend 120
  ];
  const excludeIds = computeTransferExclusionIds(set, detectInternalTransferIds);

  it('Accounts-style total equals Budget-style total', () => {
    const accountsTotal = totalSpend(set, { excludeIds });
    const budgetMap = spendByCategory(set, { excludeIds });
    const budgetTotal = Object.values(budgetMap).reduce((a, b) => a + b, 0);
    expect(accountsTotal).toBe(budgetTotal);
    expect(accountsTotal).toBe(50 + 80 + 120);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — raw data preservation
// ═══════════════════════════════════════════════════════════════════════════════
describe('raw data preservation (stampIngest)', () => {
  it('keeps the raw description when merchant is the enriched name', () => {
    const stamped = stampIngest({
      merchant: 'Netflix',                      // enriched display name
      raw_description: 'DIRECT DEBIT 123456 NETFLIX', // original
      amount: -15.99, source: 'basiq',
    });
    expect(stamped.raw_description).toBe('DIRECT DEBIT 123456 NETFLIX');
    expect(stamped.merchant).toBe('Netflix');
    expect(stamped.merchant_normalized).toBe('netflix');
  });

  it('defaults raw_description to merchant when no raw is supplied', () => {
    const stamped = stampIngest({ merchant: 'Local Cafe', amount: -6, source: 'manual' });
    expect(stamped.raw_description).toBe('Local Cafe');
  });

  it('raw_description survives a merchant edit (update never touches raw)', () => {
    const record = tx({ amount: -6, merchant: 'UNKNOWN CAFE 123', raw_description: 'UNKNOWN CAFE 123' });
    const edited = { ...record, merchant: 'My Favourite Cafe' }; // how transactionsDS.update merges
    expect(edited.raw_description).toBe('UNKNOWN CAFE 123');
    expect(edited.merchant).toBe('My Favourite Cafe');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 5 — duplicate identity
// ═══════════════════════════════════════════════════════════════════════════════
describe('duplicate identity', () => {
  it('gives identical hashes to a re-imported statement line', () => {
    const a = { user_id: 'u1', account_id: 'acc', date: '2026-08-01', amount: -4.5, merchant: 'CAFE SYDNEY' };
    const b = { user_id: 'u1', account_id: 'acc', date: '2026-08-01', amount: -4.5, merchant: 'CAFE SYDNEY NSW AUS' };
    // Normalised merchant collapses the trailing noise → same identity.
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('distinguishes different amounts / dates / accounts', () => {
    const base = { user_id: 'u1', account_id: 'acc', date: '2026-08-01', amount: -4.5, merchant: 'CAFE' };
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, amount: -4.51 }));
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, date: '2026-08-02' }));
    expect(computeContentHash(base)).not.toBe(computeContentHash({ ...base, account_id: 'acc2' }));
  });

  it('findExactDuplicate prefers an exact provider/source ref (basiq idempotency)', () => {
    const existing = [tx({ amount: -9, basiq_tx_id: 'basiq-abc' })];
    const dup = findExactDuplicate({ amount: -9, basiq_tx_id: 'basiq-abc' }, existing);
    expect(dup?.reason).toBe('source_ref');
  });

  it('findExactDuplicate falls back to content_hash', () => {
    const existing = [tx({ amount: -12, merchant: 'BAKERY', date: '2026-08-03', account_id: 'acc' })];
    const dup = findExactDuplicate(
      { amount: -12, merchant: 'BAKERY', date: '2026-08-03', account_id: 'acc', user_id: 'u1' },
      existing,
    );
    expect(dup?.reason).toBe('content_hash');
  });

  // The batch-import multiplicity rule that lets two legit same-value purchases
  // coexist while a full statement re-import adds nothing. Simulates the exact
  // loop transactionsDS.ingest runs with a shared batchState.
  function importBatch(existingCount: number, batchSize: number): number {
    let processed = 0;
    let added = 0;
    for (let i = 0; i < batchSize; i++) {
      if (isMultiplicityDuplicate(existingCount, processed)) {
        // skip — already represented in the store
      } else {
        added++;
      }
      processed++;
    }
    return added;
  }

  it('two same-value purchases in one import BOTH survive', () => {
    expect(importBatch(0, 2)).toBe(2);
  });

  it('re-importing the same statement adds nothing', () => {
    expect(importBatch(2, 2)).toBe(0);
  });

  it('re-import that also contains one new distinct purchase adds only the new one', () => {
    expect(importBatch(1, 2)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DUPLICATE MULTIPLICITY — full policy (scenarios A–F)
// ═══════════════════════════════════════════════════════════════════════════════
describe('duplicate multiplicity policy (classifyDuplicate)', () => {
  // A stored row carrying an explicit content_hash + source (+ optional ref).
  function stored(source: TransactionSource, hash: string, extra: Partial<Transaction> = {}): Transaction {
    return tx({ amount: -1, content_hash: hash, source, ...extra });
  }
  // Simulate one ingest step: classify, and if kept, append to the store.
  function step(
    existing: Transaction[], cand: IncomingCandidate,
    batchState: Map<string, number>, allowDuplicate = false,
  ) {
    const d = classifyDuplicate(cand, existing, { batchState, allowDuplicate });
    if (!d.isDuplicate) {
      existing.push(stored(cand.source, cand.content_hash, {
        basiq_tx_id: cand.basiq_tx_id ?? undefined,
        source_ref: cand.source_ref ?? undefined,
        review_status: d.reviewFlag ?? 'clear',
      }));
    }
    return d;
  }
  const cand = (source: TransactionSource, hash: string, extra: Partial<IncomingCandidate> = {}): IncomingCandidate =>
    ({ source, content_hash: hash, ...extra });

  it('A — two legitimate identical transactions in one statement both coexist', () => {
    const store: Transaction[] = [];
    const bs = new Map<string, number>();
    const d1 = step(store, cand('statement', 'H'), bs);
    const d2 = step(store, cand('statement', 'H'), bs);
    expect(d1.isDuplicate).toBe(false);
    expect(d2.isDuplicate).toBe(false);
    expect(store).toHaveLength(2);
  });

  it('B — re-importing the exact same statement keeps the count at exactly 2', () => {
    const store: Transaction[] = [];
    // First import: ONE shared batchState across the file's lines.
    const imp1 = new Map<string, number>();
    step(store, cand('statement', 'H'), imp1);
    step(store, cand('statement', 'H'), imp1);
    expect(store).toHaveLength(2);
    // Second import of the same file: a fresh batchState.
    const imp2 = new Map<string, number>();
    const r1 = step(store, cand('statement', 'H'), imp2);
    const r2 = step(store, cand('statement', 'H'), imp2);
    expect(r1.isDuplicate).toBe(true);
    expect(r2.isDuplicate).toBe(true);
    expect(store).toHaveLength(2);
  });

  it('C — a statement line is NOT silently dropped by a matching MANUAL entry (flagged instead)', () => {
    const store: Transaction[] = [stored('manual', 'Hwool')]; // manual Woolworths -54.20
    const d = step(store, cand('statement', 'Hwool'), new Map());
    expect(d.isDuplicate).toBe(false);          // preserved, not deleted
    expect(d.reviewFlag).toBe('needs_review');  // surfaced as a possible dup
    expect(store).toHaveLength(2);
  });

  it('D — the same basiq_tx_id received repeatedly yields exactly one', () => {
    const store: Transaction[] = [];
    const d1 = classifyDuplicate(cand('basiq', 'Hb', { basiq_tx_id: 'X' }), store);
    expect(d1.isDuplicate).toBe(false);
    store.push(stored('basiq', 'Hb', { basiq_tx_id: 'X' }));
    const d2 = classifyDuplicate(cand('basiq', 'Hb', { basiq_tx_id: 'X' }), store);
    expect(d2.isDuplicate).toBe(true);
    expect(d2.reason).toBe('source_ref');
  });

  it('E — two Basiq txns with different ids but identical content both survive (across syncs)', () => {
    const store: Transaction[] = [stored('basiq', 'Hb', { basiq_tx_id: 'X' })];
    // separate sync → fresh batch; strong id proves this is a DISTINCT event
    const d = step(store, cand('basiq', 'Hb', { basiq_tx_id: 'Y' }), new Map());
    expect(d.isDuplicate).toBe(false);
    expect(d.reviewFlag).toBeUndefined(); // same source, no cross-source ambiguity
    expect(store).toHaveLength(2);
  });

  it('F — statement-vs-statement identical content dedups (documented: same signal as B)', () => {
    // Two different files with an identical-looking line are indistinguishable
    // from a re-import; genuinely-distinct same-value purchases would appear in
    // ONE statement (scenario A) and are kept there.
    const store: Transaction[] = [stored('statement', 'Hf')];
    const d = step(store, cand('statement', 'Hf'), new Map());
    expect(d.isDuplicate).toBe(true);
  });

  it('a second identical line in the SAME source is not review-flagged (only cross-source is)', () => {
    const store: Transaction[] = [];
    const bs = new Map<string, number>();
    step(store, cand('statement', 'H'), bs);
    const d2 = step(store, cand('statement', 'H'), bs);
    expect(d2.reviewFlag).toBeUndefined();
  });

  it('manual explicit adds (allowDuplicate) never dedup but still flag cross-source collisions', () => {
    const store: Transaction[] = [stored('statement', 'Hx')];
    const d = step(store, cand('manual', 'Hx'), new Map(), /*allowDuplicate*/ true);
    expect(d.isDuplicate).toBe(false);
    expect(d.reviewFlag).toBe('needs_review');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  REFUND SEMANTICS
// ═══════════════════════════════════════════════════════════════════════════════
describe('refund semantics', () => {
  it('a positive refund is neither spending nor income, and type is not guessed from sign', () => {
    const refund = tx({ amount: 54.2, category: 'Shopping', merchant: 'Woolworths refund' });
    expect(isSpendTransaction(refund)).toBe(false); // not counted as spend
    expect(refund.transaction_type).toBeUndefined(); // NOT auto-classified as income
    expect(spendAmount(refund)).toBe(0);
  });

  it('does not net against spending in Phase 2A (documented limitation)', () => {
    const set: Transaction[] = [
      tx({ amount: -54.2, category: 'Shopping', merchant: 'Woolworths' }),
      tx({ amount: 54.2, category: 'Shopping', merchant: 'Woolworths refund' }),
    ];
    // Purchase counts; refund is simply excluded (no netting yet).
    expect(totalSpend(set)).toBe(54.2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Account-summary maths: In / Spent / Net / Refunds agree across the scenarios.
//  A matched refund (transaction_type='refund') is NOT income, reduces net spend,
//  and moves account cash — transfers stay separate.
// ═══════════════════════════════════════════════════════════════════════════════
describe('account summary: refunds are not income, reduce net spend, move cash', () => {
  const purchase = () => tx({ amount: -100, category: 'Shopping', merchant: 'JB Hi-Fi' });
  const refund = (amount: number) =>
    tx({ amount, category: 'Shopping', merchant: 'JB Hi-Fi refund', transaction_type: 'refund' });

  it('purchase only', () => {
    const set = [purchase()];
    expect(totalIncomeInflow(set)).toBe(0);
    expect(totalSpend(set)).toBe(100);
    expect(netMovement(set)).toBe(-100);
    expect(totalRefunds(set)).toBe(0);
  });

  it('purchase + full refund → In 0, Spent 0, Net 0, Refunds 100', () => {
    const set = [purchase(), refund(100)];
    expect(totalIncomeInflow(set)).toBe(0);   // refund is not income
    expect(totalSpend(set)).toBe(0);          // fully netted
    expect(netMovement(set)).toBe(0);         // cash back in full
    expect(totalRefunds(set)).toBe(100);
  });

  it('purchase + partial refund → In 0, Spent 70, Net -70, Refunds 30 (the reported bug)', () => {
    const set = [purchase(), refund(30)];
    expect(totalIncomeInflow(set)).toBe(0);   // the $30 must NOT show under "In this month"
    expect(totalSpend(set)).toBe(70);         // 100 − 30
    expect(netMovement(set)).toBe(-70);       // cash movement reduced by the refund
    expect(totalRefunds(set)).toBe(30);
  });

  it('salary + refund → salary is income, refund is not', () => {
    const salary = tx({ amount: 5000, category: 'Salary', merchant: 'Employer' });
    const set = [salary, purchase(), refund(30)];
    expect(totalIncomeInflow(set)).toBe(5000); // only the salary
    expect(totalSpend(set)).toBe(70);
    expect(netMovement(set)).toBe(5000 - 100 + 30); // 4930
    expect(totalRefunds(set)).toBe(30);
  });

  it('transfer + refund → transfer stays separate from income, spend and refunds', () => {
    const transferIn = tx({ amount: 200, is_transfer: true, merchant: 'Transfer in' });
    const set = [transferIn, purchase(), refund(30)];
    expect(totalIncomeInflow(set)).toBe(0);   // the transfer is not income
    expect(totalSpend(set)).toBe(70);
    expect(totalRefunds(set)).toBe(30);       // the transfer is not a refund
    expect(totalTransferIn(set)).toBe(200);
    // A refund is never mistaken for a transfer leg, and vice-versa.
    expect(refundReduction(transferIn)).toBe(0);
    expect(incomeInflowAmount(refund(30))).toBe(0);
  });

  it('totals are pure — identical input yields identical output after a "refresh"', () => {
    const build = () => [purchase(), refund(30)];
    expect(totalSpend(build())).toBe(totalSpend(build()));
    expect(totalIncomeInflow(build())).toBe(totalIncomeInflow(build()));
    expect(netMovement(build())).toBe(netMovement(build()));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 4 — transfer matching
// ═══════════════════════════════════════════════════════════════════════════════
describe('transfer matching', () => {
  it('matches a bank→credit-card repayment across accounts (high confidence)', () => {
    const existing = [tx({ id: 'card-side', amount: 300, account_id: 'acc-card', account_type: 'credit_card', merchant: 'Payment received' })];
    const candidate = tx({ id: 'bank-side', amount: -300, account_id: 'acc-bank', merchant: 'AMEX PAYMENT' });
    const m = findTransferMatch(candidate, existing);
    expect(m?.counterparty.id).toBe('card-side');
  });

  it('does NOT match two unrelated same-amount purchases (conservative)', () => {
    const existing = [tx({ id: 'a', amount: -20, account_id: 'acc-bank', merchant: 'Woolworths' })];
    const candidate = tx({ id: 'b', amount: -20, account_id: 'acc-card', account_type: 'credit_card', merchant: 'Coles' });
    // same sign, and neither looks like an internal movement → no match
    expect(findTransferMatch(candidate, existing)).toBeUndefined();
  });

  it('requires opposite direction, same magnitude, within 2 days', () => {
    const existing = [tx({ id: 'far', amount: 500, account_id: 'acc-savings', merchant: 'Transfer', date: '2026-08-10' })];
    const candidate = tx({ id: 'near', amount: -500, account_id: 'acc-bank', merchant: 'Transfer to savings', date: '2026-08-01' });
    expect(findTransferMatch(candidate, existing)).toBeUndefined(); // 9 days apart
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Transfer-pair resolution — deleting one leg must take the whole pair
// ═══════════════════════════════════════════════════════════════════════════════
describe('resolveTransferSiblings', () => {
  const outLeg = tx({ id: 'out', amount: -200, account_id: 'acc-bank', transfer_pair_id: 'pair-1' });
  const inLeg = tx({ id: 'in', amount: 200, account_id: 'acc-savings', transfer_pair_id: 'pair-1' });
  const unrelated = tx({ id: 'other', amount: -50, account_id: 'acc-bank', transfer_pair_id: 'pair-2' });
  const all = [outLeg, inLeg, unrelated];

  it('finds the counter-leg from the OUT side', () => {
    expect(resolveTransferSiblings('out', all).map(t => t.id)).toEqual(['in']);
  });

  it('finds the counter-leg from the IN side (symmetric — deletable from either account)', () => {
    expect(resolveTransferSiblings('in', all).map(t => t.id)).toEqual(['out']);
  });

  it('never returns transactions from a different pair', () => {
    expect(resolveTransferSiblings('out', all).map(t => t.id)).not.toContain('other');
  });

  it('returns [] for a non-transfer transaction (no pair id)', () => {
    const plain = tx({ id: 'plain', amount: -10, account_id: 'acc-bank' });
    expect(resolveTransferSiblings('plain', [plain, ...all])).toEqual([]);
  });

  it('missing-pair safety: a lone surviving leg resolves to [] so it deletes alone', () => {
    // The counter-leg is already gone — only the out-leg remains.
    expect(resolveTransferSiblings('out', [outLeg])).toEqual([]);
  });

  it('returns [] when the id is not present at all', () => {
    expect(resolveTransferSiblings('ghost', all)).toEqual([]);
  });
});
