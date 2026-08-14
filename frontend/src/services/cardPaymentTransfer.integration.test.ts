import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
});

// Mock the network layer so the real dataService runs against the real store.
vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import {
  applyCardPayment,
  transactionsDS,
  creditCardStatementsDS,
} from './dataService';
import type { BankAccount, CreditCard, CreditCardStatement, Transaction } from '../types';

// ── Integration coverage for bank→credit-card payments ────────────────────────
// Drives the REAL dataService against the REAL store (network mocked). Pins the
// user-reported bug: a card payment must reduce the card's statement (the balance
// authority) so it SURVIVES a re-sync/refresh recompute — a bare balance move used
// to be clobbered back to the old owing. Covers the Transfer-button path and the
// confirm/reconcile path, partial/full/multiple payments, refresh, and deletion
// from either leg.

const mkBank = (): BankAccount => ({
  id: 'bank1', user_id: 'u1', name: 'Everyday', institution: 'ANZ',
  balance: 5000, display_balance: 5000, currency: 'AUD', conversion_rate: 1,
} as unknown as BankAccount);

const mkCard = (): CreditCard => ({
  id: 'card1', user_id: 'u1', name: 'Rewards', institution: 'ZZZBANK',
  balance_owing: 800, display_balance_owing: 800, currency: 'AUD', conversion_rate: 1,
  is_manual: false,
} as unknown as CreditCard);

const mkStmt = (): CreditCardStatement => ({
  id: 'stmt1', user_id: 'u1', credit_card_id: 'card1',
  closing_balance: 800, amount_paid: 0, status: 'unpaid',
  period_end: '2026-07-31', currency: 'AUD', created_at: '', updated_at: '',
} as unknown as CreditCardStatement);

const mkBankTx = (): Transaction => ({
  id: 'tx1', user_id: 'u1', account_id: 'bank1', account_type: 'bank',
  date: '2026-08-01', merchant: 'CARD PAYMENT', raw_description: 'CARD PAYMENT',
  amount: -500, currency: 'AUD', category: 'Transfer', category_source: 'user',
  is_duplicate_flagged: false, is_subscription: false, source: 'basiq',
  review_status: 'clear', review_reason: null,
} as unknown as Transaction);

function seed(withStatement = true) {
  const s = useStore.getState();
  s.setAccounts([mkBank()]);
  s.setCreditCards([mkCard()]);
  s.setCreditCardStatements(withStatement ? [mkStmt()] : []);
  s.setTransactions([]);
  s.setPendingPayments([]);
  s.setCcPaymentPrompts?.([]);
}

// Force the derive-from-statements recompute that a refresh / Basiq re-sync runs.
// This is what USED to revert owing to $800 when the payment wasn't on a statement.
function refreshRecompute() {
  creditCardStatementsDS.update('stmt1', {});
}

const owing = () => useStore.getState().creditCards.find(c => c.id === 'card1')!.balance_owing;
const stmtRow = () => useStore.getState().creditCardStatements.find(s => s.id === 'stmt1')!;
const cardLegs = () => useStore.getState().transactions.filter(t => t.account_id === 'card1');
const bankLegs = () => useStore.getState().transactions.filter(t => t.account_id === 'bank1');

// Mirror Accounts.tsx deleteTransaction "remove both" for a card payment.
function deleteRemoveBoth(legId: string) {
  const cp = transactionsDS.cardPaymentFor(legId);
  expect(cp).not.toBeNull();
  transactionsDS.reverseCardPayment(cp!.bankTxId);
  transactionsDS.removeAndReverseBalance(cp!.bankTxId);
}

beforeEach(() => seed());

describe('Transfer button (createTransfer bank→card) — the reported bug', () => {
  it('partial: settles the statement, $300 remaining, $800 total preserved, survives refresh', () => {
    transactionsDS.createTransfer({
      fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card',
      amount: 500, date: '2026-08-01',
    });

    expect(stmtRow().closing_balance).toBe(800);   // original total preserved
    expect(stmtRow().amount_paid).toBe(500);        // $500 recorded against it
    expect(stmtRow().status).toBe('partial');
    expect(owing()).toBe(300);                      // 800 − 500 remaining due

    // Card in-leg shows in the card's history (feeds "Transfers in this month").
    expect(cardLegs().length).toBe(1);
    expect(cardLegs()[0].amount).toBe(500);
    expect(cardLegs()[0].is_transfer).toBe(true);
    // Bank out-leg is an internal transfer, never spend.
    expect(bankLegs()[0].amount).toBe(-500);
    expect(bankLegs()[0].is_transfer).toBe(true);

    // THE FIX: a refresh/re-sync recompute must NOT revert owing to $800.
    refreshRecompute();
    expect(owing()).toBe(300);
  });

  it('full: pays the statement off, owing 0, survives refresh', () => {
    transactionsDS.createTransfer({
      fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card',
      amount: 800, date: '2026-08-01',
    });
    expect(stmtRow().status).toBe('paid');
    expect(stmtRow().closing_balance).toBe(800);
    expect(owing()).toBe(0);
    refreshRecompute();
    expect(owing()).toBe(0);
  });

  it('multiple payments: two transfers accumulate on the statement, survive refresh', () => {
    transactionsDS.createTransfer({ fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card', amount: 300, date: '2026-08-01' });
    transactionsDS.createTransfer({ fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card', amount: 200, date: '2026-08-05' });
    expect(stmtRow().amount_paid).toBe(500);
    expect(owing()).toBe(300);
    expect(cardLegs().length).toBe(2);
    refreshRecompute();
    expect(owing()).toBe(300);
  });

  it('no statement: falls back to a direct owing reduction', () => {
    seed(false); // card has no statement
    transactionsDS.createTransfer({ fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card', amount: 500, date: '2026-08-01' });
    expect(owing()).toBe(300);
    expect(cardLegs().length).toBe(1);
  });

  it('delete from the BANK leg: reverses owing exactly once, removes both legs', () => {
    transactionsDS.createTransfer({ fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card', amount: 500, date: '2026-08-01' });
    const bankLegId = bankLegs()[0].id;
    deleteRemoveBoth(bankLegId);
    expect(owing()).toBe(800);           // rolled back once, not to a negative
    expect(stmtRow().status).toBe('unpaid');
    expect(stmtRow().amount_paid).toBe(0);
    expect(cardLegs().length).toBe(0);
    expect(bankLegs().length).toBe(0);
    refreshRecompute();
    expect(owing()).toBe(800);
  });

  it('delete from the CARD leg: resolves back to the bank tx, same single reversal', () => {
    transactionsDS.createTransfer({ fromId: 'bank1', fromType: 'bank', toId: 'card1', toType: 'credit_card', amount: 500, date: '2026-08-01' });
    const cardLegId = cardLegs()[0].id;
    deleteRemoveBoth(cardLegId);
    expect(owing()).toBe(800);
    expect(stmtRow().status).toBe('unpaid');
    expect(cardLegs().length).toBe(0);
    expect(bankLegs().length).toBe(0);
  });
});

describe('Confirm/reconcile flow (applyCardPayment) still correct', () => {
  it('partial payment settles the statement + creates the card leg, survives refresh', () => {
    const tx = transactionsDS.add(mkBankTx());
    applyCardPayment('card1', 500, tx.id);
    expect(stmtRow().amount_paid).toBe(500);
    expect(stmtRow().closing_balance).toBe(800);
    expect(owing()).toBe(300);
    expect(cardLegs().length).toBe(1);
    refreshRecompute();
    expect(owing()).toBe(300);
  });

  it('delete reverses owing exactly once from either leg', () => {
    const tx = transactionsDS.add(mkBankTx());
    applyCardPayment('card1', 500, tx.id);
    deleteRemoveBoth(cardLegs()[0].id);
    expect(owing()).toBe(800);
    expect(stmtRow().status).toBe('unpaid');
    expect(cardLegs().length).toBe(0);
  });
});
