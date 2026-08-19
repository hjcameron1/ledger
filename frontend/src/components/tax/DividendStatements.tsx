import { useState } from 'react';
import Card from '../common/Card';
import Input from '../common/Input';
import Button from '../common/Button';
import { formatCurrency, formatDate } from '../../utils/format';
import { formatFY } from '../../utils/taxYear';
import {
  cashDividendOf,
  maxFrankingCreditFor,
  type DividendPosition,
  type DividendStatement,
} from '../../utils/dividendIncome';

/**
 * Phase 5.4 — dividend statements, and the double-count check they exist for.
 *
 * A franked dividend is one payment with two records: the cash the bank saw, and
 * the statement the registry sent. The statement is the only place the franking
 * credit is written down, and the bank is the only place the cash is. Entering
 * the statement here does NOT re-declare the cash — the card says, per line,
 * which income line already carries it, and adds only the ones nothing covers.
 *
 * It also supersedes the single franking figure on the tax-paid card. The two
 * are never added together; the itemised list wins, and the figure it replaced
 * is named so the user can see what happened to it.
 */
export default function DividendStatements({
  fy, position, statements, currency, onAdd, onRemove,
}: {
  fy: string;
  position: DividendPosition | null;
  statements: DividendStatement[];
  currency: string;
  onAdd: (s: Omit<DividendStatement, 'id'>) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const money = (n: number) => formatCurrency(n, currency);
  const lines = position?.lines ?? [];

  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">Dividends and franking credits</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {lines.length === 0
              ? `No statements for FY ${formatFY(fy)}. Add one and its franking credit is both added to your income and credited against your bill.`
              : `${lines.length} statement${lines.length === 1 ? '' : 's'} · ${money(position!.cashDividends)} cash and ${money(position!.frankingCredit)} of franking credits`}
          </p>
        </div>
        <button onClick={() => setOpen(v => !v)} className="shrink-0 text-xs text-brand hover:underline">
          {open ? 'Done' : 'Add a statement'}
        </button>
      </div>

      {position && lines.length > 0 && (
        <>
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <Figure label="Franked" value={money(position.frankedAmount)} />
            <Figure label="Unfranked" value={money(position.unfrankedAmount)} />
            <Figure label="Franking credits" value={money(position.frankingCredit)} />
            <Figure label="Assessed on" value={money(position.grossedUpTotal)} emphasis
              hint="Cash plus the credits — the ATO grosses them up" />
          </div>

          <div className="mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800 space-y-1">
            {lines.map(l => (
              <div key={l.key} className="flex items-start justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <p className="text-sm truncate">
                    {l.ticker ?? l.label}
                    {l.addsIncome ? (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand">
                        added to income
                      </span>
                    ) : (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-500/10 text-zinc-500 dark:text-zinc-400">
                        cash already counted
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {formatDate(l.date)} · {money(l.frankedAmount)} franked
                    {l.unfrankedAmount > 0 && <> · {money(l.unfrankedAmount)} unfranked</>}
                    {l.matchedIncomeLabel && <> · matched to {l.matchedIncomeLabel}</>}
                    {l.overFrankedBy != null && (
                      <span className="text-[#b45309] dark:text-[#fbbf24]">
                        {' '}· credit is {money(l.overFrankedBy)} above the 30% maximum
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <p className="text-sm amount">{money(l.cash)}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 amount">+{money(l.frankingCredit)} credit</p>
                  </div>
                  <button onClick={() => onRemove(l.statementId)} className="text-xs text-zinc-400 hover:text-[#ef4444]">
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          {position.warnings.length > 0 && (
            <div className="mt-3 space-y-2">
              {position.warnings.map((w, i) => (
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
                    {w.amount != null && <span className="font-medium"> {money(w.amount)}</span>}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {open && <StatementForm currency={currency} onAdd={onAdd} existing={statements.length} />}
    </Card>
  );
}

function Figure({ label, value, hint, emphasis }: {
  label: string; value: string; hint?: string; emphasis?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`font-semibold amount mt-1 ${emphasis ? 'text-lg text-brand' : 'text-lg'}`}>{value}</p>
      {hint && <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{hint}</p>}
    </div>
  );
}

const BLANK = { label: '', ticker: '', paymentDate: '', franked: '', unfranked: '', credit: '', withheld: '' };

function StatementForm({ currency, onAdd, existing }: {
  currency: string;
  onAdd: (s: Omit<DividendStatement, 'id'>) => void;
  existing: number;
}) {
  const [form, setForm] = useState(BLANK);
  const money = (n: number) => formatCurrency(n, currency);

  const franked = parseFloat(form.franked) || 0;
  const unfranked = parseFloat(form.unfranked) || 0;
  const credit = parseFloat(form.credit) || 0;
  const cash = cashDividendOf({ frankedAmount: franked, unfrankedAmount: unfranked });
  // A fully franked dividend at the 30% company rate carries franked × 30/70.
  // Offered as a fill-in, never applied silently: a base rate entity franks at
  // 25%, and a partly franked dividend carries less than either.
  const suggested = maxFrankingCreditFor(franked);
  const valid = form.label.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(form.paymentDate) && cash > 0;

  const submit = () => {
    if (!valid) return;
    onAdd({
      investmentId: null,
      label: form.label.trim(),
      ticker: form.ticker.trim() ? form.ticker.trim().toUpperCase() : null,
      paymentDate: form.paymentDate,
      frankedAmount: franked,
      unfrankedAmount: unfranked,
      frankingCredit: credit,
      withheld: parseFloat(form.withheld) || 0,
    });
    setForm(BLANK);
  };

  return (
    <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Straight off the statement. If the cash already shows up in your income for the year, Ledger
        will match it and count it once — only the franking credit gets added on top.
      </p>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
        <Input label="Holding" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
        <Input label="Ticker" value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))} />
        <Input label="Paid on" type="date" value={form.paymentDate}
          onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))} />
        <Input label={`Franked (${currency})`} type="number" step="0.01" prefix="$" value={form.franked}
          onChange={e => setForm(f => ({ ...f, franked: e.target.value }))} />
        <Input label={`Unfranked (${currency})`} type="number" step="0.01" prefix="$" value={form.unfranked}
          onChange={e => setForm(f => ({ ...f, unfranked: e.target.value }))} />
        <Input label={`Franking credit (${currency})`} type="number" step="0.01" prefix="$" value={form.credit}
          onChange={e => setForm(f => ({ ...f, credit: e.target.value }))} />
        <Input label={`TFN amounts withheld (${currency})`} type="number" step="0.01" prefix="$" value={form.withheld}
          onChange={e => setForm(f => ({ ...f, withheld: e.target.value }))} />
      </div>

      {franked > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          A fully franked dividend of {money(franked)} carries {money(suggested)} at the 30% company rate.{' '}
          <button
            type="button"
            onClick={() => setForm(f => ({ ...f, credit: suggested.toFixed(2) }))}
            className="text-brand hover:underline"
          >
            Use that
          </button>
          {credit > suggested + 0.01 && (
            <span className="text-[#b45309] dark:text-[#fbbf24]"> — what you entered is more than that maximum.</span>
          )}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={submit} disabled={!valid}>Add statement</Button>
        {existing === 0 && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Your first statement replaces the single franking figure on the tax-paid card.
          </p>
        )}
      </div>
    </div>
  );
}
