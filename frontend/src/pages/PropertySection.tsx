import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { propertiesDS, propertyReportDS, propertyFundsDS, loanReportDS } from '../services/dataService';
import { formatCurrency, formatDate } from '../utils/format';
import {
  PROPERTY_TYPE_LABELS, PROPERTY_TYPES, HELD_BY_LABELS, HELD_BY_OPTIONS,
  AU_STATES, DEFAULT_COUNTRY, isAustralia, formatAddress,
  suggestRentPayers, suggestExpenseBillers, previewRules, isOwnerOccupied,
  RENT_PERIODS_PER_YEAR, PROPERTY_EXPENSE_PERIODS_PER_YEAR, PROPERTY_EXPENSE_KINDS,
  EXPENSE_KIND_LABELS, EXPENSE_FREQUENCY_LABELS, blankExpenseRule, convertLegacyRules,
  type FundEntity, type PropertyRow, type RentFrequency, type RentPayerSuggestion,
  type ExpenseBillerSuggestion, type PropertyPaymentLine, type PropertyExpenseRuleLine,
} from '../utils/property';
import type {
  Property, PropertyType, PropertyHeldBy, Loan, BankAccount, Transaction,
  PropertyExpenseRule, PropertyExpenseKind, PropertyExpenseFrequency,
} from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';

/**
 * Phase 4.1 — properties, as a tab of the Investments area.
 *
 * The section renders a report and nothing more: every number here (owned value,
 * equity, LVR, gain, totals) comes from utils/property.ts via propertyReportDS,
 * so what is shown is exactly what net worth used. The mortgage is never edited
 * here — it is a loan, and the Loans page owns it. Nor is a fund balance: when an
 * SMSF already lists a property, this tab says so and stays out of the way.
 */

const PROPERTY_TYPE_OPTIONS = PROPERTY_TYPES.map(t => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }));
const HELD_BY_SELECT_OPTIONS = HELD_BY_OPTIONS.map(h => ({ value: h, label: HELD_BY_LABELS[h] }));

const TYPE_BADGE: Partial<Record<PropertyType, string>> = {
  home: 'bg-brand/15 text-brand',
  investment: 'bg-[#22c55e]/15 text-[#22c55e]',
  holiday: 'bg-[#06b6d4]/15 text-[#06b6d4]',
  land: 'bg-[#f59e0b]/15 text-[#f59e0b]',
  commercial: 'bg-[#a855f7]/15 text-[#a855f7]',
};
const typeBadgeClass = (t: PropertyType): string => TYPE_BADGE[t] ?? 'bg-zinc-500/15 text-zinc-500';

/** A fund's option value: kind and id together, since ids only differ per table. */
const fundKey = (f: Pick<FundEntity, 'kind' | 'id'>): string => `${f.kind}:${f.id}`;

export default function PropertySection({ currency }: { currency: string }) {
  const { properties, loans, loanEvents, accounts, transactions, superFunds, setProperties } = useStore();

  const [addOpen, setAddOpen] = useState(false);
  const [editProperty, setEditProperty] = useState<Property | null>(null);
  // SMSFs are backend-only, so the fund list is fetched. `funds` is only used to
  // NAME a link and offer choices — never to decide whether a value counts, which
  // is a property-local rule (see countedInFund).
  const [funds, setFunds] = useState<FundEntity[]>(() => propertyFundsDS.list());

  useEffect(() => {
    let cancelled = false;
    propertyFundsDS.load().then(list => { if (!cancelled) setFunds(list); }).catch(() => {});
    return () => { cancelled = true; };
    // Super funds come from the store, so re-derive when they change.
  }, [superFunds.length]);

  // Rebuilt whenever a property, a loan or a fund moves — a mortgage repayment
  // recorded on the Loans page must change the equity shown here without a reload.
  // `transactions` is in the list for the same reason: rent and expenses ARE
  // transactions, so an import, a re-category or a manual entry has to reach the
  // yield and cash flow immediately.
  const report = useMemo(() => propertyReportDS.build(), [properties, loans, funds, transactions]);
  const { rows, totals } = report;

  // A mortgage's payoff date, from the loan engine (Phase 4.2). It reads the
  // SAME loan row the property points at, so what this card says and what the
  // Loans page says are one calculation, not two.
  const loanReport = useMemo(() => loanReportDS.build(), [loans, loanEvents, accounts]);
  const mortgagePayoff = (loanId?: string): string | null => {
    if (!loanId) return null;
    const payoff = loanReport.rows.find(r => r.id === loanId)?.payoffDate;
    return payoff ? formatDate(payoff) : null;
  };

  const refresh = () => setProperties(useStore.getState().properties);

  return (
    <div>
      {rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Value owned', value: totals.ownedValue, tone: '' },
            { label: 'Mortgages', value: totals.debt, tone: totals.debt > 0 ? 'text-[#ef4444]' : '' },
            { label: 'Equity', value: totals.equity, tone: '' },
            { label: 'Properties', value: null, tone: '' },
          ].map(item => (
            <Card key={item.label} padding="sm">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{item.label}</p>
              <p className={`text-base font-semibold amount mt-1 ${item.tone}`}>
                {item.value === null ? totals.count : formatCurrency(item.value, currency, true)}
              </p>
            </Card>
          ))}
        </div>
      )}

      {/* A second strip, only once something is actually let: the portfolio's
          rent, what it costs to hold and what it returns. The yield is measured
          against the properties that EARN — a home the user lives in isn't in
          the numerator, so it has no business being in the denominator. */}
      {totals.rented > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Rent a year', value: formatCurrency(totals.annualRent, currency, true), tone: '' },
            { label: 'Costs a year', value: formatCurrency(totals.annualExpenses + totals.annualMortgage, currency, true), tone: '' },
            {
              label: 'Cash flow a month',
              value: `${totals.monthlyCashFlow >= 0 ? '+' : '−'}${formatCurrency(Math.abs(totals.monthlyCashFlow), currency, true)}`,
              tone: totals.monthlyCashFlow >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]',
            },
            {
              label: 'Yield (gross / net)',
              value: totals.grossYield === null
                ? '—'
                : `${totals.grossYield.toFixed(2)}% / ${totals.netYield !== null ? `${totals.netYield.toFixed(2)}%` : '—'}`,
              tone: '',
            },
          ].map(item => (
            <Card key={item.label} padding="sm">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{item.label}</p>
              <p className={`text-base font-semibold amount mt-1 ${item.tone}`}>{item.value}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="font-semibold">Property ({rows.length})</h2>
          {totals.countedInFunds > 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {formatCurrency(totals.countedInFunds, currency, true)} of this is counted inside your super, not again here
            </p>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Property</Button>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🏡</div>
          <h3 className="font-medium mb-1">No properties</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            Track a home, investment or SMSF property — link its mortgage from Loans and your equity keeps itself up to date.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>+ Add</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(row => {
            const property = properties.find(p => p.id === row.id)!;
            // Bar = how much of the property the user actually owns outright.
            const equityShare = row.ownedValue > 0
              ? Math.min(100, Math.max(0, (row.equity / row.ownedValue) * 100))
              : 0;
            return (
              <Card key={row.id}>
                <div className="flex items-start justify-between mb-3 gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium">{row.name}</h3>
                      <span className={`badge ${typeBadgeClass(row.type)}`}>{row.typeLabel}</span>
                      {row.heldBy !== 'personal' && (
                        <span className="badge bg-[#8b5cf6]/15 text-[#8b5cf6]">{row.heldByLabel}</span>
                      )}
                      {row.ownershipPercent < 100 && (
                        <span className="badge bg-zinc-500/15 text-zinc-500">{row.ownershipPercent}% owned</span>
                      )}
                    </div>
                    {row.address && <p className="text-sm text-zinc-500 dark:text-zinc-400 truncate">{row.address}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-lg font-semibold amount">{formatCurrency(row.equity, currency)}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">equity</p>
                  </div>
                </div>

                <div className="mb-2">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {row.ownershipPercent < 100
                        ? `Your ${row.ownershipPercent}% share: ${formatCurrency(row.ownedValue, currency, true)}`
                        : `Valued at ${formatCurrency(row.value, currency, true)}`}
                    </span>
                    {row.lvr !== null && <span className="text-zinc-500 dark:text-zinc-400">{row.lvr.toFixed(0)}% LVR</span>}
                  </div>
                  <div className="h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-[#22c55e]" style={{ width: `${equityShare}%` }} />
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 flex-wrap gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    {row.loan ? (
                      <span>
                        {row.loan.name}: {formatCurrency(row.loan.balance, currency, true)} owing
                        {!row.debtCountsTowardNetWorth && ' (not in net worth)'}
                      </span>
                    ) : (
                      <span>No mortgage linked</span>
                    )}
                    {/* The payoff comes from the loan's own projection — the same
                        loan, the same engine, so this can't drift from the Loans
                        page. */}
                    {mortgagePayoff(row.loan?.id) && <span>Paid off {mortgagePayoff(row.loan!.id)}</span>}
                    {row.gain !== null && (
                      <span className={row.gain >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}>
                        {row.gain >= 0 ? '+' : '−'}{formatCurrency(Math.abs(row.gain), currency, true)} since purchase
                        {row.gainPercent !== null && ` (${row.gainPercent >= 0 ? '+' : '−'}${Math.abs(row.gainPercent).toFixed(1)}%)`}
                      </span>
                    )}
                    {row.purchaseDate && <span>Bought {formatDate(row.purchaseDate)}</span>}
                    {!row.countsTowardNetWorth && <span>Excluded from net worth</span>}
                  </div>
                  <button onClick={() => setEditProperty(property)} className="text-brand hover:underline">Edit</button>
                </div>

                <PerformanceBlock row={row} currency={currency} />

                {row.fund && (
                  <p className="text-xs text-[#8b5cf6] mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                    {row.countedInFundBalance
                      ? `Held in ${row.fund.name} — its value is counted in that fund's balance, not added again here.`
                      : `Held in ${row.fund.name} — that balance excludes this property, so its value is counted here.`}
                  </p>
                )}

                {/* Flip a property in or out of net worth without opening the
                    modal — the same switch super funds and loans carry. The
                    amount shown is what the toggle is actually worth: for a
                    fund-held property that's nothing, because the fund is
                    already counting it. */}
                <div className="flex items-center justify-between gap-3 mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                  <div className="min-w-0">
                    <span className="text-xs text-zinc-900 dark:text-zinc-100">Count toward net worth</span>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {row.countedInFundBalance
                        ? `Counted inside ${row.fund?.name ?? 'the fund'}, so this adds nothing either way`
                        : row.countsTowardNetWorth
                          ? `Adding ${formatCurrency(row.netWorthValue, currency, true)}`
                          : `${formatCurrency(row.ownedValue, currency, true)} left out`}
                    </p>
                  </div>
                  <Toggle
                    size="sm"
                    checked={row.countsTowardNetWorth}
                    onChange={(v) => { propertiesDS.update(row.id, { include_in_net_worth: v }); refresh(); }}
                  />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-4">
          Net worth counts the share you own of each property. A linked mortgage is subtracted once, as a loan, and an
          SMSF property already listed in its fund is counted once, by the fund — never twice.
        </p>
      )}

      <PropertyModal
        isOpen={addOpen || !!editProperty}
        property={editProperty}
        loans={propertiesDS.availableLoans(editProperty?.id ?? null)}
        funds={funds}
        accounts={accounts}
        transactions={transactions}
        currency={currency}
        onClose={() => { setAddOpen(false); setEditProperty(null); }}
        onSave={(data) => {
          if (editProperty) propertiesDS.update(editProperty.id, data);
          else propertiesDS.add(data);
          refresh();
          setAddOpen(false);
          setEditProperty(null);
        }}
        onDelete={editProperty ? () => {
          propertiesDS.remove(editProperty.id);
          refresh();
          setEditProperty(null);
        } : undefined}
      />
    </div>
  );
}

// ─── Performance: rent, expenses, yield and cash flow (Phase 4.3) ────────────

/** "a week" / "a month" — how the current rent should be read out. */
const RENT_PERIOD_LABEL: Record<string, string> = {
  weekly: 'a week',
  fortnightly: 'a fortnight',
  monthly: 'a month',
  quarterly: 'a quarter',
};

/**
 * What the property earned, cost and returned over the trailing year.
 *
 * Every figure comes from the engine's `performance`, which derived it from the
 * user's own transactions — so this block can only ever show money that really
 * moved. Nothing is shown at all for a property with no rules and no money: an
 * unconfigured home shouldn't be told it yields 0%.
 *
 * An owner-occupied home never reads as an investment that failed to earn. It
 * has no rent line, no yield and no "no rent recorded" — only what it costs to
 * hold, which is the true answer for a house someone lives in.
 */
function PerformanceBlock({ row, currency }: { row: PropertyRow; currency: string }) {
  const p = row.performance;
  const holdingCost = p.annualExpenses + p.annualMortgage;
  if (!p.matched && p.rentPayments === 0 && p.expenseCount === 0 && holdingCost === 0) return null;

  const cashTone = p.annualCashFlow >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]';
  // Only worth saying when the rent now is materially different from the year
  // that's been: otherwise it's the same number twice. Never when the figure
  // shown is the agreed rent — then the line below already reports the gap
  // between what was agreed and what actually banked, and says it better.
  const rentMoved = p.annualRentBasis === 'banked' && p.currentAnnualRent !== null && p.annualRent > 0
    && Math.abs(p.currentAnnualRent - p.annualRent) / p.annualRent > 0.01;

  // Named costs first: once the user has said "this is the strata levy", the
  // card should say strata levy — not the type it was sorted under.
  const matchedRules = p.expensesByRule.filter(r => r.count > 0);
  const costLine = (matchedRules.length > 0 || p.expensesByKind.length > 0) && (
    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
      {(matchedRules.length > 0
        ? matchedRules.slice(0, 4).map(line => `${line.name} ${formatCurrency(line.amount, currency, true)}`)
        : p.expensesByKind.slice(0, 4).map(line => `${line.label} ${formatCurrency(line.amount, currency, true)}`)
      ).join(' · ')}
    </p>
  );

  // A cost the user set up that has never been seen. This is the most useful
  // line on the card when it appears: it means a bill isn't being recognised,
  // or hasn't come — and either way the figures above are missing it.
  const silent = p.expensesByRule.filter(r => r.count === 0);
  const overspent = matchedRules.filter(r => r.vsExpectedPercent !== null && r.vsExpectedPercent > 115);
  const expenseNotes = (silent.length > 0 || overspent.length > 0) && (
    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
      {silent.length > 0 && (
        <>Nothing has matched {silent.slice(0, 3).map(r => r.name).join(', ')} in the last year. </>
      )}
      {overspent.length > 0 && (
        <>
          {overspent.slice(0, 2).map(r => (
            `${r.name} is running ${(r.vsExpectedPercent! - 100).toFixed(0)}% above the ${formatCurrency(r.expectedAnnual, currency, true)} a year you expect`
          )).join('; ')}.
        </>
      )}
    </p>
  );

  // An owner-occupied home: costs only, and nothing that implies it should be
  // earning. Its mortgage is the biggest part of what it costs, so it is named.
  if (row.ownerOccupied) {
    return (
      <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-1.5">
        {holdingCost > 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Costs <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(holdingCost / 12, currency, true)}</span>/mo to hold
            {' '}({formatCurrency(holdingCost, currency, true)}/yr
            {p.annualMortgage > 0 ? `, ${formatCurrency(p.annualMortgage, currency, true)} of it mortgage` : ''}).
          </p>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">No costs matched for this property yet.</p>
        )}
        {costLine}
        {expenseNotes}
        {p.refunds > 0 && (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Includes {formatCurrency(p.refunds, currency, true)} that came back, taken off the cost rather than counted as income.
          </p>
        )}
        {!p.matched && (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Add the strata manager, council, insurer or utility under{' '}
            <span className="text-zinc-700 dark:text-zinc-300">Expenses</span> in Edit and the costs you already have will be counted here.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800 space-y-1.5">
      {p.isIncomeProducing ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span className="text-zinc-500 dark:text-zinc-400">
              Rent <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(p.annualRent, currency, true)}</span>/yr
              {' '}({formatCurrency(p.monthlyRent, currency, true)}/mo){p.annualRentBasis === 'agreed' ? ' agreed' : ''}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              Expenses <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(p.annualExpenses, currency, true)}</span>/yr
            </span>
            {p.grossYield !== null && (
              <span className="text-zinc-500 dark:text-zinc-400">
                Yield <span className="font-medium text-zinc-900 dark:text-zinc-100">{p.grossYield.toFixed(2)}%</span> gross
                {p.netYield !== null && <> · <span className="font-medium text-zinc-900 dark:text-zinc-100">{p.netYield.toFixed(2)}%</span> net</>}
              </span>
            )}
            <span className={`font-medium ${cashTone}`}>
              {p.monthlyCashFlow >= 0 ? '+' : '−'}{formatCurrency(Math.abs(p.monthlyCashFlow), currency, true)}/mo cash flow
              {' '}({p.annualCashFlow >= 0 ? '+' : '−'}{formatCurrency(Math.abs(p.annualCashFlow), currency, true)}/yr)
            </span>
          </div>

          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {p.annualRentBasis === 'agreed'
              ? `Rent is the ${formatCurrency(p.expectedAnnualRent!, currency, true)} a year you agreed, not a total of the payments. Costs ${p.window.partial
                ? `from ${p.window.months} month${p.window.months === 1 ? '' : 's'} since purchase, scaled to a year. `
                : 'over the last 12 months. '}`
              : p.window.partial
                ? `From ${p.window.months} month${p.window.months === 1 ? '' : 's'} since purchase, scaled to a year. `
                : 'Over the last 12 months. '}
            {p.vacantMonths > 0
              ? `Vacant ${p.vacantMonths} of ${p.window.months} month${p.window.months === 1 ? '' : 's'} — ${p.annualRentBasis === 'agreed'
                ? 'the yield is on the agreed rent, so it doesn’t show that'
                : 'the yield already reflects it'}. `
              : ''}
            {rentMoved && p.rentFrequency
              ? `Rent is now ${formatCurrency(p.latestRent!.amount, currency, true)} ${RENT_PERIOD_LABEL[p.rentFrequency]}, ${formatCurrency(p.currentAnnualRent!, currency, true)} a year at that rate. `
              : ''}
            {p.annualMortgage > 0
              ? `Cash flow is after ${formatCurrency(p.monthlyMortgage, currency, true)}/mo of mortgage repayments; the yields are before them.`
              : 'Nothing is deducted for a mortgage — none is linked.'}
          </p>

          {/* What was agreed against what actually banked. The gap is the part
              worth knowing — arrears, a vacancy, or the agent's fees coming out
              before the money is passed on. */}
          {p.expectedAnnualRent !== null && p.rentVsExpectedPercent !== null && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {p.rentVsExpectedPercent < 97
                ? `You expect ${formatCurrency(p.expectedAnnualRent, currency, true)} a year — what's arrived is ${(100 - p.rentVsExpectedPercent).toFixed(0)}% short of that.`
                : p.rentVsExpectedPercent > 103
                  ? `Ahead of the ${formatCurrency(p.expectedAnnualRent, currency, true)} a year you expect.`
                  : `In line with the ${formatCurrency(p.expectedAnnualRent, currency, true)} a year you expect.`}
            </p>
          )}

          {costLine}
          {expenseNotes}
        </>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {holdingCost > 0 ? (
            <>
              Costs <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(holdingCost / 12, currency, true)}</span>/mo to hold
              {' '}({formatCurrency(holdingCost, currency, true)}/yr
              {p.annualMortgage > 0 ? `, ${formatCurrency(p.annualMortgage, currency, true)} of it mortgage` : ''}).
              {' '}No rent matched, so there's no yield to report.
            </>
          ) : (
            <>No rent or expenses found for this property yet.</>
          )}
        </p>
      )}

      {!p.isIncomeProducing && costLine}
      {!p.isIncomeProducing && expenseNotes}

      {!p.matched && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Ledger doesn't know which transactions are this property's yet. Point at a rent payment under{' '}
          <span className="text-zinc-700 dark:text-zinc-300">Rent</span>, and name the strata manager, council or insurer
          under <span className="text-zinc-700 dark:text-zinc-300">Expenses</span>, in Edit — the money you already have
          will be counted here.
        </p>
      )}

      {p.rentMode === 'rules' && p.rentPayments === 0 && p.matched && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          No credit has matched the rent payer yet. If the agent's name on your statement has changed, add the new one
          under Rent in Edit.
        </p>
      )}
    </div>
  );
}

// ─── Property modal (add / edit / delete) ─────────────────────────────────────

/**
 * One typed line → the list of match terms.
 *
 * Split on commas and newlines, trimmed, and de-duplicated case-insensitively
 * (the engine matches case-insensitively, so "Ray White" and "ray white" are the
 * same rule twice). The user's own casing is kept for whichever they typed first,
 * because the box has to read back the way they wrote it.
 */
function splitTerms(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

const RENT_FREQUENCY_OPTIONS: { value: RentFrequency; label: string }[] = [
  { value: 'weekly', label: 'a week' },
  { value: 'fortnightly', label: 'a fortnight' },
  { value: 'monthly', label: 'a month' },
  { value: 'quarterly', label: 'a quarter' },
];

const EXPENSE_KIND_OPTIONS = PROPERTY_EXPENSE_KINDS.map(k => ({ value: k, label: EXPENSE_KIND_LABELS[k] }));

const EXPENSE_FREQUENCY_OPTIONS = (Object.keys(EXPENSE_FREQUENCY_LABELS) as PropertyExpenseFrequency[])
  .map(f => ({ value: f, label: EXPENSE_FREQUENCY_LABELS[f] }));

/**
 * One cost the property has: what it's called, what it should be, how often, who
 * it's paid to and from where.
 *
 * The biller is normally learned by pointing at a payment that already happened
 * — typing a rate notice's trading name off a piece of paper is how a rule ends
 * up matching nothing. Everything but the name and the type is optional, so a
 * user who only knows "the strata manager is Strata Plus" can say that and stop.
 */
function ExpenseRuleEditor({ rule, accounts, transactions, currency, line, onChange, onRemove }: {
  rule: PropertyExpenseRule;
  accounts: BankAccount[];
  transactions: Transaction[];
  currency: string;
  /** What this rule has actually caught, from the same engine the card uses. */
  line: PropertyExpenseRuleLine | undefined;
  onChange: (next: PropertyExpenseRule) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);

  const set = (patch: Partial<PropertyExpenseRule>) => onChange({ ...rule, ...patch });

  const billers = useMemo<ExpenseBillerSuggestion[]>(
    () => (picking ? suggestExpenseBillers(transactions, { query, limit: 6 }) : []),
    [picking, query, transactions],
  );

  const terms = (rule.match_terms ?? []).join(', ');
  const expected = Number(rule.expected_amount) || 0;
  const periods = rule.frequency ? PROPERTY_EXPENSE_PERIODS_PER_YEAR[rule.frequency] : 0;
  const expectedAnnual = expected > 0 && periods > 0 ? expected * periods : 0;

  /** Fill the rule from a real payment: biller, type, amount, cycle, account. */
  const learnFrom = (b: ExpenseBillerSuggestion) => {
    onChange({
      ...rule,
      name: rule.name.trim() || b.label,
      kind: b.kind,
      expected_amount: rule.expected_amount ?? b.typicalAmount,
      frequency: rule.frequency ?? b.frequency,
      account_id: rule.account_id ?? b.accountId,
      match_terms: splitTerms(`${terms}, ${b.term}`),
    });
    setPicking(false);
    setQuery('');
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Expense"
          value={rule.name}
          onChange={e => set({ name: e.target.value })}
          placeholder="Strata"
        />
        <Select
          label="Type"
          value={rule.kind}
          onChange={e => set({ kind: e.target.value as PropertyExpenseKind })}
          options={EXPENSE_KIND_OPTIONS}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Expected amount"
          type="number"
          step="0.01"
          prefix="$"
          value={rule.expected_amount == null ? '' : String(rule.expected_amount)}
          onChange={e => set({ expected_amount: e.target.value === '' ? null : parseFloat(e.target.value) || 0 })}
          placeholder="1100"
          hint="Optional"
        />
        <Select
          label="How often"
          value={rule.frequency ?? ''}
          onChange={e => set({ frequency: (e.target.value || null) as PropertyExpenseFrequency | null })}
          options={[{ value: '', label: 'Not set' }, ...EXPENSE_FREQUENCY_OPTIONS]}
        />
      </div>
      {expectedAnnual > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 -mt-1">
          {formatCurrency(expectedAnnual, currency, true)} a year at that rate.
        </p>
      )}

      {accounts.length > 0 && (
        <div>
          <Select
            label="Paid from (optional)"
            value={rule.account_id ?? ''}
            onChange={e => set({ account_id: e.target.value || null, whole_account: e.target.value ? rule.whole_account : false })}
            options={[{ value: '', label: 'Any account' }, ...accounts.map(a => ({ value: a.id, label: a.name }))]}
          />
          {rule.account_id && (
            <button
              type="button"
              onClick={() => set({ whole_account: !rule.whole_account })}
              className="mt-1 text-xs text-left text-zinc-500 dark:text-zinc-400 hover:text-brand"
            >
              {rule.whole_account ? '☑' : '☐'} That account is used only for this property
              <span className="block text-[11px]">
                {rule.whole_account
                  ? 'Everything on it counts as this property\'s, whatever the description says.'
                  : 'Leave off for a shared account — then a payment counts only if the biller or the amount matches.'}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Point at a payment instead of typing a biller's trading name. */}
      {picking ? (
        <div className="space-y-1">
          <Input
            label="Find the payment"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="strata, council, water…"
            autoFocus
          />
          {billers.map(b => (
            <button
              key={b.term}
              type="button"
              onClick={() => learnFrom(b)}
              className="w-full text-left rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-brand/50 px-3 py-2 text-xs"
            >
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{b.label}</span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {' '}— {b.payments} payment{b.payments === 1 ? '' : 's'}, usually{' '}
                {formatCurrency(b.typicalAmount, currency, true)}
                {b.frequency ? ` ${EXPENSE_FREQUENCY_LABELS[b.frequency]}` : ''}, last on {formatDate(b.latestDate)}
              </span>
            </button>
          ))}
          {billers.length === 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {query ? 'Nothing paid to anyone by that name in the last year.' : 'Type who you pay.'}
            </p>
          )}
          <button type="button" onClick={() => { setPicking(false); setQuery(''); }} className="text-xs text-zinc-500 hover:underline">
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <Input
            label="Who you pay"
            value={terms}
            onChange={e => set({ match_terms: splitTerms(e.target.value) })}
            placeholder="Strata Plus"
            hint="Comma separated. Matched against the merchant, description and notes."
          />
          <button type="button" onClick={() => setPicking(true)} className="text-xs text-brand hover:underline mt-1">
            Pick from a payment you've already made
          </button>
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {line && line.count > 0 ? (
            <>
              {line.count} payment{line.count === 1 ? '' : 's'} matched,{' '}
              {formatCurrency(line.amount, currency, true)} in the last year
              {line.latest && ` — last on ${formatDate(line.latest.date)}`}.
              {line.vsExpectedPercent !== null && line.vsExpectedPercent > 110
                && ` That's ${(line.vsExpectedPercent - 100).toFixed(0)}% above what you expect.`}
            </>
          ) : (
            'Nothing matched yet.'
          )}
        </p>
        <button type="button" onClick={onRemove} className="text-xs text-[#ef4444] hover:underline shrink-0">Remove</button>
      </div>
    </div>
  );
}

/**
 * The payments a property has claimed, so a wrong one can be taken off.
 *
 * This is the honest half of automatic matching: a rule is a guess about the
 * future, and the only way to know it was right is to see what it caught. A
 * removed payment is remembered by id (`excluded_transaction_ids`) — the
 * transaction itself is untouched and goes on counting everywhere else.
 */
function MatchedPayments({ payments, excluded, transactions, currency, kinds, emptyText, ownsCredits, onExclude, onRestore }: {
  payments: PropertyPaymentLine[];
  excluded: string[];
  transactions: Transaction[];
  currency: string;
  kinds: PropertyPaymentLine['kind'][];
  emptyText: string;
  /** Whether removed money COMING IN belongs in this list's put-back rows. The
   *  rent list owns them when there is one; on a home, where there is no rent
   *  section at all, the expenses list does — otherwise a removed refund could
   *  never be put back. */
  ownsCredits: boolean;
  onExclude: (id: string) => void;
  onRestore: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = payments.filter(p => kinds.includes(p.kind));
  const visible = showAll ? shown : shown.slice(0, 6);

  // Only the removals this list is responsible for: a rent payment taken off
  // shouldn't reappear as a removed line under Expenses.
  const removed = excluded
    .map(id => transactions.find(t => t.id === id))
    .filter((t): t is Transaction => !!t)
    .filter(t => ((t.display_amount ?? t.amount) > 0 ? ownsCredits : kinds.includes('expense')));

  return (
    <div className="space-y-1">
      <span className="label">Payments counted</span>
      {shown.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{emptyText}</p>
      ) : (
        <>
          {visible.map(p => (
            <div key={p.id} className="flex items-center justify-between gap-2 text-xs rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-1.5">
              <span className="min-w-0 truncate">
                <span className="text-zinc-900 dark:text-zinc-100">{formatDate(p.date)}</span>
                {' '}<span className="text-zinc-500 dark:text-zinc-400">{p.merchant}</span>
                {p.kind === 'refund' && <span className="text-zinc-500 dark:text-zinc-400"> (came back)</span>}
                {/* Why it was claimed. A wrong match is only fixable if the user
                    can see which rule caught it. */}
                <span className="text-zinc-400 dark:text-zinc-500"> · {p.via}</span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className="amount">{formatCurrency(p.amount, currency, true)}</span>
                <button type="button" onClick={() => onExclude(p.id)} className="text-zinc-400 hover:text-[#ef4444]" title="Not this property's">✕</button>
              </span>
            </div>
          ))}
          {shown.length > visible.length && (
            <button type="button" onClick={() => setShowAll(true)} className="text-xs text-brand hover:underline">
              Show all {shown.length}
            </button>
          )}
        </>
      )}
      {removed.length > 0 && (
        <div className="pt-1 space-y-1">
          {removed.map(t => (
            <div key={t.id} className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="min-w-0 truncate line-through">{formatDate(t.date)} {t.merchant}</span>
              <button type="button" onClick={() => onRestore(t.id)} className="text-brand hover:underline shrink-0">Put back</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PropertyModal({ isOpen, property, loans, funds, accounts, transactions, currency, onClose, onSave, onDelete }: {
  isOpen: boolean;
  property: Property | null;
  loans: Loan[];
  funds: FundEntity[];
  accounts: BankAccount[];
  /** The user's transactions — what the rules are matched against, and where the
   *  "which of these is the rent?" suggestions come from. Never written to. */
  transactions: Transaction[];
  currency: string;
  onClose: () => void;
  onSave: (data: Omit<Property, 'id' | 'user_id' | 'created_at' | 'updated_at'>) => void;
  onDelete?: () => void;
}) {
  const emptyForm = {
    name: '',
    unit: '', street: '', suburb: '', state: '', postcode: '', country: DEFAULT_COUNTRY,
    property_type: 'home' as PropertyType,
    held_by: 'personal' as PropertyHeldBy,
    fund: '',
    counted_in_fund_balance: true,
    purchase_price: '', purchase_date: '', current_value: '',
    ownership_percent: '100', loan_id: '', notes: '',
    include_in_net_worth: true,
    // One rule per cost — see ExpenseRuleEditor. The old single "match text" box
    // and dedicated-account chips are converted into these when a property saved
    // before them is opened (see convertLegacyRules) and then cleared.
    expenses: [] as PropertyExpenseRule[],
    /** Payments the user has taken off this property, by transaction id. */
    excluded: [] as string[],
    // Rent (investment property only — cleared on save for a home).
    rent_terms: '',
    rent_account_id: '',
    expected_rent_amount: '',
    expected_rent_frequency: 'monthly' as RentFrequency,
  };
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rentQuery, setRentQuery] = useState('');
  /** How many older match rules were converted when this property was opened. */
  const [converted, setConverted] = useState(0);

  const accountName = (id: string) => accounts.find(a => a.id === id)?.name ?? 'That account';

  useEffect(() => {
    if (property) {
      const link = property.smsf_fund_id
        ? `smsf:${property.smsf_fund_id}`
        : property.super_fund_id ? `super:${property.super_fund_id}` : '';
      // A property entered before the address was structured has only the old
      // free-text line. Seed the street box with it rather than showing an empty
      // form: the user splits what's already there instead of looking the address
      // up again. Deliberately not parsed into parts — a guessed suburb presented
      // as fact is worse than one the user moves across themselves.
      const legacyOnly = !property.address_street && !property.address_suburb;
      // The old free-text box and dedicated accounts become the rules they
      // always meant — one per biller, one per account — so a property set up
      // before this refinement opens ready to edit rather than looking empty.
      // Appended, never substituted: nothing the user already has is dropped.
      const fromLegacy = convertLegacyRules(property, accountName);
      setConverted(fromLegacy.length);
      setForm({
        name: property.name ?? '',
        unit: property.address_unit ?? '',
        street: property.address_street ?? (legacyOnly ? (property.address ?? '') : ''),
        suburb: property.address_suburb ?? '',
        state: property.address_state ?? '',
        postcode: property.address_postcode ?? '',
        country: property.address_country ?? DEFAULT_COUNTRY,
        property_type: property.property_type,
        held_by: property.held_by ?? 'personal',
        fund: link,
        counted_in_fund_balance: property.counted_in_fund_balance !== false,
        purchase_price: String(property.purchase_price ?? ''),
        purchase_date: property.purchase_date ?? '',
        current_value: String(property.current_value ?? ''),
        ownership_percent: String(property.ownership_percent ?? 100),
        loan_id: property.loan_id ?? '',
        notes: property.notes ?? '',
        include_in_net_worth: property.include_in_net_worth !== false,
        expenses: [...(property.property_expenses ?? []), ...fromLegacy],
        excluded: property.excluded_transaction_ids ?? [],
        rent_terms: (property.rent_match_terms ?? []).join(', '),
        rent_account_id: property.rent_account_id ?? '',
        expected_rent_amount: property.expected_rent_amount != null ? String(property.expected_rent_amount) : '',
        expected_rent_frequency: property.expected_rent_frequency ?? 'monthly',
      });
    } else {
      setForm(emptyForm);
      setConverted(0);
    }
    setErrors([]);
    setConfirmDelete(false);
    setRentQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property, isOpen]);

  const value = parseFloat(form.current_value) || 0;
  const pct = form.ownership_percent === '' ? 100 : parseFloat(form.ownership_percent);
  const share = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) / 100 : 1;
  const selectedLoan = loans.find(l => l.id === form.loan_id) ?? null;
  const previewEquity = value * share - (selectedLoan?.current_balance ?? 0);

  const isSmsf = form.held_by === 'smsf';
  const selectedFund = funds.find(f => fundKey(f) === form.fund) ?? null;
  // The fund link only exists for SMSF-held property; switching back to personal
  // must drop it rather than leave a dangling "held in" the user can't see.
  const smsfFundId = isSmsf && selectedFund?.kind === 'smsf' ? selectedFund.id : null;
  const superFundId = isSmsf && selectedFund?.kind === 'super' ? selectedFund.id : null;
  const countedInFund = isSmsf && !!selectedFund && form.counted_in_fund_balance;

  // Australian addresses get a state dropdown; anywhere else it's free text,
  // because "state" is a county/province/prefecture elsewhere.
  const auAddress = isAustralia(form.country);

  // A home earns nothing, so the whole rent half of this form is hidden — and
  // cleared on save, so a property that used to be let doesn't keep matching
  // rent that no longer arrives.
  const ownerOccupied = isOwnerOccupied({ property_type: form.property_type });
  const rentFields = ownerOccupied
    ? { rent_match_terms: [], rent_account_id: null, expected_rent_amount: null, expected_rent_frequency: null }
    : {
        rent_match_terms: splitTerms(form.rent_terms),
        rent_account_id: form.rent_account_id || null,
        expected_rent_amount: form.expected_rent_amount === '' ? null : parseFloat(form.expected_rent_amount) || 0,
        expected_rent_frequency: form.expected_rent_frequency,
      };

  // Who has been paying money in — the list the user picks the rent out of,
  // rather than typing an agent's trading name off a statement from memory.
  // Grouped by normalised payer, so a year of rent is ONE row to pick, not
  // twelve near-identical ones with different statement references.
  const rentPayers = useMemo(
    () => (ownerOccupied ? [] : suggestRentPayers(transactions, { limit: 6, query: rentQuery })),
    [transactions, ownerOccupied, rentQuery],
  );

  // What these rules catch RIGHT NOW, run through the same engine the card uses,
  // so the form can't promise something the card then contradicts.
  const preview = useMemo(() => previewRules({
    property_type: form.property_type,
    // The legacy fields are deliberately empty here: the form clears them on
    // save (their rules were converted on open), so previewing WITH them would
    // show matches that are about to disappear.
    match_terms: [],
    match_account_ids: [],
    property_expenses: form.expenses,
    excluded_transaction_ids: form.excluded,
    purchase_date: form.purchase_date || null,
    ...rentFields,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, transactions), [form, transactions]);

  const ruleLine = (id: string) => preview.expenses.byRule.find(r => r.id === id);
  const setRule = (next: PropertyExpenseRule) => setForm(f => ({
    ...f, expenses: f.expenses.map(r => (r.id === next.id ? next : r)),
  }));
  const excludePayment = (id: string) => setForm(f => (
    f.excluded.includes(id) ? f : { ...f, excluded: [...f.excluded, id] }
  ));
  const restorePayment = (id: string) => setForm(f => ({ ...f, excluded: f.excluded.filter(x => x !== id) }));

  const expectedRent = parseFloat(form.expected_rent_amount) || 0;
  const expectedAnnual = expectedRent > 0
    ? expectedRent * RENT_PERIODS_PER_YEAR[form.expected_rent_frequency]
    : 0;

  // Picking a payment IS the setup: the payer, the account it landed in, what it
  // came to and how often it comes are all read off the transaction the user
  // pointed at. The payer is the NORMALISED name, so the reference number this
  // month's payment happened to carry doesn't become part of the rule.
  const applyRentPayer = (s: RentPayerSuggestion) => setForm(f => ({
    ...f,
    rent_terms: splitTerms(`${f.rent_terms}, ${s.term}`).join(', '),
    // Only fill what's blank: a payer picked second must not overwrite an
    // expected rent the user has already typed.
    rent_account_id: f.rent_account_id || s.accountId || '',
    expected_rent_amount: f.expected_rent_amount || String(s.latestAmount),
    expected_rent_frequency: f.expected_rent_amount ? f.expected_rent_frequency : (s.frequency ?? f.expected_rent_frequency),
  }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const draft = {
      name: form.name.trim() || null,
      address_unit: form.unit.trim() || null,
      address_street: form.street.trim(),
      address_suburb: form.suburb.trim(),
      address_state: form.state.trim(),
      address_postcode: form.postcode.trim(),
      address_country: form.country.trim(),
      current_value: value,
      purchase_price: parseFloat(form.purchase_price) || 0,
      ownership_percent: Number.isFinite(pct) ? pct : 100,
      loan_id: form.loan_id || null,
      held_by: form.held_by,
      smsf_fund_id: smsfFundId,
      super_fund_id: superFundId,
      counted_in_fund_balance: form.counted_in_fund_balance,
      // Cleared, because their rules were converted into `property_expenses`
      // when this property was opened. Sent as empty arrays rather than omitted:
      // the engine still honours them, so leaving them stored would double every
      // cost they used to catch.
      match_terms: [],
      match_account_ids: [],
      property_expenses: form.expenses
        // A rule with no name and nothing to match is a row the user added and
        // never filled in. Dropping it here is kinder than refusing the save.
        .filter(r => r.name.trim() || (r.match_terms ?? []).length > 0 || r.account_id),
      excluded_transaction_ids: form.excluded,
      property_type: form.property_type,
      ...rentFields,
    };
    // Same checks the server runs, so a bad address or link is refused here
    // rather than rejected later by a sync the user never sees.
    const found = propertiesDS.validate(draft, property?.id ?? null);
    if (found.length > 0) { setErrors(found); return; }

    onSave({
      ...draft,
      property_type: form.property_type,
      purchase_date: form.purchase_date || null,
      include_in_net_worth: form.include_in_net_worth,
      notes: form.notes.trim() || null,
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={property ? 'Edit property' : 'Add property'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Nickname (optional)"
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Bondi apartment"
          hint="Leave blank and the address is used as the name."
        />

        {/* ── Address ── */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Address</p>
          <div className="grid grid-cols-3 gap-3">
            {/* The label stays SHORT on purpose: a `.label` is a block element
                that wraps, and a two-line label here pushed this input below the
                street box beside it. "(optional)" belongs in the hint, which sits
                under the input and so can't shift it. */}
            <Input
              label="Unit / lot"
              value={form.unit}
              onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}
              placeholder="12 or Lot 12"
              hint="Optional"
            />
            <div className="col-span-2">
              <Input
                label="Street number & name"
                value={form.street}
                onChange={e => setForm(f => ({ ...f, street: e.target.value }))}
                placeholder="34 Beach Rd"
                required
                hint="Unit → 12/34 Beach Rd · Lot → Lot 12, 34 Beach Rd · Neither → 34 Beach Rd"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Suburb / locality" value={form.suburb} onChange={e => setForm(f => ({ ...f, suburb: e.target.value }))} placeholder="Bondi" required />
            {auAddress ? (
              <Select
                label="State"
                value={form.state}
                onChange={e => setForm(f => ({ ...f, state: e.target.value }))}
                options={[{ value: '', label: 'Select…' }, ...AU_STATES.map(st => ({ value: st, label: st }))]}
              />
            ) : (
              <Input label="State / region" value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} required />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Postcode" value={form.postcode} onChange={e => setForm(f => ({ ...f, postcode: e.target.value }))} placeholder="2026" required />
            <Input label="Country" value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} placeholder={DEFAULT_COUNTRY} required />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select label="Property type" value={form.property_type} onChange={e => setForm(f => ({ ...f, property_type: e.target.value as PropertyType }))} options={PROPERTY_TYPE_OPTIONS} />
          <Input label="Ownership (%)" type="number" step="0.1" min="0" max="100" value={form.ownership_percent} onChange={e => setForm(f => ({ ...f, ownership_percent: e.target.value }))} placeholder="100" />
        </div>

        {/* ── Held by ── */}
        <div>
          <Select
            label="Held by"
            value={form.held_by}
            onChange={e => {
              const held = e.target.value as PropertyHeldBy;
              setForm(f => ({ ...f, held_by: held, fund: held === 'smsf' ? f.fund : '' }));
            }}
            options={HELD_BY_SELECT_OPTIONS}
          />
          {isSmsf && (
            <div className="mt-3 space-y-3 rounded-lg border border-[#8b5cf6]/30 bg-[#8b5cf6]/5 p-3">
              <Select
                label="Fund holding it"
                value={form.fund}
                onChange={e => setForm(f => ({ ...f, fund: e.target.value }))}
                options={[
                  { value: '', label: funds.length ? 'Select a fund…' : 'No funds found — add one under SMSF or Super' },
                  ...funds.map(f => ({
                    value: fundKey(f),
                    label: f.kind === 'smsf' ? `${f.name} (SMSF)` : `${f.name} (Super)`,
                  })),
                ]}
              />
              <div
                className="flex items-center justify-between gap-3 cursor-pointer select-none"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setForm(f => ({ ...f, counted_in_fund_balance: !f.counted_in_fund_balance })); }}
              >
                <div>
                  <span className="text-sm text-zinc-900 dark:text-zinc-100">This value is already in the fund's balance</span>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Leave this on if the property is listed among the fund's assets — then its value is counted once,
                    by the fund. Turn it off only if the fund's balance excludes the property, and it will be counted here.
                  </p>
                </div>
                <div className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${form.counted_in_fund_balance ? 'bg-[#8b5cf6]' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.counted_in_fund_balance ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Purchase price" type="number" step="0.01" prefix="$" value={form.purchase_price} onChange={e => setForm(f => ({ ...f, purchase_price: e.target.value }))} />
          <Input label="Purchase date" type="date" value={form.purchase_date} onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))} />
        </div>

        <Input label="Current value" type="number" step="0.01" prefix="$" value={form.current_value} onChange={e => setForm(f => ({ ...f, current_value: e.target.value }))} required />

        <div>
          <Select
            label="Linked mortgage (optional)"
            value={form.loan_id}
            onChange={e => setForm(f => ({ ...f, loan_id: e.target.value }))}
            options={[
              { value: '', label: 'No mortgage' },
              ...loans.map(l => ({ value: l.id, label: `${l.name} — ${formatCurrency(l.current_balance, currency, true)} owing` })),
            ]}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Links an existing loan from the Loans page. The balance stays there — it is subtracted from your net worth
            once, as debt, and shown here as equity. Loans already linked to another property aren't listed.
          </p>
        </div>

        {/* ── Rent (investment property only) ──
            Hidden outright for an owner-occupied home: it earns nothing, so a
            rent payer, an expected rent and a receiving account are three
            questions with no answer. Nothing is recorded here either — these
            only say which of the credits ALREADY in Ledger are the rent. */}
        {!ownerOccupied && (
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Rent</p>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Expected rent"
                type="number"
                step="0.01"
                prefix="$"
                value={form.expected_rent_amount}
                onChange={e => setForm(f => ({ ...f, expected_rent_amount: e.target.value }))}
                placeholder="800"
              />
              <Select
                label="How often"
                value={form.expected_rent_frequency}
                onChange={e => setForm(f => ({ ...f, expected_rent_frequency: e.target.value as RentFrequency }))}
                options={RENT_FREQUENCY_OPTIONS}
              />
            </div>
            {expectedAnnual > 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 -mt-1">
                {formatCurrency(expectedAnnual, currency, true)} a year if it's paid in full. Used to recognise the rent
                and to tell you when what arrives falls behind — never counted as income on its own.
              </p>
            )}

            {accounts.length > 0 && (
              <Select
                label="Rent is paid into"
                value={form.rent_account_id}
                onChange={e => setForm(f => ({ ...f, rent_account_id: e.target.value }))}
                options={[
                  { value: '', label: 'Any account' },
                  ...accounts.map(a => ({ value: a.id, label: a.name })),
                ]}
              />
            )}

            {/* Point at a payment instead of typing an agent's trading name.
                One row per payer, not per payment: picking it teaches the rule
                everything the transaction knows. */}
            <div>
              <span className="label">Which of these is the rent?</span>
              <Input
                value={rentQuery}
                onChange={e => setRentQuery(e.target.value)}
                placeholder="Search who's paid you…"
              />
              <div className="space-y-1 mt-1">
                {rentPayers.map(payer => {
                  const chosen = splitTerms(form.rent_terms).some(t => t.toLowerCase() === payer.term.toLowerCase());
                  return (
                    <button
                      key={payer.term}
                      type="button"
                      onClick={() => applyRentPayer(payer)}
                      className={`w-full text-left rounded-lg border px-3 py-2 text-xs ${chosen
                        ? 'border-brand bg-brand/5'
                        : 'border-zinc-200 dark:border-zinc-800 hover:border-brand/50'}`}
                    >
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{chosen ? '✓ ' : ''}{payer.label}</span>
                      <span className="text-zinc-500 dark:text-zinc-400">
                        {' '}— {payer.payments} payment{payer.payments === 1 ? '' : 's'}, last{' '}
                        {formatCurrency(payer.latestAmount, currency, true)} on {formatDate(payer.latestDate)}
                      </span>
                    </button>
                  );
                })}
                {rentPayers.length === 0 && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {rentQuery ? 'Nobody by that name has paid you in the last year.' : 'No money has come in yet to point at.'}
                  </p>
                )}
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Picking one reads the payer, the account it arrived in, what it came to and how often off the payment
                itself. Every future payment from them is then counted as rent automatically.
              </p>
            </div>

            <Input
              label="Rent payer"
              value={form.rent_terms}
              onChange={e => setForm(f => ({ ...f, rent_terms: e.target.value }))}
              placeholder="ray white"
              hint="Comma separated. Matched against the merchant, description and notes, so a rent rise or a late payment still counts."
            />

            <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900 p-3 text-xs text-zinc-500 dark:text-zinc-400">
              {preview.rent.count > 0 ? (
                <>
                  Matches <span className="font-medium text-zinc-900 dark:text-zinc-100">{preview.rent.count}</span> rent
                  payment{preview.rent.count === 1 ? '' : 's'} in the last year,{' '}
                  {formatCurrency(preview.rent.total, currency, true)} in all
                  {preview.rent.latest && ` — last ${formatCurrency(preview.rent.latest.amount, currency, true)} on ${formatDate(preview.rent.latest.date)}`}.
                </>
              ) : (
                <>
                  No rent matched yet. Pick the payer above, or set the expected rent and the account it lands in —
                  a credit in a shared account only counts as rent when it's close to what you expect.
                </>
              )}
            </div>

            {/* Automatic matching, shown its working. Anything wrong comes off
                here rather than by weakening a rule that's right about the rest. */}
            <MatchedPayments
              payments={preview.payments}
              excluded={form.excluded}
              transactions={transactions}
              currency={currency}
              kinds={['rent']}
              emptyText="Nothing has matched the rent payer yet."
              ownsCredits
              onExclude={excludePayment}
              onRestore={restorePayment}
            />
          </div>
        )}

        {/* ── Expenses (every property, home included) ── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Expenses</p>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, expenses: [...f.expenses, blankExpenseRule()] }))}
              className="text-xs text-brand hover:underline"
            >
              + Add a cost
            </button>
          </div>

          {converted > 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Your older match text became {converted} cost{converted === 1 ? '' : 's'} below — give each one a type,
              what it should be and how often, and Ledger can tell you when one comes in high or doesn't arrive at all.
            </p>
          )}

          {form.expenses.length === 0 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Add the costs this property has — strata or body corporate, council rates, water, insurance, maintenance,
              utilities, anything else. Each one is matched against the transactions you already have.
            </p>
          ) : (
            <div className="space-y-3">
              {form.expenses.map(rule => (
                <ExpenseRuleEditor
                  key={rule.id}
                  rule={rule}
                  accounts={accounts}
                  transactions={transactions}
                  currency={currency}
                  line={ruleLine(rule.id)}
                  onChange={setRule}
                  onRemove={() => setForm(f => ({ ...f, expenses: f.expenses.filter(r => r.id !== rule.id) }))}
                />
              ))}
            </div>
          )}

          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900 p-3 text-xs text-zinc-500 dark:text-zinc-400 space-y-1">
            {preview.expenses.count > 0 ? (
              <>
                <p>
                  Matches <span className="font-medium text-zinc-900 dark:text-zinc-100">{preview.expenses.count}</span>{' '}
                  expense{preview.expenses.count === 1 ? '' : 's'} in the last year,{' '}
                  {formatCurrency(preview.expenses.total, currency, true)} in all.
                </p>
                {preview.expenses.byKind.length > 0 && (
                  <p>{preview.expenses.byKind.slice(0, 4).map(line => (
                    `${line.label} ${formatCurrency(line.amount, currency, true)}`
                  )).join(' · ')}</p>
                )}
              </>
            ) : (
              <p>No expenses matched yet.</p>
            )}
            {/* A credit caught by the expense rules is money that came back, not
                income — and if there are a lot of them the rule is too broad,
                which is exactly what the user needs to see before saving. */}
            {preview.otherCredits.count > 0 && (
              <p>
                {preview.otherCredits.count} credit{preview.otherCredits.count === 1 ? '' : 's'} totalling{' '}
                {formatCurrency(preview.otherCredits.total, currency, true)} also match{preview.otherCredits.count === 1 ? 'es' : ''}.
                {' '}They're treated as money coming back and taken off the cost — never counted as rent.
              </p>
            )}
          </div>

          {form.expenses.length > 0 && (
            <MatchedPayments
              payments={preview.payments}
              excluded={form.excluded}
              transactions={transactions}
              currency={currency}
              kinds={['expense', 'refund']}
              emptyText="None of these costs have matched a payment yet."
              ownsCredits={ownerOccupied}
              onExclude={excludePayment}
              onRestore={restorePayment}
            />
          )}

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            No rent or expense is stored here — these are your existing transactions, in their existing categories, so
            correcting one corrects the yield. Transfers are ignored, and mortgage repayments are counted from the loan
            above rather than twice. A transaction only ever belongs to one property.
          </p>
        </div>

        {value > 0 && (
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900 p-3 text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5">
            <p>Your share of the value: <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(value * share, currency, true)}</span></p>
            {selectedLoan && <p>Less {selectedLoan.name}: −{formatCurrency(selectedLoan.current_balance, currency, true)}</p>}
            <p>Equity: <span className="font-medium text-zinc-900 dark:text-zinc-100">{formatCurrency(previewEquity, currency, true)}</span></p>
            <p className="pt-1">
              {countedInFund
                ? `Added to net worth: nothing — ${selectedFund!.name} already counts it.`
                : `Added to net worth: ${formatCurrency(form.include_in_net_worth ? value * share : 0, currency, true)}`}
            </p>
          </div>
        )}

        <Input label="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Anything worth remembering" />

        <div
          className="flex items-center justify-between gap-3 cursor-pointer select-none"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setForm(f => ({ ...f, include_in_net_worth: !f.include_in_net_worth })); }}
        >
          <div>
            <span className="text-sm text-zinc-900 dark:text-zinc-100">Count toward net worth</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {countedInFund
                ? "The fund's balance is already counting this property, so it adds nothing on its own."
                : 'When on, the share you own is added to your net worth.'}
            </p>
          </div>
          <div className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${form.include_in_net_worth ? 'bg-brand' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.include_in_net_worth ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </div>

        {errors.length > 0 && (
          <div className="rounded-lg bg-[#ef4444]/10 p-3 space-y-1">
            {errors.map(err => <p key={err} className="text-xs text-[#ef4444]">{err}</p>)}
          </div>
        )}

        {confirmDelete ? (
          <div className="flex items-center gap-3 pt-2 rounded-lg bg-[#ef4444]/5 p-3">
            <span className="flex-1 text-xs text-zinc-500 dark:text-zinc-400">
              Delete {property ? formatAddress(property, { short: true }) || 'this property' : 'this property'}?{' '}
              {property?.loan_id ? 'Its mortgage stays in Loans — you still owe it.' : "This can't be undone."}
            </span>
            <Button variant="secondary" type="button" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" type="button" onClick={onDelete}>Confirm delete</Button>
          </div>
        ) : (
          <div className="flex gap-3 pt-2">
            {onDelete && (
              <Button variant="secondary" type="button" onClick={() => setConfirmDelete(true)} className="text-[#ef4444]">Delete</Button>
            )}
            <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" fullWidth>{property ? 'Save changes' : 'Add property'}</Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
