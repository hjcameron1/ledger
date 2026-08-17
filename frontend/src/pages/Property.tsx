import { useState, useEffect, useMemo } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { propertiesDS, propertyReportDS } from '../services/dataService';
import { formatCurrency, formatDate } from '../utils/format';
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES } from '../utils/property';
import type { Property, PropertyType, Loan } from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select } from '../components/common/Input';

/**
 * Phase 4.1 — properties.
 *
 * The page renders a report and nothing more: every number here (owned value,
 * equity, LVR, gain, totals) comes from utils/property.ts via propertyReportDS,
 * so what is shown is exactly what net worth used. The mortgage is never edited
 * here — it is a loan, and the Loans page owns it.
 */

const PROPERTY_TYPE_OPTIONS = PROPERTY_TYPES.map(t => ({ value: t, label: PROPERTY_TYPE_LABELS[t] }));

const TYPE_BADGE: Partial<Record<PropertyType, string>> = {
  home: 'bg-brand/15 text-brand',
  investment: 'bg-[#22c55e]/15 text-[#22c55e]',
  holiday: 'bg-[#06b6d4]/15 text-[#06b6d4]',
  land: 'bg-[#f59e0b]/15 text-[#f59e0b]',
  commercial: 'bg-[#a855f7]/15 text-[#a855f7]',
};
const typeBadgeClass = (t: PropertyType): string => TYPE_BADGE[t] ?? 'bg-zinc-500/15 text-zinc-500';

export default function PropertyPage() {
  const { user, properties, loans, setProperties } = useStore();
  const currency = user?.currency_preference ?? 'AUD';

  const [addOpen, setAddOpen] = useState(false);
  const [editProperty, setEditProperty] = useState<Property | null>(null);

  // Rebuilt whenever a property or a loan moves — a mortgage repayment recorded
  // on the Loans page must change the equity shown here without a reload.
  const report = useMemo(() => propertyReportDS.build(), [properties, loans]);
  const { rows, totals } = report;

  const refresh = () => setProperties(useStore.getState().properties);

  return (
    <Layout>
      <PageHeader title="Property" />

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

      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold">Properties ({rows.length})</h2>
          <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Property</Button>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">🏡</div>
            <h3 className="font-medium mb-1">No properties</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
              Track a home, investment or land — link its mortgage from Loans and your equity keeps itself up to date.
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
                </Card>
              );
            })}
          </div>
        )}

        {rows.length > 0 && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-4">
            Net worth counts the share you own of each property. A linked mortgage is subtracted once, as a loan —
            it is never counted twice.
          </p>
        )}
      </div>

      <PropertyModal
        isOpen={addOpen || !!editProperty}
        property={editProperty}
        loans={propertiesDS.availableLoans(editProperty?.id ?? null)}
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
    </Layout>
  );
}

// ─── Property modal (add / edit / delete) ─────────────────────────────────────

function PropertyModal({ isOpen, property, loans, currency, onClose, onSave, onDelete }: {
  isOpen: boolean;
  property: Property | null;
  loans: Loan[];
  currency: string;
  onClose: () => void;
  onSave: (data: Omit<Property, 'id' | 'user_id' | 'created_at' | 'updated_at'>) => void;
  onDelete?: () => void;
}) {
  const emptyForm = {
    name: '', address: '', property_type: 'home' as PropertyType,
    purchase_price: '', purchase_date: '', current_value: '',
    ownership_percent: '100', loan_id: '', notes: '',
    include_in_net_worth: true,
  };
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (property) {
      setForm({
        name: property.name,
        address: property.address ?? '',
        property_type: property.property_type,
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const draft = {
      name: form.name.trim(),
      current_value: value,
      purchase_price: parseFloat(form.purchase_price) || 0,
      ownership_percent: Number.isFinite(pct) ? pct : 100,
      loan_id: form.loan_id || null,
    };
    // Same checks the server runs, so a bad link is refused here rather than
    // rejected later by a sync the user never sees.
    const found = propertiesDS.validate(draft, property?.id ?? null);
    if (found.length > 0) { setErrors(found); return; }

    onSave({
      name: draft.name,
      address: form.address.trim() || null,
      property_type: form.property_type,
      purchase_price: draft.purchase_price,
      purchase_date: form.purchase_date || null,
      current_value: draft.current_value,
      ownership_percent: draft.ownership_percent,
      loan_id: draft.loan_id,
      include_in_net_worth: form.include_in_net_worth,
      notes: form.notes.trim() || null,
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={property ? 'Edit property' : 'Add property'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Property name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Bondi apartment" required />
        <Input label="Address (optional)" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} placeholder="e.g. 12 Beach Rd, Bondi NSW" />

        <div className="grid grid-cols-2 gap-3">
          <Select label="Property type" value={form.property_type} onChange={e => setForm(f => ({ ...f, property_type: e.target.value as PropertyType }))} options={PROPERTY_TYPE_OPTIONS} />
          <Input label="Ownership (%)" type="number" step="0.1" min="0" max="100" value={form.ownership_percent} onChange={e => setForm(f => ({ ...f, ownership_percent: e.target.value }))} placeholder="100" />
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
          </div>
        )}

        <Input label="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Anything worth remembering" />

        <div
          className="flex items-center justify-between gap-3 cursor-pointer select-none"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setForm(f => ({ ...f, include_in_net_worth: !f.include_in_net_worth })); }}
        >
          <div>
            <span className="text-sm text-zinc-900 dark:text-zinc-100">Count toward net worth</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">When on, the share you own is added to your net worth.</p>
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
              Delete this property? {property?.loan_id ? 'Its mortgage stays in Loans — you still owe it.' : "This can't be undone."}
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
