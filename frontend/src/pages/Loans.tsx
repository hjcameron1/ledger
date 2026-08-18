import { useState, useEffect, useMemo } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { loansDS, loanEventsDS, loanReportDS, transactionsDS, parseDocument } from '../services/dataService';
import { formatCurrency, formatDate, daysUntil, autoCategory } from '../utils/format';
import {
  formatTerm, applyRepayment, offsetBalanceFor, checkMovement,
  type LoanRow, type RepaymentImpact,
} from '../utils/loanEngine';
import type { Loan, LoanType, LoanEvent, Transaction } from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select } from '../components/common/Input';

// ── Loan presentation helpers ─────────────────────────────────────────────────
const LOAN_TYPE_OPTIONS: { value: LoanType; label: string }[] = [
  { value: 'mortgage', label: 'Mortgage' },
  { value: 'personal', label: 'Personal Loan' },
  { value: 'car', label: 'Car Loan' },
  { value: 'hecs', label: 'HECS / Student Debt' },
];
const LOAN_FREQ_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
];
const loanTypeLabel = (t: LoanType): string =>
  LOAN_TYPE_OPTIONS.find(o => o.value === t)?.label ?? t;
const loanTypeBadgeClass = (t: LoanType): string => ({
  mortgage: 'bg-brand/15 text-brand',
  personal: 'bg-[#a855f7]/15 text-[#a855f7]',
  car: 'bg-[#f59e0b]/15 text-[#f59e0b]',
  hecs: 'bg-[#22c55e]/15 text-[#22c55e]',
}[t] ?? 'bg-zinc-500/15 text-zinc-500');

const RATE_TYPE_OPTIONS = [
  { value: 'variable', label: 'Variable' },
  { value: 'fixed', label: 'Fixed' },
];

const MOVEMENT_LABELS: Record<LoanEvent['kind'], string> = {
  repayment: 'Repayment',
  extra_repayment: 'Extra repayment',
  redraw: 'Redraw',
  rate_change: 'Rate change',
};

export default function Loans() {
  const { user, loans, loanEvents, accounts, setLoans, transactions } = useStore();
  const currency = user?.currency_preference ?? 'AUD';

  // Every projected figure on this page comes from the one engine run, so a
  // card, a detail panel and the totals strip can never disagree. Recomputed
  // when a loan, a movement or an offset account's balance changes.
  const report = useMemo(
    () => loanReportDS.build(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loans, loanEvents, accounts],
  );
  const rowFor = (id: string): LoanRow | undefined => report.rows.find(r => r.id === id);

  const [addLoanOpen, setAddLoanOpen] = useState(false);
  const [editLoan, setEditLoan] = useState<Loan | null>(null);
  const [detailLoan, setDetailLoan] = useState<Loan | null>(null);
  const [markPaidLoan, setMarkPaidLoan] = useState<Loan | null>(null);

  // A loan's transactions are its imported repayments — matched by the loan id
  // (or, defensively, its Basiq account id if a re-link is momentarily behind).
  const loanTransactions = (loan: Loan) =>
    transactions
      .filter(t =>
        t.account_id === loan.id ||
        (!!loan.basiq_account_id && t.account_id === loan.basiq_account_id),
      )
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <Layout>
      <PageHeader title="Loans" />

      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-semibold">Loans &amp; Debt ({loans.length})</h2>
          <Button variant="primary" size="sm" onClick={() => setAddLoanOpen(true)}>+ Add Loan</Button>
        </div>
        {/* What the whole debt picture costs, and when it ends. Every figure is
            the engine's; nothing here is stored. */}
        {report.rows.length > 0 && (
          <Card className="mb-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Owing" value={formatCurrency(report.totals.balance, currency)} />
              <Stat label="Repayments / mo" value={formatCurrency(report.totals.monthlyOutlay, currency)} />
              <Stat label="Interest / yr" value={formatCurrency(report.totals.interestPerYear, currency)} />
              <Stat
                label="Debt free"
                value={report.totals.debtFreeDate ? formatDate(report.totals.debtFreeDate) : '—'}
              />
            </div>
            {report.totals.offsetBalance > 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
                {formatCurrency(report.totals.offsetBalance, currency)} offsetting — interest is charged on{' '}
                {formatCurrency(report.totals.effectiveBalance, currency)}. Offset cash stays counted as savings; it
                never reduces the debt itself.
              </p>
            )}
          </Card>
        )}

        {loans.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">🏚️</div>
            <h3 className="font-medium mb-1">No loans</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Track your mortgage, personal, car or HECS debt and its repayments.</p>
            <Button variant="secondary" size="sm" onClick={() => setAddLoanOpen(true)}>+ Add</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {loans.map(loan => {
              const repaid = loan.original_amount > 0
                ? Math.min(100, Math.max(0, ((loan.original_amount - loan.current_balance) / loan.original_amount) * 100))
                : 0;
              const dueInDays = loan.next_due_date ? daysUntil(loan.next_due_date) : null;
              const isHecs = loan.loan_type === 'hecs';
              const txCount = loanTransactions(loan).length;
              const row = rowFor(loan.id);
              return (
                <Card key={loan.id} onClick={() => setDetailLoan(loan)} className="cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium">{loan.name}</h3>
                        <span className={`badge ${loanTypeBadgeClass(loan.loan_type)}`}>{loanTypeLabel(loan.loan_type)}</span>
                      </div>
                      {loan.lender && <p className="text-sm text-zinc-500 dark:text-zinc-400">{loan.lender}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold amount text-[#ef4444]">{formatCurrency(loan.current_balance, currency)}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">of {formatCurrency(loan.original_amount, currency)} borrowed</p>
                    </div>
                  </div>

                  {/* Repaid progress */}
                  <div className="mb-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-zinc-500 dark:text-zinc-400">Repaid</span>
                      <span className="text-[#22c55e]">{repaid.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-[#22c55e]" style={{ width: `${repaid}%` }} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 flex-wrap gap-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      {!isHecs && loan.interest_rate != null && <span>{loan.interest_rate}% p.a.</span>}
                      {isHecs && <span>Indexation-based</span>}
                      {loan.minimum_repayment != null && loan.minimum_repayment > 0 && (
                        <span>Min: {formatCurrency(loan.minimum_repayment, currency)} / {loan.repayment_frequency}</span>
                      )}
                      {loan.next_due_date && (
                        <span className={dueInDays !== null && dueInDays <= 7 ? 'text-[#ef4444] font-medium' : ''}>
                          Next: {formatDate(loan.next_due_date)} {dueInDays !== null && dueInDays <= 3 ? '⚠️' : ''}
                        </span>
                      )}
                      {txCount > 0 && <span>{txCount} repayment{txCount !== 1 ? 's' : ''}</span>}
                      {/* The projection, in one phrase. A loan whose repayment
                          doesn't cover the interest says so instead of showing
                          a payoff date it will never reach. */}
                      {row?.projection.neverPaysOff ? (
                        <span className="text-[#ef4444] font-medium">
                          Repayment is {formatCurrency(row.projection.shortfall, currency)} short of the interest
                        </span>
                      ) : row?.payoffDate ? (
                        <span>Paid off {formatDate(row.payoffDate)} · {formatTerm(row.monthsToPayoff)}</span>
                      ) : null}
                      {row && row.offsetBalance > 0 && (
                        <span>{formatCurrency(row.offsetBalance, currency)} offset</span>
                      )}
                      {row && row.redrawAvailable > 0 && (
                        <span>{formatCurrency(row.redrawAvailable, currency)} redraw</span>
                      )}
                      {row?.property && <span>🏠 {row.property.name}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      {loan.minimum_repayment != null && loan.minimum_repayment > 0 && loan.current_balance > 0 && (
                        <button
                          onClick={e => { e.stopPropagation(); setMarkPaidLoan(loan); }}
                          className="text-brand hover:underline font-medium"
                        >
                          Mark as paid
                        </button>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); setEditLoan(loan); }}
                        className="text-brand hover:underline"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* ── LOAN MODALS ── */}
      <LoanDetailModal
        loan={detailLoan}
        row={detailLoan ? rowFor(detailLoan.id) ?? null : null}
        transactions={detailLoan ? loanTransactions(detailLoan) : []}
        currency={currency}
        onClose={() => setDetailLoan(null)}
        onEdit={() => { const l = detailLoan; setDetailLoan(null); setEditLoan(l); }}
        onChanged={() => setLoans(loansDS.getAll())}
      />

      <LoanModal
        isOpen={addLoanOpen || !!editLoan}
        loan={editLoan}
        currency={currency}
        onClose={() => { setAddLoanOpen(false); setEditLoan(null); }}
        onSave={(data) => {
          if (editLoan) loansDS.update(editLoan.id, data);
          else loansDS.add(data);
          setLoans(loansDS.getAll());
          setAddLoanOpen(false);
          setEditLoan(null);
        }}
        onDelete={editLoan ? () => {
          loansDS.remove(editLoan.id);
          setLoans(loansDS.getAll());
          setEditLoan(null);
        } : undefined}
      />

      <RecordRepaymentModal
        loan={markPaidLoan}
        offset={markPaidLoan ? offsetBalanceFor(markPaidLoan, accounts.map(a => ({ id: a.id, balance: a.balance }))) : 0}
        currency={currency}
        onClose={() => setMarkPaidLoan(null)}
        onConfirm={(amount) => {
          loansDS.markPaid(markPaidLoan!.id, amount);
          setLoans(loansDS.getAll());
          setMarkPaidLoan(null);
        }}
      />
    </Layout>
  );
}

// ─── Loan Detail (transactions) ───────────────────────────────────────────────

function LoanDetailModal({ loan, row, transactions, currency, onClose, onEdit, onChanged }: {
  loan: Loan | null;
  /** The worked-out row from the engine, or null while it is still resolving. */
  row: LoanRow | null;
  transactions: Transaction[];
  currency: string;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  if (!loan) return null;
  const repaid = loan.original_amount > 0
    ? Math.min(100, Math.max(0, ((loan.original_amount - loan.current_balance) / loan.original_amount) * 100))
    : 0;

  // Upload a loan statement and file its rows as repayment history under THIS
  // loan. We only add transactions — never touch original_amount/current_balance,
  // which stay user-owned (or Basiq-owned). That keeps a manual "loan total + how
  // much is left" entry authoritative and stops the balance double-counting the
  // statement it's evidenced by. Dedup is scoped to this loan (date + signed
  // amount) so re-uploading the same statement can never pile up duplicates.
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg('');
    const { parsed, error } = await parseDocument(file, 'bank_statement');
    setUploading(false);
    e.target.value = '';
    if (error) { setUploadMsg(error); return; }
    const acc0 = (parsed as { accounts?: Record<string, unknown>[] } | null)?.accounts?.[0];
    const rows = (acc0?.transactions as { date: string; merchant: string; amount: number; type?: string }[]) ?? [];
    if (!rows.length) { setUploadMsg('No transactions found in that document.'); return; }
    let added = 0;
    const batchState = new Map<string, number>();
    for (const tx of rows) {
      // A repayment (credit) reduces the debt → store positive, matching how
      // Basiq repayments are held; interest/fees (debit) → negative.
      const normalizedAmt = tx.type === 'credit' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      // Canonical ingestion handles duplicate identity (content_hash) so
      // re-uploading a loan statement never piles up duplicates.
      const result = transactionsDS.ingest({
        account_id: loan.id, account_type: 'loan', date: tx.date, merchant: tx.merchant,
        raw_description: tx.merchant,
        amount: normalizedAmt, currency, category: autoCategory(tx.merchant),
        category_source: 'auto',
        is_duplicate_flagged: false, is_subscription: false,
        source: 'statement',
      }, { batchState });
      if (result.status !== 'duplicate') added++;
    }
    setUploadMsg(added > 0
      ? `Imported ${added} new repayment${added !== 1 ? 's' : ''}.`
      : 'No new repayments — they were already imported.');
  };

  return (
    <Modal isOpen={!!loan} onClose={onClose} title={loan.name}>
      <div className="space-y-4">
        <div className="flex items-start justify-between">
          <div>
            {loan.lender && <p className="text-sm text-zinc-500 dark:text-zinc-400">{loan.lender}</p>}
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{repaid.toFixed(0)}% repaid</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold amount text-[#ef4444]">{formatCurrency(loan.current_balance, currency)}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">of {formatCurrency(loan.original_amount, currency)}</p>
          </div>
        </div>

        {row && <LoanProjectionPanel row={row} currency={currency} />}
        {row && <LoanMovements row={row} currency={currency} onChanged={onChanged} />}

        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Repayments ({transactions.length})</h3>
          <div className="flex items-center gap-3 shrink-0">
            <label className={`text-brand hover:underline text-sm cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploading ? 'Reading…' : 'Add statement'}
              <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} disabled={uploading} />
            </label>
            <button onClick={onEdit} className="text-brand hover:underline text-sm">Edit loan</button>
          </div>
        </div>

        {uploadMsg && <p className="text-xs text-zinc-500 dark:text-zinc-400 -mt-2">{uploadMsg}</p>}

        {transactions.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">
            No repayments recorded yet. Upload a statement or imported repayments appear here automatically.
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto -mx-1">
            {transactions.map(tx => (
              <div key={tx.id} className="flex items-center justify-between gap-3 px-1 py-2 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm truncate">{tx.merchant}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{formatDate(tx.date)}{tx.category ? ` · ${tx.category}` : ''}</p>
                </div>
                <p className={`text-sm amount shrink-0 ${tx.amount >= 0 ? 'text-[#22c55e]' : 'text-zinc-900 dark:text-zinc-100'}`}>
                  {tx.amount >= 0 ? '+' : ''}{formatCurrency(tx.amount, currency)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Loan Modal (add / edit) ──────────────────────────────────────────────────

function LoanModal({ isOpen, loan, currency, onClose, onSave, onDelete }: {
  isOpen: boolean;
  loan: Loan | null;
  currency: string;
  onClose: () => void;
  onSave: (data: Omit<Loan, 'id' | 'user_id' | 'created_at' | 'updated_at'>) => void;
  onDelete?: () => void;
}) {
  const emptyForm = {
    name: '', loan_type: 'mortgage' as LoanType, lender: '',
    original_amount: '', current_balance: '', interest_rate: '',
    minimum_repayment: '', repayment_frequency: 'monthly' as Loan['repayment_frequency'],
    next_due_date: '', start_date: '', end_date: '', notes: '',
    include_in_net_worth: true, add_to_bills: true,
    // Phase 4.2 — what the projection needs. All optional: a loan without any of
    // it still projects on its balance, rate and repayment alone.
    rate_type: 'variable' as 'variable' | 'fixed', fixed_until: '', revert_rate: '',
    interest_only_until: '', term_months: '',
    offset_balance: '', offset_account_id: '', extra_repayment: '', redraw_available: '',
  };
  const [form, setForm] = useState(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Cash accounts an offset can be linked to, so the offset tracks the real
  // balance instead of a number that goes stale the day it's typed.
  const accounts = useStore(s => s.accounts);

  // Re-seed the form whenever the target loan changes (edit vs add).
  useEffect(() => {
    if (loan) {
      setForm({
        name: loan.name,
        loan_type: loan.loan_type,
        lender: loan.lender ?? '',
        original_amount: String(loan.original_amount ?? ''),
        current_balance: String(loan.current_balance ?? ''),
        interest_rate: loan.interest_rate != null ? String(loan.interest_rate) : '',
        minimum_repayment: loan.minimum_repayment != null ? String(loan.minimum_repayment) : '',
        repayment_frequency: loan.repayment_frequency,
        next_due_date: loan.next_due_date ?? '',
        start_date: loan.start_date ?? '',
        end_date: loan.end_date ?? '',
        notes: loan.notes ?? '',
        include_in_net_worth: loan.include_in_net_worth !== false,
        add_to_bills: loan.add_to_bills !== false,
        rate_type: loan.rate_type === 'fixed' ? 'fixed' : 'variable',
        fixed_until: loan.fixed_until ?? '',
        revert_rate: loan.revert_rate != null ? String(loan.revert_rate) : '',
        interest_only_until: loan.interest_only_until ?? '',
        term_months: loan.term_months != null ? String(loan.term_months) : '',
        offset_balance: loan.offset_balance != null ? String(loan.offset_balance) : '',
        offset_account_id: loan.offset_account_id ?? '',
        extra_repayment: loan.extra_repayment != null ? String(loan.extra_repayment) : '',
        redraw_available: loan.redraw_available != null ? String(loan.redraw_available) : '',
      });
    } else {
      setForm(emptyForm);
    }
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan, isOpen]);

  const isHecs = form.loan_type === 'hecs';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: form.name.trim(),
      loan_type: form.loan_type,
      lender: form.lender.trim() || null,
      original_amount: parseFloat(form.original_amount) || 0,
      current_balance: parseFloat(form.current_balance) || 0,
      interest_rate: isHecs || form.interest_rate === '' ? null : parseFloat(form.interest_rate),
      minimum_repayment: form.minimum_repayment === '' ? null : parseFloat(form.minimum_repayment),
      repayment_frequency: form.repayment_frequency,
      next_due_date: form.next_due_date || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      notes: form.notes.trim() || null,
      include_in_net_worth: form.include_in_net_worth,
      add_to_bills: form.add_to_bills,
      // A fixed period only means anything with a date to expire on, so the
      // revert rate is dropped with it rather than left pointing at nothing.
      rate_type: form.rate_type,
      fixed_until: form.rate_type === 'fixed' && form.fixed_until ? form.fixed_until : null,
      revert_rate: form.rate_type === 'fixed' && form.revert_rate !== '' ? parseFloat(form.revert_rate) : null,
      interest_only_until: form.interest_only_until || null,
      term_months: form.term_months === '' ? null : Math.round(parseFloat(form.term_months) || 0),
      // A linked account supplies the offset live, so the typed figure is cleared
      // rather than left behind to contradict it.
      offset_account_id: form.offset_account_id || null,
      offset_balance: form.offset_account_id ? 0 : (parseFloat(form.offset_balance) || 0),
      extra_repayment: parseFloat(form.extra_repayment) || 0,
      redraw_available: parseFloat(form.redraw_available) || 0,
    });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={loan ? 'Edit loan' : 'Add loan'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Loan name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Home mortgage" required />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Loan type" value={form.loan_type} onChange={e => setForm(f => ({ ...f, loan_type: e.target.value as LoanType }))} options={LOAN_TYPE_OPTIONS} />
          <Input label="Lender" value={form.lender} onChange={e => setForm(f => ({ ...f, lender: e.target.value }))} placeholder={isHecs ? 'e.g. ATO' : 'e.g. CommBank'} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Original amount" type="number" step="0.01" prefix="$" value={form.original_amount} onChange={e => setForm(f => ({ ...f, original_amount: e.target.value }))} required />
          <Input label="Current balance" type="number" step="0.01" prefix="$" value={form.current_balance} onChange={e => setForm(f => ({ ...f, current_balance: e.target.value }))} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {!isHecs && (
            <Input label="Interest rate (% p.a.)" type="number" step="0.001" value={form.interest_rate} onChange={e => setForm(f => ({ ...f, interest_rate: e.target.value }))} placeholder="e.g. 6.25" />
          )}
          <Input label={`Minimum repayment${isHecs ? ' (compulsory)' : ''}`} type="number" step="0.01" prefix="$" value={form.minimum_repayment} onChange={e => setForm(f => ({ ...f, minimum_repayment: e.target.value }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select label="Repayment frequency" value={form.repayment_frequency} onChange={e => setForm(f => ({ ...f, repayment_frequency: e.target.value as Loan['repayment_frequency'] }))} options={LOAN_FREQ_OPTIONS} />
          <Input label="Next due date" type="date" value={form.next_due_date} onChange={e => setForm(f => ({ ...f, next_due_date: e.target.value }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Start date" type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
          <Input label="End date (optional)" type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
        </div>
        {/* ── Phase 4.2 — what the projection needs ──
            Hidden for HECS: an indexed debt has no rate to fix, nothing to
            offset and no redraw. Everything here is optional; a loan without any
            of it still projects on its balance, rate and repayment. */}
        {!isHecs && (
          <div className="space-y-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Rate, offset &amp; extra repayments
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Rate type"
                value={form.rate_type}
                onChange={e => setForm(f => ({ ...f, rate_type: e.target.value as 'variable' | 'fixed' }))}
                options={RATE_TYPE_OPTIONS}
              />
              <Input
                label="Term" type="number" step="1" suffix="mo" value={form.term_months}
                onChange={e => setForm(f => ({ ...f, term_months: e.target.value }))}
                placeholder="e.g. 360" hint="Used when there's no end date"
              />
            </div>
            {form.rate_type === 'fixed' && (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Fixed until" type="date" value={form.fixed_until}
                  onChange={e => setForm(f => ({ ...f, fixed_until: e.target.value }))}
                />
                <Input
                  label="Reverts to (% p.a.)" type="number" step="0.001" value={form.revert_rate}
                  onChange={e => setForm(f => ({ ...f, revert_rate: e.target.value }))}
                  placeholder="e.g. 7.4" hint="The projection switches on that date"
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Interest-only until" type="date" value={form.interest_only_until}
                onChange={e => setForm(f => ({ ...f, interest_only_until: e.target.value }))}
                hint="Blank = principal &amp; interest"
              />
              <Input
                label="Extra repayment" type="number" step="0.01" prefix="$" value={form.extra_repayment}
                onChange={e => setForm(f => ({ ...f, extra_repayment: e.target.value }))}
                hint="Paid on top, every repayment"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Offset account"
                value={form.offset_account_id}
                onChange={e => setForm(f => ({ ...f, offset_account_id: e.target.value }))}
                options={[
                  { value: '', label: 'Not linked' },
                  ...accounts.map(a => ({ value: a.id, label: a.name || a.institution || 'Account' })),
                ]}
              />
              <Input
                label="Offset balance" type="number" step="0.01" prefix="$"
                value={form.offset_account_id ? '' : form.offset_balance}
                onChange={e => setForm(f => ({ ...f, offset_balance: e.target.value }))}
                disabled={!!form.offset_account_id}
                hint={form.offset_account_id ? 'Taken from the linked account' : 'Lowers the interest, not the debt'}
              />
            </div>
            <Input
              label="Redraw available" type="number" step="0.01" prefix="$" value={form.redraw_available}
              onChange={e => setForm(f => ({ ...f, redraw_available: e.target.value }))}
              hint="Extra repayments you could take back. Borrowing capacity, so it isn't counted as savings."
            />
          </div>
        )}
        <Input label="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Anything worth remembering" />
        {isHecs && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            HECS/student debt is indexed annually rather than charged a standard interest rate, so the interest field is hidden.
          </p>
        )}
        <div
          className="flex items-center justify-between gap-3 cursor-pointer select-none"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setForm(f => ({ ...f, include_in_net_worth: !f.include_in_net_worth })); }}
        >
          <div>
            <span className="text-sm text-zinc-900 dark:text-zinc-100">Count toward net worth</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">When on, this loan's balance is subtracted from your net worth.</p>
          </div>
          <div className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${form.include_in_net_worth ? 'bg-brand' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.include_in_net_worth ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </div>
        <div
          className="flex items-center justify-between gap-3 cursor-pointer select-none"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setForm(f => ({ ...f, add_to_bills: !f.add_to_bills })); }}
        >
          <div>
            <span className="text-sm text-zinc-900 dark:text-zinc-100">Add repayment to bills &amp; reminders</span>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Mirrors the repayment into Bills &amp; the Telegram briefing (needs a min. repayment and next due date).</p>
          </div>
          <div className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${form.add_to_bills ? 'bg-brand' : 'bg-zinc-300 dark:bg-zinc-600'}`}>
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.add_to_bills ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </div>
        {form.minimum_repayment !== '' && form.next_due_date && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            A "{form.name || 'loan'} repayment" bill of {formatCurrency(parseFloat(form.minimum_repayment) || 0, currency)} will appear in Bills &amp; Reminders.
          </p>
        )}
        {confirmDelete ? (
          <div className="flex items-center gap-3 pt-2 rounded-lg bg-[#ef4444]/5 p-3">
            <span className="flex-1 text-xs text-zinc-500 dark:text-zinc-400">
              Delete this loan{form.add_to_bills ? ' and its repayment bill' : ''}? This can't be undone.
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
            <Button variant="primary" type="submit" fullWidth>{loan ? 'Save changes' : 'Add loan'}</Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ─── Phase 4.2 — the engine on screen ─────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`text-sm font-semibold amount ${tone === 'good' ? 'text-[#22c55e]' : tone === 'bad' ? 'text-[#ef4444]' : ''}`}>
        {value}
      </p>
    </div>
  );
}

/**
 * What the loan is going to do: when it clears, what it costs to get there, and
 * what paying a little more would change.
 *
 * Every number is the engine's — the panel holds no arithmetic of its own, which
 * is what keeps it honest about a loan whose repayment doesn't cover the interest.
 */
function LoanProjectionPanel({ row, currency }: { row: LoanRow; currency: string }) {
  const [extra, setExtra] = useState('');
  const extraAmount = parseFloat(extra) || 0;

  // What the loan can actually use. Past that ceiling it is paid out at the
  // first repayment, so the impact below is priced on the useful part only —
  // quoting a saving for money the loan can't absorb would be a fiction.
  const scenario = useMemo(
    () => (extraAmount > 0 ? loansDS.extraScenario(row.id, extraAmount) : null),
    [row.id, extraAmount],
  );
  const testedExtra = scenario?.exceedsPayoff ? scenario.maxUsefulExtra : extraAmount;

  const impact: RepaymentImpact | null = useMemo(
    () => (testedExtra > 0 ? loansDS.impact(row.id, { extraPerPeriod: testedExtra }) : null),
    [row.id, testedExtra],
  );

  return (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900/50 p-3 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label="Paid off"
          value={row.projection.neverPaysOff ? 'Never' : row.payoffDate ? formatDate(row.payoffDate) : '—'}
          tone={row.projection.neverPaysOff ? 'bad' : undefined}
        />
        <Stat label="Term left" value={formatTerm(row.monthsToPayoff)} />
        <Stat
          label="Interest to come"
          value={row.projection.neverPaysOff ? '—' : formatCurrency(row.projection.totalInterest, currency)}
        />
        <Stat label="Interest / yr" value={formatCurrency(row.interestPerYear, currency)} />
      </div>

      {row.projection.neverPaysOff && (
        <p className="text-xs text-[#ef4444]">
          The repayment is {formatCurrency(row.projection.shortfall, currency)} short of the interest each{' '}
          {row.frequency === 'monthly' ? 'month' : row.frequency === 'weekly' ? 'week' : 'fortnight'}, so the balance
          grows instead of falling. There is no payoff date until the repayment covers the interest.
        </p>
      )}

      {row.offsetBalance > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatCurrency(row.offsetBalance, currency)} offsetting saves{' '}
          {formatCurrency(row.offsetSavingPerYear, currency)} of interest a year. That cash still counts as savings —
          it lowers the interest, not the debt. It isn't redraw either: the money is yours, in your account.
        </p>
      )}

      {row.redrawAvailable > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatCurrency(row.redrawAvailable, currency)} available to redraw. Redrawing is re-borrowing, so it isn't
          counted as money you have.
        </p>
      )}

      {row.interestOnly && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Interest-only until {formatDate(row.interestOnlyUntil!)} — nothing comes off the principal before then.
          {row.repaymentAfterInterestOnly != null && (
            <> The repayment then rises to about {formatCurrency(row.repaymentAfterInterestOnly, currency)} to clear
              it in the remaining term.</>
          )}
        </p>
      )}

      {row.rateType === 'fixed' && row.fixedUntil && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Fixed at {row.rate}% until {formatDate(row.fixedUntil)}
          {row.revertRate != null ? <>, then {row.revertRate}% — the projection above already assumes it.</> : '.'}
        </p>
      )}

      {row.upcomingRateChanges.length > 0 && row.rateType !== 'fixed' && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Rate change{row.upcomingRateChanges.length !== 1 ? 's' : ''} ahead:{' '}
          {row.upcomingRateChanges.map(s => `${s.rate}% from ${formatDate(s.from)}`).join(', ')}.
        </p>
      )}

      {row.property && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          🏠 This is the mortgage on {row.property.name} — the same loan the property links to, so the debt is only
          counted once.
        </p>
      )}

      {/* What if I paid more? Priced by the same amortisation as the schedule
          above, so the two can't disagree. */}
      <div className="pt-1">
        <Input
          label="What if I paid extra each repayment?"
          type="number"
          step="0.01"
          prefix="$"
          value={extra}
          onChange={e => setExtra(e.target.value)}
          placeholder="e.g. 200"
          hint={impact && !impact.comparable
            ? "At that repayment the interest still isn't covered, so there's nothing to compare."
            : undefined}
        />
        {/* More than the loan has left to pay. Said before any saving is quoted,
            with both figures that bound it: what pays the loan out today, and
            the most extra that can still change the schedule. */}
        {scenario?.exceedsPayoff && (
          <div className="mt-2 rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-3 space-y-2 text-xs">
            {scenario.alreadyCleared ? (
              <p className="text-zinc-700 dark:text-zinc-200">
                {formatCurrency(scenario.payoffAmount, currency)} pays this loan out today, and the{' '}
                {formatCurrency(scenario.committedPerPeriod, currency)} already going in each repayment covers
                it — so extra on top has nothing left to pay off.
              </p>
            ) : (
              <>
                <p className="text-zinc-700 dark:text-zinc-200">
                  That's {formatCurrency(scenario.excess, currency)} more than this loan needs.{' '}
                  {formatCurrency(scenario.payoffAmount, currency)} pays it out today — the balance plus this
                  period's interest — and {formatCurrency(scenario.committedPerPeriod, currency)} of that is
                  already being paid each period, so the most extra that changes anything is{' '}
                  {formatCurrency(scenario.maxUsefulExtra, currency)}.
                </p>
                <button
                  type="button"
                  className="text-brand hover:underline"
                  onClick={() => setExtra(String(scenario.maxUsefulExtra))}
                >
                  Use {formatCurrency(scenario.maxUsefulExtra, currency)} instead
                </button>
              </>
            )}
          </div>
        )}
        {impact?.comparable && (
          <p className="text-xs text-[#22c55e] mt-1">
            {scenario?.exceedsPayoff
              ? `${formatCurrency(scenario.maxUsefulExtra, currency)} extra saves `
              : 'Saves '}
            {formatCurrency(impact.interestSaved, currency)} of interest and{' '}
            {formatTerm(impact.monthsSaved ?? 0)} — paid off {formatDate(impact.scenario.payoffDate!)} instead of{' '}
            {formatDate(impact.baseline.payoffDate!)}.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Extra repayments, redraws and rate changes.
 *
 * Each action writes the balance change AND its history row together, so the
 * audit trail can never describe a movement that didn't happen (or miss one that
 * did). Forgetting a row later removes the RECORD, never its effect.
 */
function LoanMovements({ row, currency, onChanged }: {
  row: LoanRow;
  currency: string;
  onChanged: () => void;
}) {
  const [action, setAction] = useState<'extra_repayment' | 'redraw' | 'rate_change' | null>(null);
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [errors, setErrors] = useState<string[]>([]);
  // Set once the user has been told the amount overshoots. Cleared the moment
  // they change it, so a confirmation can only ever apply to the figure it was
  // shown for.
  const [confirmedOverpayment, setConfirmedOverpayment] = useState(false);

  const reset = () => {
    setAction(null); setAmount(''); setRate(''); setErrors([]); setConfirmedOverpayment(false);
  };

  const draft = {
    kind: action ?? 'extra_repayment',
    amount: parseFloat(amount) || 0,
    rate: rate === '' ? null : parseFloat(rate),
    date,
  };
  const check = loansDS.checkMovement(row.id, draft);
  // Only an extra repayment can overshoot and still be recorded — a redraw past
  // what is available is a hard error, because that limit is the lender's.
  const overpaying = action === 'extra_repayment' && check.excess > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!action) return;
    if (check.errors.length) { setErrors(check.errors); return; }
    // First submit on an overshooting amount only warns; the second one records
    // the capped figure. Nothing is written until the user has seen the excess.
    if (check.requiresConfirmation && !confirmedOverpayment) {
      setErrors([]);
      setConfirmedOverpayment(true);
      return;
    }

    if (action === 'extra_repayment') loansDS.recordExtraRepayment(row.id, draft.amount, { date });
    else if (action === 'redraw') loansDS.recordRedraw(row.id, draft.amount, { date });
    else loansDS.recordRateChange(row.id, draft.rate!, { date });

    onChanged();
    reset();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-medium">Movements ({row.events.length})</h3>
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="text-brand hover:underline" onClick={() => setAction('extra_repayment')}>Pay extra</button>
          {row.redrawAvailable > 0 ? (
            <button type="button" className="text-brand hover:underline" onClick={() => setAction('redraw')}>
              Redraw
            </button>
          ) : (
            // Nothing has been paid ahead, so there is nothing to take back. An
            // offset balance sitting against this loan is NOT redraw: that cash
            // is the user's own money in their account, not a repayment the
            // lender is holding, so it can't be borrowed back from here.
            <span
              className="text-zinc-400 dark:text-zinc-500 cursor-help"
              title="Redraw is money you've already paid off this loan. An offset balance isn't redraw — that cash is still your own, sitting in your account."
            >
              No redraw available
            </span>
          )}
          <button type="button" className="text-brand hover:underline" onClick={() => setAction('rate_change')}>Rate change</button>
        </div>
      </div>

      {action && (
        <form onSubmit={submit} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {action === 'rate_change' ? (
              <Input
                label="New rate (% p.a.)" type="number" step="0.001" value={rate}
                onChange={e => setRate(e.target.value)} placeholder="e.g. 6.55" required
                hint="Dated ahead? It's recorded and used in the projection, not charged yet."
              />
            ) : (
              <Input
                label="Amount" type="number" step="0.01" prefix="$" value={amount}
                onChange={e => { setAmount(e.target.value); setConfirmedOverpayment(false); }} required
                hint={action === 'redraw'
                  ? `${formatCurrency(row.redrawAvailable, currency)} available`
                  : `${formatCurrency(row.balance, currency)} owing`}
              />
            )}
            <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} required />
          </div>
          {errors.length > 0 && (
            <ul className="text-xs text-[#ef4444] space-y-0.5">
              {errors.map(err => <li key={err}>{err}</li>)}
            </ul>
          )}
          {/* More than the balance owing. Said out loud, with the two ways out:
              correct the amount, or confirm and pay the loan out. */}
          {overpaying && (
            <div className="rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-3 space-y-2 text-xs">
              <p className="text-zinc-700 dark:text-zinc-200">
                That's {formatCurrency(check.excess, currency)} more than the {formatCurrency(row.balance, currency)}{' '}
                owing. Only {formatCurrency(check.maxApplicable, currency)} would come off the loan — the rest
                isn't a debt, so it can't be paid or redrawn later.
              </p>
              <button
                type="button"
                className="text-brand hover:underline"
                onClick={() => { setAmount(String(check.maxApplicable)); setConfirmedOverpayment(false); }}
              >
                Use {formatCurrency(check.maxApplicable, currency)} instead
              </button>
              {confirmedOverpayment && (
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  Confirm below to pay the loan out with {formatCurrency(check.maxApplicable, currency)}.
                </p>
              )}
            </div>
          )}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {action === 'extra_repayment' && 'Reduces the balance and becomes available to redraw later.'}
            {action === 'redraw' && 'Takes money back out — this is re-borrowing, so the balance goes back up.'}
            {action === 'rate_change' && 'A rate change from today applies now; a future one only shows in the projection.'}
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" type="button" onClick={reset}>Cancel</Button>
            <Button variant="primary" type="submit" fullWidth>
              {overpaying && confirmedOverpayment
                ? `Pay out ${formatCurrency(check.maxApplicable, currency)}`
                : action === 'extra_repayment' ? 'Record extra repayment'
                  : action === 'redraw' ? 'Record redraw' : 'Record rate change'}
            </Button>
          </div>
        </form>
      )}

      {row.events.length > 0 && (
        <div className="max-h-48 overflow-y-auto -mx-1">
          {row.events.map(ev => (
            <div key={ev.id} className="flex items-center justify-between gap-3 px-1 py-2 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
              <div className="min-w-0">
                <p className="text-sm truncate">{MOVEMENT_LABELS[ev.kind]}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatDate(ev.date)}{ev.note ? ` · ${ev.note}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <p className={`text-sm amount ${ev.kind === 'redraw' ? 'text-[#ef4444]' : ''}`}>
                  {ev.kind === 'rate_change' ? `${ev.rate}%` : formatCurrency(ev.amount, currency)}
                </p>
                <button
                  type="button"
                  className="text-xs text-zinc-400 hover:text-[#ef4444]"
                  title="Forget this record — the balance it changed stays as it is"
                  onClick={() => { loanEventsDS.remove(ev.id); onChanged(); }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Record a repayment.
 *
 * The amount is editable because a real repayment isn't always the scheduled
 * one: a partial payment pays what it can and leaves the period owing, and
 * anything above the schedule becomes redrawable. The split shown here is the
 * engine's, so the confirmation says exactly what the loan is about to do.
 */
function RecordRepaymentModal({ loan, offset, currency, onClose, onConfirm }: {
  loan: Loan | null;
  offset: number;
  currency: string;
  onClose: () => void;
  onConfirm: (amount: number) => void;
}) {
  const [amount, setAmount] = useState('');
  // Cleared whenever the amount changes: a confirmation belongs to the figure
  // the user was warned about, never to a later one.
  const [confirmedOverpayment, setConfirmedOverpayment] = useState(false);

  useEffect(() => {
    setAmount(loan?.minimum_repayment != null ? String(loan.minimum_repayment) : '');
    setConfirmedOverpayment(false);
  }, [loan]);

  if (!loan) return null;
  const paid = parseFloat(amount) || 0;
  const withOffset = { ...loan, offset_balance: offset };
  const split = applyRepayment(withOffset, paid);
  // What clearing this loan today actually costs — the balance plus the period's
  // interest. Anything above it has nothing left to pay.
  const check = checkMovement({ kind: 'repayment', amount: paid, date: new Date().toISOString().slice(0, 10) }, withOffset);
  const overpaying = check.excess > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // An overpayment is never recorded on the first press: the user has to see
    // by how much it overshoots, then either correct it or say yes. Confirming
    // records the payoff figure — the debt stops at zero, it never goes past it.
    if (overpaying && !confirmedOverpayment) { setConfirmedOverpayment(true); return; }
    onConfirm(overpaying ? check.maxApplicable : paid);
  };

  return (
    <Modal isOpen={!!loan} onClose={onClose} title="Record repayment" size="sm">
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Recording a repayment on <span className="font-medium text-zinc-900 dark:text-zinc-100">{loan.name}</span>.
        </p>
        <Input
          label="Amount paid" type="number" step="0.01" prefix="$" value={amount}
          onChange={e => { setAmount(e.target.value); setConfirmedOverpayment(false); }} required
          hint={loan.minimum_repayment ? `Scheduled: ${formatCurrency(loan.minimum_repayment, currency)}` : undefined}
        />
        {overpaying && (
          <div className="rounded-lg border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-3 space-y-2 text-xs">
            <p className="text-zinc-700 dark:text-zinc-200">
              That's {formatCurrency(check.excess, currency)} more than this loan is worth. Paying it out today costs{' '}
              {formatCurrency(check.maxApplicable, currency)} — {formatCurrency(loan.current_balance, currency)} owing
              plus {formatCurrency(split.interest, currency)} interest for the period. Only that much can be applied;
              the balance stops at zero.
            </p>
            <button
              type="button"
              className="text-brand hover:underline"
              onClick={() => { setAmount(String(check.maxApplicable)); setConfirmedOverpayment(false); }}
            >
              Use {formatCurrency(check.maxApplicable, currency)} instead
            </button>
            {confirmedOverpayment && (
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                Confirm below to pay the loan out. {formatCurrency(check.excess, currency)} won't be recorded.
              </p>
            )}
          </div>
        )}
        <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900/50 p-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <p>
            {formatCurrency(split.interest, currency)} interest, {formatCurrency(split.principal, currency)} off the
            balance{offset > 0 ? ` (interest charged on ${formatCurrency(Math.max(0, loan.current_balance - offset), currency)} after the offset)` : ''}.
          </p>
          <p>Balance becomes {formatCurrency(split.current_balance, currency)}.</p>
          {split.surplus > 0 && !overpaying && (
            <p>{formatCurrency(split.surplus, currency)} above the schedule becomes available to redraw.</p>
          )}
          {loan.next_due_date && (
            <p>
              {split.meetsSchedule
                ? `The next due date moves on one ${loan.repayment_frequency} period.`
                : `This is less than the scheduled repayment, so ${formatDate(loan.next_due_date)} stays owing.`}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>
            {overpaying && confirmedOverpayment
              ? `Pay out ${formatCurrency(check.maxApplicable, currency)}`
              : 'Confirm'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
