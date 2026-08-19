import { useState } from 'react';
import Card from '../common/Card';
import Input, { Select } from '../common/Input';
import Button from '../common/Button';
import { formatCurrency, formatDate } from '../../utils/format';
import { formatFY } from '../../utils/taxYear';
import {
  RENTAL_DEDUCTION_LABELS,
  RENTAL_DEDUCTION_ORDER,
  emptyFYSettings,
  emptyRentalSettings,
  fySettingsFor,
  type RentalDeductionLine,
  type RentalOtherDeduction,
  type RentalPosition,
  type RentalPropertyResult,
  type RentalPropertySettings,
  type RentalWarning,
} from '../../utils/rentalProperty';

/**
 * Phase 5.5 — the rental schedule.
 *
 * One card per property, laid out the way the return is: rent received, then
 * every deduction under its own ATO heading, then the net rental income or loss
 * that has already gone into the income and deduction cards above.
 *
 * The card computes NOTHING. Every figure is read off the RentalPosition the FY
 * position was built from, so this and the estimate can never disagree.
 *
 * The mortgage line is the one that says the most: it shows the interest that IS
 * deductible next to the principal that is not, because "we only counted the
 * interest" is a claim the user has no way to check unless the other half is
 * shown beside it.
 */

const EXCLUSION_TEXT: Record<string, string> = {
  'owner-occupied': 'You live here, so it has no rental income and no rental deductions.',
  'not-available-for-rent': 'No rent this year, and not marked as available for rent — nothing claimed.',
  'held-in-fund': 'Held in your SMSF, which lodges its own return.',
  'no-activity': 'No rent or costs recorded against it this year.',
};

export default function RentalProperties({
  fy, position, currency, settingsFor, onSaveSettings,
}: {
  fy: string;
  position: RentalPosition | null;
  currency: string;
  settingsFor: (propertyId: string) => RentalPropertySettings;
  onSaveSettings: (propertyId: string, settings: RentalPropertySettings) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const money = (n: number) => formatCurrency(n, currency);

  if (!position || position.properties.length === 0) return null;

  const counted = position.properties.filter(p => p.inSchedule);
  const skipped = position.properties.filter(p => !p.inSchedule);

  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">Rental properties</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {counted.length === 0
              ? `No property earned or claimed anything in FY ${formatFY(fy)}.`
              : `${counted.length} propert${counted.length === 1 ? 'y' : 'ies'} · rent counted as it was `
                + 'received, not as it was agreed'}
          </p>
        </div>
      </div>

      {counted.length > 0 && (
        <>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-4">
            <Figure label="Rent received" value={money(position.grossIncome)} />
            <Figure label="Deductions" value={money(position.totalDeductions)} />
            <Figure
              label={position.netRent < 0 ? 'Net rental loss' : 'Net rental income'}
              value={money(Math.abs(position.netRent))}
              tone={position.netRent < 0 ? 'bad' : 'good'}
            />
          </div>

          <div className="mt-5 space-y-5">
            {counted.map(p => (
              <PropertyBlock
                key={p.id}
                result={p}
                currency={currency}
                editing={editing === p.id}
                onToggleEdit={() => setEditing(editing === p.id ? null : p.id)}
                settings={settingsFor(p.id)}
                onSave={s => { onSaveSettings(p.id, s); setEditing(null); }}
                fy={fy}
              />
            ))}
          </div>
        </>
      )}

      {skipped.length > 0 && (
        <div className="mt-5 pt-4 border-t border-zinc-100 dark:border-zinc-800 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Not in the schedule
          </p>
          {skipped.map(p => (
            <div key={p.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm truncate">{p.label}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {EXCLUSION_TEXT[p.excludedReason ?? ''] ?? 'Nothing to report.'}
                </p>
              </div>
              {p.excludedReason === 'not-available-for-rent' && (
                <button
                  onClick={() => setEditing(editing === p.id ? null : p.id)}
                  className="text-xs text-brand hover:underline shrink-0"
                >
                  {editing === p.id ? 'Done' : 'Set up'}
                </button>
              )}
            </div>
          ))}
          {skipped.filter(p => editing === p.id).map(p => (
            <SettingsEditor
              key={`e:${p.id}`}
              fy={fy}
              currency={currency}
              result={p}
              settings={settingsFor(p.id)}
              onSave={s => { onSaveSettings(p.id, s); setEditing(null); }}
            />
          ))}
        </div>
      )}

      <Warnings warnings={position.warnings.filter(w => w.propertyId == null)} currency={currency} />
    </Card>
  );
}

// ─── One property ────────────────────────────────────────────────────────────

function PropertyBlock({ result, currency, editing, onToggleEdit, settings, onSave, fy }: {
  result: RentalPropertyResult;
  currency: string;
  editing: boolean;
  onToggleEdit: () => void;
  settings: RentalPropertySettings;
  onSave: (s: RentalPropertySettings) => void;
  fy: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const money = (n: number) => formatCurrency(n, currency);
  const [rentOpen, setRentOpen] = useState(false);

  return (
    <div className="border border-zinc-100 dark:border-zinc-800 rounded-[12px] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{result.label}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {result.ownershipPercent < 100 && <>{result.ownershipPercent}% owned · </>}
            {result.monthsWithRent} of {result.monthsOwned} month{result.monthsOwned === 1 ? '' : 's'} tenanted
            {result.deductibleShare < 1 && <> · {Math.round(result.deductibleShare * 100)}% deductible</>}
          </p>
        </div>
        <button onClick={onToggleEdit} className="text-xs text-brand hover:underline shrink-0">
          {editing ? 'Done' : 'Settings'}
        </button>
      </div>

      <div className="mt-3 space-y-1">
        <button
          onClick={() => setRentOpen(o => !o)}
          className="w-full flex items-start justify-between gap-3 text-left"
          aria-expanded={rentOpen}
          disabled={result.rentPayments.length === 0}
        >
          <div className="min-w-0">
            <p className="text-sm">
              {result.rentPayments.length > 0 && (
                <span className="inline-block w-3 text-zinc-400">{rentOpen ? '▾' : '▸'}</span>
              )}{' '}
              Rent received
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-4">
              {result.rentPayments.length === 0
                ? 'No rent arrived this year'
                : `${result.rentPayments.length} payment${result.rentPayments.length === 1 ? '' : 's'}`}
              {result.shareFactor < 1 && <> · your {Math.round(result.shareFactor * 100)}% share</>}
              {result.otherIncome > 0 && <> · plus {money(result.otherIncome)} you entered</>}
            </p>
          </div>
          <span className="text-sm amount shrink-0">{money(result.income)}</span>
        </button>

        {rentOpen && (
          <div className="pl-4 space-y-1 pb-1">
            {result.rentPayments.map(p => (
              <div key={p.id} className="flex items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <p className="truncate">{formatDate(p.date)} · {p.merchant}</p>
                  <p className="text-zinc-500 dark:text-zinc-400">matched by {p.via}</p>
                </div>
                <span className="amount shrink-0">{money(p.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {result.deductions.map(line => (
          <DeductionRow
            key={line.key}
            line={line}
            open={open === line.key}
            onToggle={() => setOpen(open === line.key ? null : line.key)}
            currency={currency}
          />
        ))}

        {/* The half of the mortgage that is NOT a deduction, said out loud.
            Only once there IS an interest figure: with none entered the whole
            repayment would read as principal, which is not what we know — we
            know nothing, and the warning below says so instead. */}
        {result.interest.repayments > 0 && result.interest.gross > 0 && (
          <div className="flex items-start justify-between gap-3 pt-1">
            <div className="min-w-0">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Loan principal — not deductible</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                About {money(result.interest.repayments)} of scheduled repayments a year, of which
                {' '}{money(result.interest.gross)} was interest. The rest pays down what you borrowed,
                which moves into equity rather than being spent — so it is not a cost and not a deduction.
              </p>
            </div>
            <span className="text-sm amount shrink-0 text-zinc-400 line-through">
              {money(result.interest.principalNotDeductible)}
            </span>
          </div>
        )}

        <div className="flex items-start justify-between gap-3 pt-2 mt-1 border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-sm font-medium">
            {result.netRent < 0 ? 'Net rental loss' : 'Net rental income'}
          </p>
          <span className={`text-sm font-semibold amount shrink-0 ${result.netRent < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
            {money(Math.abs(result.netRent))}
          </span>
        </div>
      </div>

      <Warnings warnings={result.warnings} currency={currency} />

      {editing && (
        <SettingsEditor fy={fy} currency={currency} result={result} settings={settings} onSave={onSave} />
      )}
    </div>
  );
}

function DeductionRow({ line, open, onToggle, currency }: {
  line: RentalDeductionLine; open: boolean; onToggle: () => void; currency: string;
}) {
  const money = (n: number) => formatCurrency(n, currency);
  const expandable = line.payments.length > 0;
  return (
    <div>
      <button
        onClick={expandable ? onToggle : undefined}
        className="w-full flex items-start justify-between gap-3 text-left"
        aria-expanded={open}
        disabled={!expandable}
      >
        <div className="min-w-0">
          <p className="text-sm">
            {expandable && <span className="inline-block w-3 text-zinc-400">{open ? '▾' : '▸'}</span>}
            {!expandable && <span className="inline-block w-3" />}{' '}
            {line.label}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-4">
            {line.detail ?? <>{line.count} payment{line.count === 1 ? '' : 's'}</>}
            {line.refunded > 0 && <> · {money(line.refunded)} came back</>}
            {line.apportioned && <> · {money(line.net)} paid, apportioned</>}
          </p>
        </div>
        <span className="text-sm amount shrink-0">−{money(line.claimed)}</span>
      </button>
      {open && (
        <div className="pl-4 space-y-1 py-1">
          {line.payments.map(p => (
            <div key={p.id} className="flex items-start justify-between gap-3 text-xs">
              <div className="min-w-0">
                <p className="truncate">
                  {formatDate(p.date)} · {p.merchant}
                  {p.flow === 'refund' && <span className="text-[#22c55e]"> · came back</span>}
                </p>
                <p className="text-zinc-500 dark:text-zinc-400">matched by {p.via}</p>
              </div>
              <span className="amount shrink-0">
                {p.flow === 'refund' ? '+' : '−'}{money(p.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const colour = tone === 'good' ? 'text-[#22c55e]' : tone === 'bad' ? 'text-[#ef4444]' : '';
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`font-semibold amount mt-1 text-lg ${colour}`}>{value}</p>
    </div>
  );
}

function Warnings({ warnings, currency }: { warnings: RentalWarning[]; currency: string }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {warnings.map((w, i) => (
        <div
          key={i}
          className={`rounded-[10px] px-3 py-2 border ${
            w.severity === 'warn'
              ? 'border-[#f59e0b]/30 bg-[#f59e0b]/10'
              : 'border-zinc-200 dark:border-zinc-800'
          }`}
        >
          <p className={`text-xs ${w.severity === 'warn' ? 'text-[#b45309] dark:text-[#fbbf24]' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {w.message}
            {w.amount != null && <span className="font-medium"> {formatCurrency(w.amount, currency)}</span>}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * The facts a bank feed cannot contain. Every one of them either costs the user
 * money when it is left blank or is a question they alone can answer, so the
 * editor states the consequence next to the field rather than under a help icon.
 */
function SettingsEditor({ fy, currency, result, settings, onSave }: {
  fy: string;
  currency: string;
  result: RentalPropertyResult;
  settings: RentalPropertySettings;
  onSave: (s: RentalPropertySettings) => void;
}) {
  const base = settings ?? emptyRentalSettings();
  const [draft, setDraft] = useState<RentalPropertySettings>(() => ({
    ...base,
    byFY: { ...base.byFY, [fy]: fySettingsFor(base, fy) },
  }));
  const year = draft.byFY[fy] ?? emptyFYSettings();
  const setYear = (patch: Partial<typeof year>) =>
    setDraft(d => ({ ...d, byFY: { ...d.byFY, [fy]: { ...year, ...patch } } }));

  const addExtra = () => setYear({
    otherDeductions: [
      ...year.otherDeductions,
      { id: `x${Date.now()}${year.otherDeductions.length}`, label: '', kind: 'capital-works', amount: 0 },
    ],
  });
  const setExtra = (id: string, patch: Partial<RentalOtherDeduction>) => setYear({
    otherDeductions: year.otherDeductions.map(x => (x.id === id ? { ...x, ...patch } : x)),
  });
  const removeExtra = (id: string) => setYear({
    otherDeductions: year.otherDeductions.filter(x => x.id !== id),
  });

  return (
    <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800 space-y-4">
      <div>
        <Select
          label={`Available for rent — FY ${formatFY(fy)}`}
          value={year.availableForRent == null ? 'auto' : year.availableForRent ? 'yes' : 'no'}
          onChange={e => setYear({
            availableForRent: e.target.value === 'auto' ? null : e.target.value === 'yes',
          })}
          options={[
            { value: 'auto', label: 'Available for rent: decide from the property type' },
            { value: 'yes', label: 'Available for rent: yes, all year' },
            { value: 'no', label: 'Available for rent: no — claim nothing this year' },
          ]}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          A property only has deductions for the time it was rented or genuinely available to rent.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          label="Interest from your lender's annual statement"
          type="number"
          step="0.01"
          prefix="$"
          value={year.interestPaid ?? ''}
          placeholder={result.interest.estimate != null ? `about ${result.interest.estimate}` : '0.00'}
          onChange={e => setYear({
            interestPaid: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0),
          })}
          hint={
            result.interest.estimate != null
              ? `At this loan's balance and rate, a full year is about ${formatCurrency(result.interest.estimate, currency)} — an estimate, never counted until you enter the real figure.`
              : 'Only interest is deductible. A repayment is not.'
          }
        />
        <Input
          label="Share of that loan NOT used for this property"
          type="number"
          step="1"
          suffix="%"
          value={year.interestPrivatePercent || ''}
          onChange={e => setYear({ interestPrivatePercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
          hint="Redrew against the mortgage for something private? That share of the interest is not deductible."
        />
      </div>

      <div>
        <Select
          label="Whose figures are these?"
          value={draft.recordedBasis}
          onChange={e => setDraft(d => ({ ...d, recordedBasis: e.target.value as 'my-share' | 'whole' }))}
          options={[
            { value: 'my-share', label: 'My accounts already hold only my share' },
            { value: 'whole', label: `The whole property's money goes through them — take my ${result.ownershipPercent}%` },
          ]}
        />
      </div>

      <div>
        <Select
          label="Private use"
          value={draft.apportionment.mode}
          onChange={e => setDraft(d => ({
            ...d,
            apportionment: { ...d.apportionment, mode: e.target.value as 'full' | 'percent' | 'days' },
          }))}
          options={[
            { value: 'full', label: 'Rented or available all year — claim everything' },
            { value: 'percent', label: 'A fixed share of the costs is deductible' },
            { value: 'days', label: 'Work it out from nights let, over the nights you owned it' },
          ]}
        />
        {draft.apportionment.mode === 'percent' && (
          <div className="mt-2">
            <Input
              type="number" step="1" suffix="%"
              value={draft.apportionment.percent || ''}
              onChange={e => setDraft(d => ({
                ...d,
                apportionment: { ...d.apportionment, percent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) },
              }))}
              hint="Applies to costs only. Every dollar of rent you received is assessable, and the agent's fee and advertising are never apportioned."
            />
          </div>
        )}
        {draft.apportionment.mode === 'days' && (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Input
              label="Nights let or available for rent" type="number" step="1"
              hint="Out of the nights you owned it that year — Ledger works that out itself."
              value={draft.apportionment.daysRented || ''}
              onChange={e => setDraft(d => ({
                ...d,
                apportionment: { ...d.apportionment, daysRented: Math.max(0, Number(e.target.value) || 0) },
              }))}
            />
            <Input
              label="Nights used privately" type="number" step="1"
              value={draft.apportionment.daysPrivate || ''}
              onChange={e => setDraft(d => ({
                ...d,
                apportionment: { ...d.apportionment, daysPrivate: Math.max(0, Number(e.target.value) || 0) },
              }))}
            />
          </div>
        )}
      </div>

      <div>
        <Select
          label={`Rent charged — FY ${formatFY(fy)}`}
          value={year.rentBelowMarket ? 'below' : 'market'}
          onChange={e => setYear({ rentBelowMarket: e.target.value === 'below' })}
          options={[
            { value: 'market', label: 'At the market rate' },
            { value: 'below', label: 'Below the market rate — let to family or friends' },
          ]}
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Below-market rent caps the deductions at the rent received, so the year can make neither a
          rental profit nor a rental loss.
        </p>
      </div>

      <Input
        label={`Other rental income — FY ${formatFY(fy)}`}
        type="number" step="0.01" prefix="$"
        value={year.otherIncome || ''}
        onChange={e => setYear({ otherIncome: Math.max(0, Number(e.target.value) || 0) })}
        hint="A rent-default insurance payout, or a bond you kept for unpaid rent. Not money already in your accounts."
      />

      <div>
        <div className="flex items-center justify-between">
          <p className="label mb-0">Claims Ledger can't see</p>
          <button onClick={addExtra} className="text-xs text-brand hover:underline">Add</button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 mb-2">
          Capital works and depreciation are never cash, so no bank feed contains them. They come off
          your quantity surveyor's schedule.
        </p>
        {year.otherDeductions.map(x => (
          <div key={x.id} className="grid grid-cols-12 gap-2 mb-2 items-end">
            <div className="col-span-5">
              <Input
                placeholder="Capital works" value={x.label}
                onChange={e => setExtra(x.id, { label: e.target.value })}
              />
            </div>
            <div className="col-span-4">
              <Select
                value={x.kind}
                onChange={e => setExtra(x.id, { kind: e.target.value as RentalOtherDeduction['kind'] })}
                options={RENTAL_DEDUCTION_ORDER.map(k => ({ value: k, label: RENTAL_DEDUCTION_LABELS[k] }))}
              />
            </div>
            <div className="col-span-2">
              <Input
                type="number" step="0.01" prefix="$" value={x.amount || ''}
                onChange={e => setExtra(x.id, { amount: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
            <div className="col-span-1">
              <button onClick={() => removeExtra(x.id)} className="text-xs text-[#ef4444] hover:underline pb-2">
                ×
              </button>
            </div>
          </div>
        ))}
      </div>

      <Button size="sm" onClick={() => onSave(draft)}>Save</Button>
    </div>
  );
}
