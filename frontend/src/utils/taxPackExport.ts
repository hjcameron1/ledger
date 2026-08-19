/**
 * Phase 5.6 — the tax pack, as files.
 *
 * Two CSVs and one printable document, all PURE STRING FUNCTIONS over a built
 * TaxPack. They compute nothing: every figure is already in the pack, and the
 * pack computed nothing either. Keeping them pure is what lets the exports be
 * tested against the same fixtures as the page, so a file an accountant opens
 * cannot say something the screen doesn't.
 *
 * WHY TWO CSVs. They answer different questions:
 *   • the PACK csv is the document — sections, headings, totals, the checks. It
 *     is what a person reads, in a spreadsheet instead of on a page.
 *   • the SOURCES csv is the drill-down flattened — one row per underlying
 *     record, with its date, its amount and the transaction id behind it. It is
 *     what an accountant sorts, filters and ties back to a bank statement.
 * A single file trying to be both would be good at neither.
 *
 * WHY PRINT-TO-PDF RATHER THAN A PDF LIBRARY. A generated PDF would mean a new
 * dependency, its own font and layout engine, and a second renderer to keep in
 * step with the HTML one. The browser already has a typesetter that produces a
 * real, selectable, searchable PDF from a styled document, and every platform's
 * print dialog offers "Save as PDF". So this module emits a self-contained HTML
 * document with print styles, and the caller prints it.
 *
 * SPREADSHEET SAFETY: a text field beginning with =, +, @, tab or CR is prefixed
 * with an apostrophe. Those characters make Excel and Sheets treat a cell as a
 * formula, and a merchant name is not a formula. Numbers are written bare — no
 * symbol, no thousands separator — so they arrive as numbers.
 */

import { formatCurrency, formatDate } from './format';
import { formatFY } from './taxYear';
import { flattenPackLines, type TaxPack, type TaxPackLine, type TaxPackSection } from './taxPack';

// ─── CSV primitives ──────────────────────────────────────────────────────────

/** Characters that make a spreadsheet read a cell as a formula. */
const FORMULA_LEAD = /^[=+@\t\r]/;

function csvText(value: string | null | undefined): string {
  const raw = String(value ?? '');
  const safe = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A number for a spreadsheet: two decimals, nothing else. Blank for null. */
function csvNumber(value: number | null | undefined): string {
  return value == null ? '' : value.toFixed(2);
}

/** A count or a level: an integer, never money. Written without decimals. */
function csvInt(value: number | null | undefined): string {
  return value == null ? '' : String(Math.trunc(value));
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells
    .map(c => (typeof c === 'number' ? csvNumber(c) : csvText(c as string | null)))
    .join(',');
}

const PROVENANCE_LABEL: Record<string, string> = {
  derived: 'derived from your records',
  entered: 'entered by you',
  rates: 'ATO rates for the year',
};

function drillText(line: TaxPackLine): string {
  const d = line.drill;
  if (!d) return '';
  switch (d.kind) {
    case 'transaction': return `transaction ${d.id}`;
    case 'income': return `income line ${d.id}`;
    case 'deduction': return `deduction ${d.id}`;
    case 'property': return `property ${d.id}`;
    case 'cgt-event': return `disposal ${d.id}`;
    case 'dividend': return `dividend statement ${d.id}`;
    case 'section': return `see the ${d.id} section`;
    case 'entry': return `entered on ${d.id}`;
  }
}

function ratesLine(pack: TaxPack): string {
  if (!pack.ratesAvailable) return 'no rates held for this year — nothing below taxable income is estimated';
  return pack.confidence === 'indexed-estimate'
    ? 'held, but this year\'s thresholds are an indexed estimate, not legislated'
    : 'legislated rates for the year';
}

// ─── The pack, as a spreadsheet ──────────────────────────────────────────────

/**
 * The document itself: a metadata block, the reconciliation, every section with
 * its lines and total, and the open questions. One file, four blocks, separated
 * by blank rows so a spreadsheet keeps them apart.
 */
export function taxPackToCsv(pack: TaxPack): string {
  const rows: string[] = [];

  rows.push(csvRow(['Ledger tax pack']));
  rows.push(csvRow(['Financial year', `FY ${formatFY(pack.fy)}`]));
  rows.push(csvRow(['Period', `${pack.start} to ${pack.end}`]));
  rows.push(csvRow(['Prepared', pack.preparedOn]));
  if (pack.taxpayer) rows.push(csvRow(['Taxpayer', pack.taxpayer]));
  rows.push(csvRow(['Rates', ratesLine(pack)]));
  rows.push(csvRow(['Taxable income', pack.taxableIncome]));
  rows.push(csvRow([
    'Estimated outcome',
    pack.outcome === 'refund' ? 'Refund'
      : pack.outcome === 'owing' ? 'Amount owing'
      : pack.outcome === 'square' ? 'Nothing to pay or refund'
      : 'Not estimated',
    pack.outcome === 'refund' ? pack.refund : pack.outcome === 'owing' ? pack.owing : null,
  ]));
  rows.push(csvRow([
    'Reconciles to the Tax page',
    pack.reconciles ? 'Yes — every check agrees' : 'NO — see the checks below',
  ]));
  rows.push(csvRow(['This is an estimate prepared from your own records. It is not a lodgement and not tax advice.']));
  rows.push('');

  rows.push(csvRow(['Reconciliation check', 'Pack', 'Tax page', 'Result']));
  for (const c of pack.checks) {
    rows.push(csvRow([
      c.label,
      c.pack,
      c.page,
      c.skipped ? `not run — ${c.skipped}` : c.agrees ? 'agrees' : 'DOES NOT AGREE',
    ]));
  }
  rows.push('');

  rows.push(csvRow([
    'Section', 'Section role', 'Level', 'Line', 'Date', 'Amount',
    'Treatment', 'Source', 'Detail', 'Drills to',
  ]));
  for (const s of pack.sections) {
    if (s.empty && s.lines.length === 0) {
      rows.push(csvRow([s.title, s.role, csvInt(0), s.note ?? 'Nothing recorded', '', null, 'info', '', '', '']));
    }
    for (const { line, depth } of flattenPackLines(s)) {
      rows.push(csvRow([
        s.title,
        s.role,
        csvInt(depth),
        line.label,
        line.date ?? '',
        line.amount,
        line.role,
        PROVENANCE_LABEL[line.provenance] ?? line.provenance,
        line.detail ?? '',
        drillText(line),
      ]));
    }
    rows.push(csvRow([s.title, s.role, csvInt(0), s.totalLabel, '', s.total, 'total', '', '', '']));
    rows.push('');
  }

  rows.push(csvRow(['For your accountant', 'Severity', 'Section', 'Amount', 'Count']));
  if (pack.gaps.length === 0) {
    rows.push(csvRow(['Nothing outstanding.', 'info', '', null, '']));
  }
  for (const g of pack.gaps) {
    rows.push(csvRow([g.message, g.severity, g.section ?? '', g.amount ?? null, csvInt(g.count)]));
  }

  return rows.join('\n');
}

// ─── The drill-down, as a spreadsheet ────────────────────────────────────────

/**
 * One row per underlying record — the pack's own drill-down, flattened. A LEAF
 * only: a line with children is a heading over rows that are already here, and
 * emitting both would let a careless sum count the year twice.
 */
export function taxPackSourcesToCsv(pack: TaxPack): string {
  const rows: string[] = [];
  rows.push(csvRow(['Ledger tax pack — source records', `FY ${formatFY(pack.fy)}`, pack.preparedOn]));
  rows.push(csvRow(['Every record behind a figure in the pack. Leaf rows only, so the amounts do not overlap.']));
  rows.push('');
  rows.push(csvRow([
    'Section', 'Heading', 'Record', 'Date', 'Amount', 'Treatment',
    'Counted', 'Source', 'Detail', 'Transaction ID', 'Drills to',
  ]));

  for (const s of pack.sections) {
    const path: string[] = [];
    const walk = (lines: TaxPackLine[], depth: number) => {
      for (const l of lines) {
        if (l.children.length > 0) {
          path[depth] = l.label;
          walk(l.children, depth + 1);
          path.length = depth;
          continue;
        }
        rows.push(csvRow([
          s.title,
          path.filter(Boolean).join(' › '),
          l.label,
          l.date ?? '',
          l.amount,
          l.role,
          l.role === 'info' ? 'no' : 'yes',
          PROVENANCE_LABEL[l.provenance] ?? l.provenance,
          l.detail ?? '',
          l.drill?.kind === 'transaction' ? l.drill.id : '',
          drillText(l),
        ]));
      }
    };
    walk(s.lines, 0);
  }

  return rows.join('\n');
}

/** A stable, sortable filename. No spaces, no punctuation a shell dislikes. */
export function taxPackFilename(pack: TaxPack, kind: 'pack' | 'sources'): string {
  const fy = pack.fy.replace(/[^0-9]/g, '-');
  return `ledger-tax-${kind}-fy-${fy}.csv`;
}

// ─── The printable document ──────────────────────────────────────────────────

function esc(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface TaxPackHtmlOptions {
  currency: string;
  /**
   * 'summary' prints headings and the lines directly under them — the document
   * a person reads. 'full' prints every level, down to each transaction, which
   * is the whole audit trail and can run to many pages.
   */
  detail?: 'summary' | 'full';
}

/**
 * A self-contained printable document. Inline styles only, no scripts, no
 * external anything — so it prints identically from an iframe, a new window or
 * a file saved to disk.
 */
export function taxPackToHtml(pack: TaxPack, opts: TaxPackHtmlOptions): string {
  const money = (n: number | null | undefined) =>
    n == null ? '—' : formatCurrency(n, opts.currency);
  const maxDepth = opts.detail === 'full' ? 99 : 1;

  const headline = pack.outcome === 'refund'
    ? `Estimated refund of ${money(pack.refund)}`
    : pack.outcome === 'owing'
      ? `Estimated ${money(pack.owing)} to pay`
      : pack.outcome === 'square'
        ? 'Nothing to pay, nothing to come back'
        : 'Outcome not estimated for this year';

  const sectionHtml = (s: TaxPackSection): string => {
    const rows = flattenPackLines(s)
      .filter(({ depth }) => depth <= maxDepth)
      .map(({ line, depth }) => `
        <tr class="lvl-${depth} role-${line.role}">
          <td class="lbl" style="padding-left:${8 + depth * 18}px">
            <span class="name">${esc(line.label)}</span>
            ${line.provenance !== 'derived'
              ? `<span class="prov prov-${line.provenance}">${line.provenance}</span>` : ''}
            ${line.detail ? `<span class="det">${esc(line.detail)}</span>` : ''}
          </td>
          <td class="amt">${line.role === 'subtract' && line.amount
            ? `−${money(line.amount)}`
            : money(line.amount)}</td>
        </tr>`).join('');

    return `
      <section class="sec">
        <h2>${esc(s.title)}
          ${s.role === 'schedule'
            ? `<span class="tag">schedule${s.supports ? ` · ${esc(s.supports)}` : ''}</span>` : ''}
        </h2>
        ${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
        ${rows ? `<table>${rows}
          <tr class="tot"><td class="lbl">${esc(s.totalLabel)}</td>
          <td class="amt">${money(s.total)}</td></tr></table>` : ''}
      </section>`;
  };

  const checksHtml = pack.reconciles
    ? `<p class="ok">Every figure in this pack was checked against the position it came from, and they agree.</p>`
    : `<div class="bad">
         <p><strong>This pack does not reconcile.</strong> The figures below disagree with the
         position they were built from, so do not lodge from it until that is resolved.</p>
         <ul>${pack.checks.filter(c => !c.agrees).map(c =>
           `<li>${esc(c.label)} — pack ${money(c.pack)}, position ${money(c.page)}</li>`).join('')}</ul>
       </div>`;

  const gapsHtml = pack.gaps.length === 0 ? '' : `
    <section class="sec avoid">
      <h2>For your accountant</h2>
      <ul class="gaps">
        ${pack.gaps.map(g => `<li class="${g.severity}">
          <span class="sev">${g.severity === 'warn' ? 'Check' : 'Note'}</span>
          ${esc(g.message)}${g.amount != null ? ` (${money(g.amount)})` : ''}
        </li>`).join('')}
      </ul>
    </section>`;

  return `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8">
<title>Ledger tax pack — FY ${esc(formatFY(pack.fy))}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 11px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         color: #18181b; margin: 0; padding: 24px; max-width: 820px; }
  header { border-bottom: 2px solid #18181b; padding-bottom: 10px; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { color: #52525b; font-size: 10.5px; }
  .meta span { margin-right: 14px; }
  .headline { margin: 14px 0 4px; font-size: 15px; font-weight: 600; }
  .disclaimer { color: #52525b; font-size: 10px; margin: 0 0 14px; }
  .ok { color: #15803d; font-size: 10.5px; margin: 0 0 14px; }
  .bad { border: 1.5px solid #b91c1c; color: #7f1d1d; padding: 8px 10px; margin: 0 0 14px; }
  .bad ul { margin: 6px 0 0 16px; padding: 0; }
  .sec { margin: 0 0 18px; page-break-inside: avoid; }
  h2 { font-size: 12.5px; margin: 0 0 2px; border-bottom: 1px solid #d4d4d8; padding-bottom: 3px; }
  .tag { font-weight: 400; font-size: 9.5px; color: #71717a; margin-left: 6px; }
  .sub, .note { color: #52525b; font-size: 10px; margin: 3px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2.5px 0; vertical-align: top; }
  td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 120px; }
  tr.lvl-0 > td { font-weight: 500; }
  tr.lvl-1 > td, tr.lvl-2 > td, tr.lvl-3 > td { font-weight: 400; color: #3f3f46; }
  tr.role-info > td { color: #71717a; }
  tr.tot > td { border-top: 1px solid #18181b; font-weight: 700; padding-top: 4px; }
  .det { color: #71717a; display: block; font-size: 9.5px; }
  .prov { font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em;
          border: 1px solid #d4d4d8; border-radius: 3px; padding: 0 3px; margin-left: 5px; color: #71717a; }
  .prov-entered { border-color: #a16207; color: #a16207; }
  .gaps { margin: 6px 0 0; padding: 0; list-style: none; }
  .gaps li { margin: 0 0 5px; padding-left: 52px; text-indent: -52px; }
  .sev { display: inline-block; width: 44px; font-size: 9px; text-transform: uppercase;
         letter-spacing: .04em; color: #71717a; text-indent: 0; }
  .gaps li.warn .sev { color: #b45309; font-weight: 700; }
  footer { border-top: 1px solid #d4d4d8; margin-top: 18px; padding-top: 8px;
           color: #71717a; font-size: 9.5px; }
  @media print { body { padding: 0; } .avoid { page-break-inside: avoid; } }
</style></head>
<body>
  <header>
    <h1>Tax pack — FY ${esc(formatFY(pack.fy))}</h1>
    <p class="meta">
      <span>${esc(formatDate(pack.start))} – ${esc(formatDate(pack.end))}</span>
      <span>Prepared ${esc(formatDate(pack.preparedOn))}</span>
      ${pack.taxpayer ? `<span>${esc(pack.taxpayer)}</span>` : ''}
      <span>Rates: ${esc(ratesLine(pack))}</span>
    </p>
  </header>
  <p class="headline">${esc(headline)}</p>
  <p class="disclaimer">
    Prepared by Ledger from your own records. Taxable income ${money(pack.taxableIncome)}.
    This is an estimate to work from, not a lodgement and not tax advice. Figures marked
    <span class="prov prov-entered">entered</span> were typed in rather than derived, and want
    a statement behind them.
  </p>
  ${checksHtml}
  ${pack.sections.map(sectionHtml).join('')}
  ${gapsHtml}
  <footer>
    Ledger · FY ${esc(formatFY(pack.fy))} · prepared ${esc(formatDate(pack.preparedOn))} ·
    ${opts.detail === 'full' ? 'full detail, every source record' : 'summary detail'} ·
    ${pack.reconciles ? 'reconciled to the Ledger tax position' : 'DOES NOT RECONCILE — see above'}
  </footer>
</body></html>`;
}
