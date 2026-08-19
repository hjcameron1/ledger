import { useMemo, useState } from 'react';
import Card from '../common/Card';
import { formatCurrency, formatDate } from '../../utils/format';
import { formatFY, type TaxYearPosition, type IncomeLine } from '../../utils/taxYear';
import type { DeductionLine } from '../../utils/taxDeductions';
import SourceTransactionModal from './SourceTransactionModal';

/**
 * Phase 5.1 — the Tax FY summary.
 *
 * One card answers "where do I stand for this financial year", and every figure
 * on it opens: category → the lines inside it → the source transaction. Nothing
 * is computed here. The whole position arrives from taxYearDS/buildTaxYearPosition,
 * so what the user drills into is literally what was counted.
 *
 * Excluded lines (pending income, a duplicate, a payslip mirror) are SHOWN, struck
 * through, with the reason — an amount that was left out is more confusing when
 * it's invisible than when it's explained.
 */

const EXCLUSION_LABEL: Record<string, string> = {
  'pending': 'pending — not counted',
  'counted-in-payslip': 'already in payslip totals',
  'possible-duplicate': 'possible duplicate — counted once',
  'refund': 'refund, not income',
  'transfer': 'internal transfer',
  'counted-in-income': 'cash already counted — only the franking credit was added',
  'counted-in-rental': 'counted on the rental schedule below',
};

/** Why a DEDUCTION line is shown but not counted. */
const DEDUCTION_EXCLUSION_LABEL: Record<string, string> = {
  'duplicate': 'possible duplicate — counted once',
  'counted-in-rental': 'claimed on the rental schedule, at your share',
};

export default function TaxYearSummary({ position, currency, fySelector }: {
  position: TaxYearPosition;
  currency: string;
  /** The FY switcher, owned by the page so the deduction list shares it. */
  fySelector?: React.ReactNode;
}) {
  const [openIncome, setOpenIncome] = useState<string | null>(null);
  const [openDeduction, setOpenDeduction] = useState<string | null>(null);
  const [sourceTxId, setSourceTxId] = useState<string | null>(null);

  const money = (n: number) => formatCurrency(n, currency);
  const hasBusiness = position.business.income > 0 || position.business.deductions > 0;

  const periodLabel = useMemo(
    () => `${formatDate(position.start)} – ${formatDate(position.end)}`,
    [position.start, position.end],
  );

  return (
    <>
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="font-semibold">Tax FY {formatFY(position.fy)}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{periodLabel}</p>
          </div>
          {fySelector}
        </div>

        {/* The position, in the order it is derived. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Figure label="Assessable income" value={money(position.assessableIncome)} />
          <Figure label="Deductible expenses" value={`−${money(position.deductibleExpenses)}`} tone="good" />
          <Figure
            label="Estimated taxable income"
            value={money(position.estimatedTaxableIncome)}
            emphasis
            hint="Income less deductions. Tax is calculated on this."
          />
          <Figure label="PAYG withheld" value={money(position.taxWithheld)} />
        </div>

        {position.deductions.refundedTotal > 0 && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
            {money(position.deductions.refundedTotal)} refunded during the year has already been
            taken off the deduction total.
          </p>
        )}

        {/* Things to look at before trusting the number. */}
        {position.notes.length > 0 && (
          <div className="mt-4 space-y-2">
            {position.notes.map((n, i) => (
              <div key={i} className="rounded-[10px] border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2">
                <p className="text-xs text-[#b45309] dark:text-[#fbbf24]">
                  {n.message}
                  {n.amount != null && <span className="font-medium"> {money(n.amount)}.</span>}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Income — by category, drilling down to each source. */}
      <Card className="mb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-medium">Income</h3>
          <span className="text-sm font-semibold amount">{money(position.income.total)}</span>
        </div>
        {position.income.groups.length === 0 ? (
          <Empty>No income recorded for FY {formatFY(position.fy)}.</Empty>
        ) : (
          <div className="space-y-1">
            {position.income.groups.map(g => {
              const counted = g.lines.filter(l => !l.excluded).length;
              const skipped = g.lines.length - counted;
              return (
              <Drilldown
                key={g.category}
                open={openIncome === g.category}
                onToggle={() => setOpenIncome(openIncome === g.category ? null : g.category)}
                title={g.category}
                subtitle={[
                  counted > 0 ? `${counted} source${counted === 1 ? '' : 's'}` : null,
                  skipped > 0 ? `${skipped} not counted` : null,
                ].filter(Boolean).join(' · ')}
                amount={money(g.total)}
              >
                {g.lines.map(line => (
                  <IncomeLineRow
                    key={line.key}
                    line={line}
                    currency={currency}
                    onOpenSource={setSourceTxId}
                  />
                ))}
              </Drilldown>
              );
            })}
          </div>
        )}
      </Card>

      {/* Deductions — by category, with the entity split and the same drill-down. */}
      <Card className="mb-6">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-medium">Deductions by category</h3>
          <span className="text-sm font-semibold amount text-[#22c55e]">−{money(position.deductibleExpenses)}</span>
        </div>
        {position.deductionCategories.length === 0 ? (
          <Empty>
            No deductions for FY {formatFY(position.fy)} yet. Add one below, or mark a transaction
            as tax-deductible.
          </Empty>
        ) : (
          <div className="space-y-1">
            {position.deductionCategories.map(cat => {
              const group = position.deductions.groups.find(g => g.category === cat.category);
              return (
                <Drilldown
                  key={cat.category}
                  open={openDeduction === cat.category}
                  onToggle={() => setOpenDeduction(openDeduction === cat.category ? null : cat.category)}
                  title={cat.category}
                  subtitle={
                    cat.business > 0
                      ? `${cat.share.toFixed(0)}% of claims · ${money(cat.business)} business`
                      : `${cat.share.toFixed(0)}% of claims`
                  }
                  amount={`−${money(cat.total)}`}
                  amountClass="text-[#22c55e]"
                  bar={cat.share}
                >
                  {(group?.lines ?? []).map(line => (
                    <DeductionLineRow
                      key={line.key}
                      line={line}
                      currency={currency}
                      onOpenSource={setSourceTxId}
                    />
                  ))}
                </Drilldown>
              );
            })}
          </div>
        )}
      </Card>

      {/* Business vs personal — only when the user actually keeps both. */}
      {hasBusiness && (
        <Card className="mb-6">
          <h3 className="font-medium mb-3">Business vs personal</h3>
          <div className="grid grid-cols-2 gap-4">
            {([['Business', position.business], ['Personal', position.personal]] as const).map(([label, side]) => (
              <div key={label} className="rounded-[10px] border border-zinc-100 dark:border-zinc-800 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">{label}</p>
                <div className="space-y-1.5">
                  <SplitRow label="Income" value={money(side.income)} />
                  <SplitRow label="Deductions" value={`−${money(side.deductions)}`} tone="good" />
                  <SplitRow label="Net" value={money(side.net)} strong tone={side.net < 0 ? 'bad' : undefined} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-3">
            A transaction with no entity set counts as personal. Set it in a transaction's tax
            details to move it across.
          </p>
        </Card>
      )}

      <SourceTransactionModal transactionId={sourceTxId} onClose={() => setSourceTxId(null)} />
    </>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Figure({ label, value, hint, emphasis, tone }: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  tone?: 'good';
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p
        className={`font-semibold amount mt-1 ${emphasis ? 'text-xl text-brand' : 'text-lg'} ${tone === 'good' ? 'text-[#22c55e]' : ''}`}
        title={hint}
      >
        {value}
      </p>
      {hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-zinc-500 dark:text-zinc-400 py-3 text-center">{children}</p>;
}

function SplitRow({ label, value, strong, tone }: {
  label: string; value: string; strong?: boolean; tone?: 'good' | 'bad';
}) {
  const colour = tone === 'good' ? 'text-[#22c55e]' : tone === 'bad' ? 'text-[#ef4444]' : '';
  return (
    <div className="flex justify-between gap-2">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={`text-xs amount ${strong ? 'font-semibold' : ''} ${colour}`}>{value}</span>
    </div>
  );
}

/** A category row that expands to the lines it is made of. */
function Drilldown({ open, onToggle, title, subtitle, amount, amountClass = '', bar, children }: {
  open: boolean;
  onToggle: () => void;
  title: string;
  subtitle: string;
  amount: string;
  amountClass?: string;
  bar?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 rounded-[8px] px-1 transition-colors"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            <span className="inline-block w-3 text-zinc-400">{open ? '▾' : '▸'}</span> {title}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-4">{subtitle}</p>
          {bar != null && (
            <div className="ml-4 mt-1.5 h-1 w-24 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full bg-brand/60" style={{ width: `${Math.min(100, Math.max(0, bar))}%` }} />
            </div>
          )}
        </div>
        <span className={`text-sm font-semibold amount shrink-0 ${amountClass}`}>{amount}</span>
      </button>
      {open && <div className="pl-4 pb-2 space-y-1">{children}</div>}
    </div>
  );
}

function IncomeLineRow({ line, currency, onOpenSource }: {
  line: IncomeLine;
  currency: string;
  onOpenSource: (id: string) => void;
}) {
  const kindLabel =
    line.kind === 'payslip' ? 'payslip'
    : line.kind === 'entry' ? 'income entry'
    : line.kind === 'capital-gain' ? 'capital gains'
    : line.kind === 'dividend' ? 'dividend statement'
    : line.kind === 'rent' ? 'rental property'
    : 'transaction';
  return (
    <LineRow
      name={line.label}
      badge={kindLabel}
      meta={[formatDate(line.date), line.detail].filter(Boolean).join(' · ')}
      amount={formatCurrency(line.amount, currency)}
      excluded={line.excluded}
      excludedLabel={line.excludedReason ? EXCLUSION_LABEL[line.excludedReason] : null}
      onOpenSource={line.transactionId ? () => onOpenSource(line.transactionId!) : undefined}
    />
  );
}

function DeductionLineRow({ line, currency, onOpenSource }: {
  line: DeductionLine;
  currency: string;
  onOpenSource: (id: string) => void;
}) {
  const meta = [
    formatDate(line.date),
    line.merchant,
    line.entity === 'business' ? 'business' : null,
    line.refunded > 0 ? `${formatCurrency(line.refunded, currency)} refunded` : null,
  ].filter(Boolean).join(' · ');

  return (
    <LineRow
      name={line.name}
      badge={
        line.source === 'rental' ? 'rental schedule'
        : line.source === 'manual' ? (line.linked ? 'manual · linked' : 'manual')
        : 'transaction'
      }
      meta={meta}
      amount={`−${formatCurrency(line.netAmount, currency)}`}
      strikeAmount={line.refunded > 0 ? formatCurrency(line.amount, currency) : null}
      excluded={line.excluded}
      excludedLabel={
        line.excluded
          ? DEDUCTION_EXCLUSION_LABEL[line.excludedReason ?? 'duplicate'] ?? 'counted once'
          : null
      }
      onOpenSource={line.transactionId ? () => onOpenSource(line.transactionId!) : undefined}
    />
  );
}

function LineRow({ name, badge, meta, amount, strikeAmount, excluded, excludedLabel, onOpenSource }: {
  name: string;
  badge: string;
  meta: string;
  amount: string;
  strikeAmount?: string | null;
  excluded: boolean;
  excludedLabel?: string | null;
  onOpenSource?: () => void;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 ${excluded ? 'opacity-70' : ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm truncate">{name}</p>
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-500 dark:text-zinc-400">{badge}</span>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
          {meta}
          {excludedLabel && <span className="text-[#b45309] dark:text-[#fbbf24]"> · {excludedLabel}</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {strikeAmount && (
          <span className="text-xs text-zinc-400 dark:text-zinc-500 line-through amount">{strikeAmount}</span>
        )}
        <span className={`text-sm amount ${excluded ? 'text-zinc-400 dark:text-zinc-500 line-through' : ''}`}>{amount}</span>
        {onOpenSource && (
          <button
            onClick={onOpenSource}
            className="text-xs text-zinc-400 hover:text-brand transition-colors"
            title="View the source transaction"
          >
            ↗
          </button>
        )}
      </div>
    </div>
  );
}
