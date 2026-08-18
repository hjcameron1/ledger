import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { propertiesDS, propertyReportDS, propertyFundsDS, loanReportDS } from '../services/dataService';
import { formatCurrency, formatDate } from '../utils/format';
import {
  PROPERTY_TYPE_LABELS, PROPERTY_TYPES, HELD_BY_LABELS, HELD_BY_OPTIONS,
  AU_STATES, DEFAULT_COUNTRY, isAustralia, formatAddress,
  type FundEntity,
} from '../utils/property';
import type { Property, PropertyType, PropertyHeldBy, Loan } from '../types';
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
  const { properties, loans, loanEvents, accounts, superFunds, setProperties } = useStore();

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
  const report = useMemo(() => propertyReportDS.build(), [properties, loans, funds]);
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

// ─── Property modal (add / edit / delete) ─────────────────────────────────────

function PropertyModal({ isOpen, property, loans, funds, currency, onClose, onSave, onDelete }: {
  isOpen: boolean;
  property: Property | null;
  loans: Loan[];
  funds: FundEntity[];
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
  };
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      });
    } else {
      setForm(emptyForm);
    }
    setErrors([]);
    setConfirmDelete(false);
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
