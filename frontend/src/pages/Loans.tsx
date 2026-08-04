import { useState, useEffect } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { loansDS, transactionsDS, parseDocument } from '../services/dataService';
import { formatCurrency, formatDate, daysUntil, autoCategory } from '../utils/format';
import type { Loan, LoanType, Transaction } from '../types';
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

export default function Loans() {
  const { user, loans, setLoans, transactions } = useStore();
  const currency = user?.currency_preference ?? 'AUD';

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
        transactions={detailLoan ? loanTransactions(detailLoan) : []}
        currency={currency}
        onClose={() => setDetailLoan(null)}
        onEdit={() => { const l = detailLoan; setDetailLoan(null); setEditLoan(l); }}
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

      <Modal isOpen={!!markPaidLoan} onClose={() => setMarkPaidLoan(null)} title="Record repayment?" size="sm">
        {markPaidLoan && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Mark this repayment as paid for <span className="font-medium text-zinc-900 dark:text-zinc-100">{markPaidLoan.name}</span>?
              This subtracts {formatCurrency(markPaidLoan.minimum_repayment ?? 0, currency)} from the balance
              {markPaidLoan.next_due_date && <> and advances the next due date by one {markPaidLoan.repayment_frequency} period</>}.
            </p>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setMarkPaidLoan(null)}>Cancel</Button>
              <Button variant="primary" fullWidth onClick={() => {
                loansDS.markPaid(markPaidLoan.id);
                setLoans(loansDS.getAll());
                setMarkPaidLoan(null);
              }}>Confirm</Button>
            </div>
          </div>
        )}
      </Modal>
    </Layout>
  );
}

// ─── Loan Detail (transactions) ───────────────────────────────────────────────

function LoanDetailModal({ loan, transactions, currency, onClose, onEdit }: {
  loan: Loan | null;
  transactions: Transaction[];
  currency: string;
  onClose: () => void;
  onEdit: () => void;
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
    for (const tx of rows) {
      // A repayment (credit) reduces the debt → store positive, matching how
      // Basiq repayments are held; interest/fees (debit) → negative.
      const normalizedAmt = tx.type === 'credit' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      const isDup = transactions.some(ex =>
        ex.date === tx.date && Math.abs(ex.amount - normalizedAmt) < 0.01,
      );
      if (isDup) continue;
      transactionsDS.add({
        account_id: loan.id, account_type: 'loan', date: tx.date, merchant: tx.merchant,
        amount: normalizedAmt, currency, category: autoCategory(tx.merchant),
        is_duplicate_flagged: false, is_subscription: false,
      });
      added++;
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
  };
  const [form, setForm] = useState(emptyForm);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
