import { useState } from 'react';
import Card from '../common/Card';
import Input, { Select, Toggle } from '../common/Input';
import { formatCurrency } from '../../utils/format';
import { formatFY } from '../../utils/taxYear';
import {
  TAX_PROFILE_GROUPS,
  type TaxProfile,
  type TaxProfileField,
} from '../../utils/taxProfile';
import {
  REPAYMENT_INCOME_FIELDS,
  type RepaymentIncomeAdjustments,
  type RepaymentIncomeField,
} from '../../utils/repaymentIncome';
import type { OffsetPosition } from '../../utils/taxOffsets';

/**
 * Phase 5.3 — the answers the offsets and the surcharge need, and what they
 * produced.
 *
 * Every question here is one Ledger CANNOT answer from money movements: a
 * spouse's income, whether a health policy was hospital cover or extras, age
 * and pension eligibility. They are asked once per financial year, next to the
 * figure each one moves, so a change to an answer visibly changes the result
 * rather than disappearing into a settings page.
 *
 * The card computes nothing. Every derived figure it shows — the income bases,
 * the tier, the entitlement — comes off the OffsetPosition the settlement above
 * was built from, so the two cannot disagree.
 */
export default function TaxCircumstances({
  fy, profile, onChange, adjustments, onChangeAdjustment, offsets, currency, onCopyPreviousYear, previousFY,
  derivedNotes,
}: {
  fy: string;
  profile: TaxProfile;
  onChange: (key: keyof TaxProfile, value: TaxProfile[keyof TaxProfile]) => void;
  adjustments: RepaymentIncomeAdjustments;
  onChangeAdjustment: (key: RepaymentIncomeField, value: number) => void;
  offsets: OffsetPosition | null;
  currency: string;
  /** Offered only when the previous year has answers and this one has none. */
  onCopyPreviousYear?: () => void;
  previousFY?: string;
  /** Phase 5.5 — figures Ledger derived that override what was typed. */
  derivedNotes?: Partial<Record<RepaymentIncomeField, string>>;
}) {
  const [open, setOpen] = useState(false);
  const money = (n: number) => formatCurrency(n, currency);

  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">Offsets, surcharge and private health</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {summaryLine(offsets, profile, money)}
          </p>
        </div>
        <button onClick={() => setOpen(v => !v)} className="shrink-0 text-xs text-brand hover:underline">
          {open ? 'Done' : 'Your details'}
        </button>
      </div>

      {/* What the answers produced. Shown collapsed too — it is the reason the
          questions are worth answering. */}
      {offsets?.ratesAvailable && <Derived offsets={offsets} currency={currency} />}

      {open && (
        <div className="mt-4 space-y-5">
          {onCopyPreviousYear && previousFY && (
            <div className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 flex items-center justify-between gap-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Nothing answered for FY {formatFY(fy)} yet. Most of this stays the same year to year.
              </p>
              <button onClick={onCopyPreviousYear} className="shrink-0 text-xs text-brand hover:underline">
                Copy FY {formatFY(previousFY)}
              </button>
            </div>
          )}

          {TAX_PROFILE_GROUPS.map(group => (
            <div key={group.key}>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {group.title}
              </h4>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 mb-3">{group.intro}</p>
              <div className="space-y-3">
                {group.fields
                  .filter(f => !f.visibleWhen || f.visibleWhen(profile))
                  .map(f => <ProfileField key={f.key} field={f} profile={profile} onChange={onChange} />)}
              </div>
            </div>
          ))}

          {/* The five income-test figures. They already existed for the study
              loan; the ATO reuses the same list for the seniors offset and the
              surcharge, so they are asked for here whether there is a loan or not. */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Income test figures
            </h4>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 mb-3">
              These five come off a payment summary or a tax return, never a bank feed. The same figures
              are used for a study loan repayment, the seniors offset and the surcharge — enter them once.
            </p>
            <IncomeTestFields
              adjustments={adjustments}
              onChange={onChangeAdjustment}
              derivedNotes={derivedNotes}
            />
          </div>

          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Saved against FY {formatFY(fy)} only. A spouse arrives, cover lapses, someone turns 65 —
            last year's answers are never assumed to be this year's.
          </p>
        </div>
      )}
    </Card>
  );
}

/**
 * The repayment-income adjustments editor. Exported because the study loan card
 * shows the same five fields for its own reason — one control, one store, so
 * the two can never drift.
 */
export function IncomeTestFields({ adjustments, onChange, derivedNotes }: {
  adjustments: RepaymentIncomeAdjustments;
  onChange: (key: RepaymentIncomeField, value: number) => void;
  /**
   * Phase 5.5 — what Ledger worked out for itself. A figure it can now derive
   * (the net rental loss) is shown under the field it replaces, so the user can
   * see WHY the income these tests run on is more than what they typed.
   */
  derivedNotes?: Partial<Record<RepaymentIncomeField, string>>;
}) {
  return (
    <div className="space-y-3">
      {REPAYMENT_INCOME_FIELDS.map(f => (
        <div key={f.key}>
          <Input
            label={f.label}
            type="number"
            step="0.01"
            min="0"
            prefix="$"
            value={adjustments[f.key] === 0 ? '' : String(adjustments[f.key])}
            onChange={e => onChange(f.key, parseFloat(e.target.value) || 0)}
            placeholder="0.00"
          />
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{f.help}</p>
          {derivedNotes?.[f.key] && (
            <p className="text-xs text-[#b45309] dark:text-[#fbbf24] mt-1">{derivedNotes[f.key]}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function ProfileField({ field, profile, onChange }: {
  field: TaxProfileField;
  profile: TaxProfile;
  onChange: (key: keyof TaxProfile, value: TaxProfile[keyof TaxProfile]) => void;
}) {
  const value = profile[field.key];

  if (field.kind === 'toggle') {
    return (
      <div>
        <Toggle
          label={field.label}
          checked={value === true}
          onChange={v => onChange(field.key, v)}
        />
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{field.help}</p>
      </div>
    );
  }

  if (field.kind === 'choice') {
    return (
      <div>
        <Select
          label={field.label}
          value={String(value)}
          onChange={e => onChange(field.key, e.target.value as TaxProfile[keyof TaxProfile])}
          options={[
            // An unanswered choice stays unanswered until the user picks — the
            // engine treats "not answered" differently from every real answer.
            ...(value === 'unknown' ? [{ value: 'unknown', label: 'Select…' }] : []),
            ...(field.options ?? []),
          ]}
        />
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{field.help}</p>
      </div>
    );
  }

  const isMoney = field.kind === 'money';
  return (
    <div>
      <Input
        label={field.label}
        type="number"
        step={isMoney ? '0.01' : '1'}
        min="0"
        {...(isMoney ? { prefix: '$' } : {})}
        value={value === 0 ? '' : String(value)}
        onChange={e => onChange(
          field.key,
          (isMoney ? parseFloat(e.target.value) : parseInt(e.target.value, 10)) || 0,
        )}
        placeholder={isMoney ? '0.00' : '0'}
      />
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{field.help}</p>
    </div>
  );
}

/** What the answers produced — the bases, the tier, and the rebate arithmetic. */
function Derived({ offsets, currency }: { offsets: OffsetPosition; currency: string }) {
  const money = (n: number) => formatCurrency(n, currency);
  const { surcharge, health, sapto } = offsets;
  const rows: { label: string; value: string; detail?: string }[] = [];

  if (surcharge) {
    rows.push({
      label: 'Income for surcharge purposes',
      value: money(offsets.familySurchargeIncome),
      detail:
        (surcharge.familyThresholds
          ? `Yours and your spouse's, against a family threshold of ${money(surcharge.threshold)}`
          : `Against a single threshold of ${money(surcharge.threshold)}`)
        + ` · ${surcharge.tierLabel}`,
    });
  }
  if (sapto && sapto.reason !== 'not-eligible') {
    rows.push({
      label: 'Rebate income',
      value: money(offsets.rebateIncome),
      detail:
        `Seniors offset shades out from ${money(sapto.row.shadeOut)} and stops at ${money(sapto.row.cutOut)}`,
    });
  }
  if (health) {
    for (const p of health.periods) {
      if (p.premiums === 0) continue;
      rows.push({
        label: p.label,
        value: money(p.entitled),
        detail:
          `${p.percentage.toFixed(3)}% of ${money(p.premiums)} in premiums`
          + (p.provisional ? ' · rate not published yet' : ''),
      });
    }
    rows.push({
      label: 'Private health rebate entitlement',
      value: money(health.entitled),
      detail: `Your insurer already allowed ${money(health.received)}`,
    });
  }

  if (rows.length === 0) return null;
  return (
    <div className="mt-3 rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium">{r.label}</p>
            {r.detail && <p className="text-xs text-zinc-500 dark:text-zinc-400">{r.detail}</p>}
          </div>
          <span className="text-xs font-medium amount shrink-0">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** One line describing where this year stands, before anything is expanded. */
function summaryLine(
  offsets: OffsetPosition | null,
  profile: TaxProfile,
  money: (n: number) => string,
): string {
  if (!offsets?.ratesAvailable) {
    return 'Ledger holds no offset or surcharge rules for this year.';
  }
  const parts: string[] = [];
  if (offsets.appliedTotal > 0) parts.push(`${money(offsets.appliedTotal)} of offsets`);
  if (offsets.surcharge?.amount) parts.push(`${money(offsets.surcharge.amount)} surcharge`);
  if (offsets.health && offsets.health.adjustment !== 0) {
    parts.push(
      offsets.health.adjustment > 0
        ? `${money(offsets.health.adjustment)} of health rebate to repay`
        : `${money(-offsets.health.adjustment)} of health rebate to claim`,
    );
  }
  if (parts.length > 0) return `Applied: ${parts.join(' · ')}.`;
  if (profile.hospitalCover === 'unknown' && (offsets.surcharge?.fullYearAmount ?? 0) > 0) {
    return 'Your income is above the surcharge threshold — Ledger needs to know about hospital cover.';
  }
  return 'Nothing here changes your estimate yet. Answer these and Ledger will apply what you are owed.';
}
