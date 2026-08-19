import { useState } from 'react';
import Card from '../common/Card';
import Input from '../common/Input';
import SourceTransactionModal from './SourceTransactionModal';
import { formatCurrency, formatDate } from '../../utils/format';
import { formatFY } from '../../utils/taxYear';
import { TAX_CREDIT_FIELDS, type TaxCreditField, type TaxCredits } from '../../utils/taxCredits';
import { settlementHeadline, type TaxSettlement, type WithholdingSource } from '../../utils/taxSettlement';

/**
 * Phase 5.2 — the settlement card: what you owe, what you've paid, and the gap.
 *
 * Nothing is computed here. The whole settlement arrives from
 * utils/taxSettlement.buildTaxSettlement, so the headline figure and the lines
 * underneath it are literally the same arithmetic, and the PAYG row opens onto
 * the exact income sources that were added up to make it.
 *
 * The unsupported-year and provisional-year states are not decorations: with no
 * rates there is no liability line at all, and the outcome is refused rather
 * than approximated.
 *
 * Phase 5.3 adds a THIRD section between the two: offsets. They get their own
 * block rather than being netted into either side, because a reader has to be
 * able to see that the headline is gross tax minus offsets minus what was paid.
 */
export default function TaxSettlement({
  settlement, currency, credits, onChangeCredit, unsupportedDetail, supersededFields,
}: {
  settlement: TaxSettlement;
  currency: string;
  credits: TaxCredits;
  onChangeCredit: (key: TaxCreditField, value: number) => void;
  /**
   * Phase 5.4 — fields whose typed-in figure has been replaced by a more explicit
   * record elsewhere (today: franking credits, once dividend statements exist).
   * The input keeps the user's number so it is not silently destroyed; the note
   * says what is actually being counted instead.
   */
  supersededFields?: Partial<Record<TaxCreditField, string>>;
  /** Which years Ledger does hold rates for — page-level knowledge, shown with
   *  the no-rates warning so "unavailable" says what would be available. */
  unsupportedDetail?: React.ReactNode;
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [sourceTxId, setSourceTxId] = useState<string | null>(null);

  const money = (n: number) => formatCurrency(n, currency);
  const { outcome, ratesAvailable } = settlement;
  const headlineAmount = outcome === 'refund' ? settlement.refund : settlement.owing;
  const tone =
    outcome === 'refund' ? 'text-[#22c55e]' : outcome === 'owing' ? 'text-[#ef4444]' : '';

  const warn = settlement.warnings.filter(w => w.severity === 'warn');
  const info = settlement.warnings.filter(w => w.severity === 'info');

  return (
    <>
      <Card className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-4">
          <h2 className="font-semibold">Tax settlement</h2>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">FY {formatFY(settlement.fy)}</span>
        </div>

        {/* The subtraction, in the order it is made. */}
        <div className="grid grid-cols-3 gap-4">
          <Headline
            label="Estimated liability"
            value={settlement.netLiability == null ? '—' : money(settlement.netLiability)}
            muted={settlement.netLiability == null}
            hint={
              settlement.effectiveTaxRate != null && settlement.effectiveTaxRate > 0
                ? `${settlement.effectiveTaxRate.toFixed(1)}% of taxable income`
                : undefined
            }
          />
          <Headline label="Tax paid & credits" value={money(settlement.credits.total)} />
          <Headline
            label={settlementHeadline(outcome)}
            value={outcome === 'unknown' ? '—' : outcome === 'square' ? money(0) : money(headlineAmount)}
            muted={outcome === 'unknown'}
            tone={tone}
            emphasis
            hint={
              outcome === 'square' ? 'Paid almost exactly the right amount'
                : outcome === 'refund' ? 'More was withheld than the year costs'
                : outcome === 'owing' ? 'Falls due when you lodge'
                : undefined
            }
          />
        </div>

        {/* Liability, by component. Absent entirely when the year has no rates —
            an empty section is the honest rendering of "we can't say". */}
        {ratesAvailable && (
          <Section title="What the year costs" total={money(settlement.liability.total ?? 0)}>
            {settlement.liability.components.map(c => (
              <Row key={c.key} label={c.label} detail={c.detail} value={money(c.amount)} />
            ))}
          </Section>
        )}

        {/* Offsets — neither tax owed nor money paid, so they stand on their own.
            Absent when the year granted none, rather than shown as a zero. */}
        {settlement.offsets.components.length > 0 && (
          <Section
            title="Offsets that reduce it"
            total={`−${money(settlement.offsets.total)}`}
            totalClass="text-[#22c55e]"
          >
            {settlement.offsets.components.map(c => (
              <Row
                key={c.key}
                label={c.label}
                detail={c.detail}
                value={`−${money(c.amount)}`}
                valueClass="text-[#22c55e]"
              />
            ))}
            <div className="flex items-start justify-between gap-3 pt-2 mt-1 border-t border-zinc-100 dark:border-zinc-800">
              <p className="text-sm font-medium">What the year really costs</p>
              <span className="text-sm font-semibold amount shrink-0">
                {money(settlement.netLiability ?? 0)}
              </span>
            </div>
          </Section>
        )}

        {/* Credits, by component, with PAYG opening onto its sources. */}
        <Section
          title="What you've already paid"
          total={`−${money(settlement.credits.total)}`}
          totalClass="text-[#22c55e]"
        >
          {settlement.credits.components.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">
              Nothing recorded as paid towards FY {formatFY(settlement.fy)} yet.
            </p>
          )}
          {settlement.credits.components.map(c =>
            c.key === 'payg-withheld' ? (
              <div key={c.key}>
                <button
                  onClick={() => setSourcesOpen(v => !v)}
                  className="w-full flex items-start justify-between gap-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40 rounded-[8px] px-1 -mx-1 transition-colors"
                  aria-expanded={sourcesOpen}
                >
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="inline-block w-3 text-zinc-400">{sourcesOpen ? '▾' : '▸'}</span> {c.label}
                    </p>
                    {c.detail && <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-4">{c.detail}</p>}
                  </div>
                  <span className="text-sm font-medium amount shrink-0 text-[#22c55e]">−{money(c.amount)}</span>
                </button>
                {sourcesOpen && (
                  <div className="pl-4 pb-2">
                    {settlement.withholdingSources.length === 0 ? (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2">No income sources counted.</p>
                    ) : (
                      settlement.withholdingSources.map(s => (
                        <SourceRow
                          key={s.key}
                          source={s}
                          currency={currency}
                          onOpenSource={setSourceTxId}
                        />
                      ))
                    )}
                  </div>
                )}
              </div>
            ) : (
              <Row key={c.key} label={c.label} detail={c.detail} value={`−${money(c.amount)}`} valueClass="text-[#22c55e]" />
            ),
          )}

          {/* The credits Ledger cannot derive. Collapsed until asked for, because
              most people have none of them. */}
          <div className="pt-2">
            <button
              onClick={() => setCreditsOpen(v => !v)}
              className="text-xs text-brand hover:underline"
            >
              {creditsOpen ? 'Done' : settlement.otherCredits > 0 ? 'Edit other tax paid' : 'Add other tax paid'}
            </button>
            {creditsOpen && (
              <div className="mt-3 space-y-3">
                {TAX_CREDIT_FIELDS.map(f => (
                  <div key={f.key}>
                    <Input
                      label={f.label}
                      type="number"
                      step="0.01"
                      min="0"
                      prefix="$"
                      value={credits[f.key] === 0 ? '' : String(credits[f.key])}
                      onChange={e => onChangeCredit(f.key, parseFloat(e.target.value) || 0)}
                      placeholder="0.00"
                    />
                    <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{f.help}</p>
                    {supersededFields?.[f.key] && (
                      <p className="text-xs text-[#b45309] dark:text-[#fbbf24] mt-1">
                        {supersededFields[f.key]}
                      </p>
                    )}
                  </div>
                ))}
                <p className="text-xs text-zinc-400 dark:text-zinc-500">
                  Saved against FY {formatFY(settlement.fy)} only — each of these is an annual figure.
                  Tax withheld from your pay is already counted above.
                </p>
              </div>
            )}
          </div>
        </Section>

        {/* Anything that could move the outcome, then the standing limitations. */}
        {warn.length > 0 && (
          <div className="mt-4 space-y-2">
            {warn.map((w, i) => (
              <div key={i} className="rounded-[10px] border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2">
                <p className="text-xs text-[#b45309] dark:text-[#fbbf24]">
                  {w.message}
                  {w.amount != null && <span className="font-medium"> {money(w.amount)}.</span>}
                  {w.kind === 'no-rates' && unsupportedDetail && <> {unsupportedDetail}</>}
                </p>
              </div>
            ))}
          </div>
        )}
        {(info.length > 0 || settlement.notes.length > 0) && (
          <div className="mt-3 space-y-1">
            {settlement.notes.map((n, i) => (
              <p key={`n${i}`} className="text-xs text-zinc-400 dark:text-zinc-500">{n}</p>
            ))}
            {info.map((w, i) => (
              <p key={`i${i}`} className="text-xs text-zinc-400 dark:text-zinc-500">
                {w.message}
                {w.amount != null && <span> {money(w.amount)}.</span>}
              </p>
            ))}
          </div>
        )}
      </Card>

      <SourceTransactionModal transactionId={sourceTxId} onClose={() => setSourceTxId(null)} />
    </>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Headline({ label, value, hint, tone = '', muted, emphasis }: {
  label: string; value: string; hint?: string; tone?: string; muted?: boolean; emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`font-semibold amount mt-1 ${emphasis ? 'text-2xl' : 'text-xl'} ${muted ? 'text-zinc-400 dark:text-zinc-500' : tone}`}>
        {value}
      </p>
      {hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function Section({ title, total, totalClass = '', children }: {
  title: string; total: string; totalClass?: string; children: React.ReactNode;
}) {
  return (
    <div className="mt-5 pt-4 border-t border-zinc-100 dark:border-zinc-800">
      <div className="flex items-baseline justify-between mb-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
        <span className={`text-sm font-semibold amount ${totalClass}`}>{total}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ label, detail, value, valueClass = '' }: {
  label: string; detail?: string | null; value: string; valueClass?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {detail && <p className="text-xs text-zinc-500 dark:text-zinc-400">{detail}</p>}
      </div>
      <span className={`text-sm font-medium amount shrink-0 ${valueClass}`}>{value}</span>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  payslip: 'payslip',
  entry: 'income entry',
  transaction: 'transaction',
};

/** One income source and the tax withheld from it — the PAYG drill-down row. */
function SourceRow({ source, currency, onOpenSource }: {
  source: WithholdingSource;
  currency: string;
  onOpenSource: (id: string) => void;
}) {
  const money = (n: number) => formatCurrency(n, currency);
  const none = source.withheld === 0;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm truncate">{source.label}</p>
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-500 dark:text-zinc-400">
            {KIND_LABEL[source.kind] ?? source.kind}
          </span>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
          {[formatDate(source.date), `${money(source.income)} income`, source.detail]
            .filter(Boolean)
            .join(' · ')}
          {none && <span className="text-[#b45309] dark:text-[#fbbf24]"> · nothing withheld</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="text-right">
          <p className={`text-sm amount ${none ? 'text-zinc-400 dark:text-zinc-500' : 'text-[#22c55e]'}`}>
            {none ? money(0) : `−${money(source.withheld)}`}
          </p>
          {!none && (
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{source.effectiveRate.toFixed(1)}% withheld</p>
          )}
        </div>
        {source.transactionId && (
          <button
            onClick={() => onOpenSource(source.transactionId!)}
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
