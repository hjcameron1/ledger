import { useRef, useState } from 'react';
import Card from '../common/Card';
import Button from '../common/Button';
import { formatCurrency, formatDate } from '../../utils/format';
import { formatFY } from '../../utils/taxYear';
import {
  flattenPackLines,
  type TaxPack,
  type TaxPackLine,
  type TaxPackSection,
  type TaxPackSectionId,
} from '../../utils/taxPack';
import {
  taxPackFilename,
  taxPackSourcesToCsv,
  taxPackToCsv,
  taxPackToHtml,
} from '../../utils/taxPackExport';
import SourceTransactionModal from './SourceTransactionModal';

/**
 * Phase 5.6 — the tax return / accountant pack.
 *
 * The whole year as one document, in the order a return runs, with every figure
 * opening onto what it is made of and ending at the transaction. Nothing on this
 * card is computed: `buildTaxPack` re-presents the same objects the rest of the
 * page renders, so the pack and the page cannot disagree — and it CHECKS that,
 * out loud, at the top.
 *
 * Three ways out: the pack as a spreadsheet, the source records as a spreadsheet,
 * and a printable document the browser turns into a PDF.
 */

const ROLE_TONE: Record<string, string> = {
  add: '',
  subtract: 'text-zinc-500 dark:text-zinc-400',
  subtotal: 'font-medium',
  total: 'font-semibold',
  info: 'text-zinc-500 dark:text-zinc-400',
};

/** Print the document. An iframe rather than a popup: nothing to block. */
function printDocument(html: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) return;
    w.focus();
    w.print();
    // Left in place long enough for the print dialog to take its snapshot;
    // removing it synchronously cancels the job in Safari.
    window.setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8;` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function TaxPackCard({ pack, currency }: {
  pack: TaxPack;
  currency: string;
}) {
  const [open, setOpen] = useState<Set<TaxPackSectionId>>(new Set());
  const [openLines, setOpenLines] = useState<Set<string>>(new Set());
  const [sourceTxId, setSourceTxId] = useState<string | null>(null);
  const [fullDetail, setFullDetail] = useState(false);
  const refs = useRef<Partial<Record<TaxPackSectionId, HTMLDivElement | null>>>({});

  const money = (n: number | null | undefined) =>
    n == null ? '—' : formatCurrency(n, currency);

  const toggleSection = (id: TaxPackSectionId) =>
    setOpen(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleLine = (key: string) =>
    setOpenLines(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  /** A 'section' drill: open that section and take the reader to it. */
  const goToSection = (id: TaxPackSectionId) => {
    setOpen(prev => new Set(prev).add(id));
    window.setTimeout(
      () => refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      0,
    );
  };

  const renderLine = (line: TaxPackLine, depth: number) => {
    const expandable = line.children.length > 0;
    const isOpen = openLines.has(line.key);
    const drill = line.drill;
    const clickable = expandable
      || drill?.kind === 'transaction'
      || drill?.kind === 'section';

    const onClick = () => {
      if (expandable) return toggleLine(line.key);
      if (drill?.kind === 'transaction') return setSourceTxId(drill.id);
      if (drill?.kind === 'section') return goToSection(drill.id);
    };

    return (
      <div key={line.key}>
        <div
          onClick={clickable ? onClick : undefined}
          className={`flex items-baseline justify-between gap-3 py-1 rounded-[6px]
            ${clickable ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900/60' : ''}`}
          style={{ paddingLeft: depth * 14 }}
        >
          <div className="min-w-0">
            <span className={`text-xs ${ROLE_TONE[line.role] ?? ''}`}>
              {expandable && (
                <span className="inline-block w-3 text-zinc-400">{isOpen ? '−' : '+'}</span>
              )}
              {line.label}
            </span>
            {line.provenance !== 'derived' && (
              <span className={`ml-1.5 text-[9px] uppercase tracking-wide px-1 py-px rounded-[3px] border
                ${line.provenance === 'entered'
                  ? 'border-[#f59e0b]/40 text-[#b45309] dark:text-[#f59e0b]'
                  : 'border-zinc-300 dark:border-zinc-700 text-zinc-400'}`}>
                {line.provenance}
              </span>
            )}
            {line.detail && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                {line.detail}
              </p>
            )}
          </div>
          <span className={`amount shrink-0 text-xs tabular-nums ${ROLE_TONE[line.role] ?? ''}`}>
            {line.amount == null ? '—'
              : line.role === 'subtract' && line.amount ? `−${money(line.amount)}`
              : money(line.amount)}
          </span>
        </div>
        {expandable && isOpen && line.children.map(c => renderLine(c, depth + 1))}
      </div>
    );
  };

  const renderSection = (s: TaxPackSection) => {
    const isOpen = open.has(s.id);
    return (
      <div
        key={s.id}
        ref={el => { refs.current[s.id] = el; }}
        className="border-t border-zinc-200 dark:border-zinc-800 py-2"
      >
        <div
          onClick={() => toggleSection(s.id)}
          className="flex items-baseline justify-between gap-3 cursor-pointer"
        >
          <div className="min-w-0">
            <span className="text-sm font-medium">
              <span className="inline-block w-3.5 text-zinc-400">{isOpen ? '−' : '+'}</span>
              {s.title}
            </span>
            {s.role === 'schedule' && (
              <span className="ml-2 text-[10px] text-zinc-400">
                schedule{s.supports ? ` · ${s.supports}` : ''}
              </span>
            )}
          </div>
          <span className="amount shrink-0 text-sm font-medium tabular-nums">
            {money(s.total)}
          </span>
        </div>

        {isOpen && (
          <div className="mt-2">
            {s.subtitle && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-1.5">{s.subtitle}</p>
            )}
            {s.note && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-1.5">{s.note}</p>
            )}
            {s.lines.map(l => renderLine(l, 0))}
            {s.lines.length > 0 && (
              <div className="flex items-baseline justify-between gap-3 pt-1.5 mt-1 border-t border-zinc-200 dark:border-zinc-800">
                <span className="text-xs font-semibold">{s.totalLabel}</span>
                <span className="amount text-xs font-semibold tabular-nums">{money(s.total)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const headline = pack.outcome === 'refund' ? `${money(pack.refund)} back`
    : pack.outcome === 'owing' ? `${money(pack.owing)} to pay`
    : pack.outcome === 'square' ? 'Nothing either way'
    : 'Not estimated';

  const failed = pack.checks.filter(c => !c.agrees);
  const lineCount = pack.sections.reduce((n, s) => n + flattenPackLines(s).length, 0);

  return (
    <>
      <Card className="mb-6">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="font-medium">Tax return pack</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              FY {formatFY(pack.fy)} · {formatDate(pack.start)} – {formatDate(pack.end)} ·
              {' '}prepared {formatDate(pack.preparedOn)}
            </p>
          </div>
          <span className="shrink-0 text-sm font-semibold">{headline}</span>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
          Everything for the year in the order a return runs, ready to hand to an accountant.
          Nothing here is worked out twice — every figure is the one already on this page, and
          each opens onto what it is made of, down to the transaction.
        </p>

        {/* Does the document add up to the position it came from? Said first,
            because every other figure on the card depends on the answer. */}
        {pack.reconciles ? (
          <p className="text-xs text-[#22c55e] mb-3">
            Reconciled — all {pack.checks.filter(c => !c.skipped).length} checks agree with the
            figures above{pack.checks.some(c => c.skipped) ? ', and the rest do not apply to this year' : ''}.
          </p>
        ) : (
          <div className="mb-3 rounded-[10px] border border-[#ef4444]/40 bg-[#ef4444]/5 px-3 py-2">
            <p className="text-xs font-medium text-[#ef4444]">
              This pack does not reconcile with the position above — don't lodge from it yet.
            </p>
            <ul className="mt-1 space-y-0.5">
              {failed.map(c => (
                <li key={c.key} className="text-[11px] text-zinc-600 dark:text-zinc-300">
                  {c.label}: pack {money(c.pack)}, position {money(c.page)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Figure label="Taxable income" value={money(pack.taxableIncome)} />
          <Figure
            label="Tax and levies"
            value={money(pack.sections.find(s => s.id === 'tax')?.total)}
          />
          <Figure label="Already paid" value={money(pack.sections.find(s => s.id === 'withholding')?.total)} />
          <Figure label={pack.outcome === 'owing' ? 'Owing' : 'Refund'} value={headline} emphasis />
        </div>

        <div>{pack.sections.map(renderSection)}</div>

        {pack.gaps.length > 0 && (
          <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-xs font-medium mb-1.5">For your accountant</p>
            <ul className="space-y-1">
              {pack.gaps.map(g => (
                <li key={g.key} className="text-[11px] text-zinc-600 dark:text-zinc-300 flex gap-2">
                  <span className={`shrink-0 uppercase tracking-wide text-[9px] pt-px
                    ${g.severity === 'warn' ? 'text-[#f59e0b]' : 'text-zinc-400'}`}>
                    {g.severity === 'warn' ? 'check' : 'note'}
                  </span>
                  <span>
                    {g.message}
                    {g.amount != null && <> ({money(g.amount)})</>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => printDocument(taxPackToHtml(pack, {
                currency,
                detail: fullDetail ? 'full' : 'summary',
              }))}
            >
              Print / save as PDF
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadText(taxPackFilename(pack, 'pack'), taxPackToCsv(pack), 'text/csv')}
            >
              Pack (CSV)
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadText(
                taxPackFilename(pack, 'sources'), taxPackSourcesToCsv(pack), 'text/csv',
              )}
            >
              Source records (CSV)
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 ml-1">
              <input
                type="checkbox"
                checked={fullDetail}
                onChange={e => setFullDetail(e.target.checked)}
                className="accent-current"
              />
              Print every source record
            </label>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-2">
            The printed pack carries {fullDetail ? `all ${lineCount} lines` : 'the headings and their lines'};
            the source-records spreadsheet always carries every one, with the transaction id behind it.
            An estimate from your own records — not a lodgement, and not tax advice.
          </p>
        </div>
      </Card>

      <SourceTransactionModal transactionId={sourceTxId} onClose={() => setSourceTxId(null)} />
    </>
  );
}

function Figure({ label, value, emphasis }: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`amount tabular-nums ${emphasis ? 'text-base font-semibold' : 'text-sm font-medium'}`}>
        {value}
      </p>
    </div>
  );
}
