/**
 * The one real "add a bank account manually" form — used by the Accounts page
 * and by first-run onboarding. Extracted from Accounts.tsx unchanged so both
 * entry points share exactly one form, one statement-upload parser and one
 * write path (accountsDS + transactionsDS.ingest).
 */
import { useState } from 'react';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Input, { Select } from '../common/Input';
import { accountsDS, transactionsDS, parseDocument } from '../../services/dataService';
import { autoCategory } from '../../utils/format';
import type { BankAccount } from '../../types';

export const ACCOUNT_TYPES = [
  { value: 'Everyday', label: 'Everyday' },
  { value: 'Savings', label: 'Savings' },
  { value: 'Offset', label: 'Offset' },
  { value: 'High Yield Savings', label: 'High Yield Savings' },
  { value: 'Transaction', label: 'Transaction' },
  { value: 'Joint', label: 'Joint' },
  { value: 'Term Deposit', label: 'Term Deposit' },
  { value: 'Foreign Currency', label: 'Foreign Currency' },
  { value: 'Business', label: 'Business' },
  { value: 'Other', label: 'Other' },
];

export interface ParsedBankTx { date: string; merchant: string; amount: number; type?: string; }

/**
 * Ensure an account's display name is the product/account type, not the holder's
 * personal name. Statement parsers sometimes return "HARRY JAMES CAMERON" as the
 * account name — when the value looks like a person's name (or is empty) fall back
 * to "<institution> <account_type>".
 */
export function sanitizeAccountName(
  rawName: string,
  institution: string,
  accountType: string,
  accountNumber?: string,
): string {
  const name = (rawName ?? '').trim();
  const at = (accountType ?? '').trim();
  const inst = (institution ?? '').trim();
  const num = (accountNumber ?? '').replace(/\s/g, '');

  // Priority fallback chain:
  //  1. institution + account type (e.g. "CommBank Smart Access")
  //  2. "Account XXXX" using last 4 digits of account number
  //  3. institution alone
  const instAt = inst && at ? `${inst} ${at}` : (at || '');
  const last4 = num.length >= 4 ? `Account ${num.slice(-4)}` : '';
  const fallback = instAt || last4 || inst;

  // Looks like a person's name: 2+ all-caps/title words, letters only (no digits,
  // no product keywords like "Access", "Account", "Savings", "Everyday").
  const productKeywords = /(access|account|saver|savings|everyday|spend|transaction|offset|complete|streamline|orange|smart|cheque|checking|debit)/i;
  const looksLikePerson =
    !!name &&
    !/\d/.test(name) &&
    name.split(/\s+/).length >= 2 &&
    !productKeywords.test(name) &&
    name === name.toUpperCase();

  if ((!name || looksLikePerson) && fallback) return fallback;
  return name;
}

export default function AddAccountModal({ isOpen, onClose, onSave }: {
  isOpen: boolean; onClose: () => void;
  onSave: (formData: { name: string; institution: string; bsb?: string; account_number?: string }, doAdd: (existing?: BankAccount) => void) => void;
}) {
  const [form, setForm] = useState({ name: '', institution: '', account_type: 'Everyday', balance: '', currency: 'AUD', bsb: '', account_number: '' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [parsedTransactions, setParsedTransactions] = useState<ParsedBankTx[]>([]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg(''); setParsedTransactions([]);
    const { parsed, error } = await parseDocument(file, 'bank_statement');
    setUploading(false);
    if (error) { setUploadMsg(error); return; }
    if (parsed?.accounts && Array.isArray(parsed.accounts) && parsed.accounts[0]) {
      const acc = parsed.accounts[0] as Record<string, unknown>;
      const institution = String(acc.institution ?? '');
      const accountType = String(acc.account_type ?? '');
      const accountNumber = String(acc.account_number ?? '');
      const cleanName = sanitizeAccountName(
        acc.name != null ? String(acc.name) : '',
        institution,
        accountType,
        accountNumber,
      );
      setForm(f => ({
        ...f,
        name:           cleanName || String(acc.name ?? f.name),
        institution:    String(acc.institution ?? f.institution),
        account_type:   String(acc.account_type ?? f.account_type),
        balance:        String(acc.balance ?? f.balance),
        currency:       String(acc.currency ?? f.currency),
        bsb:            String(acc.bsb ?? f.bsb),
        account_number: String(acc.account_number ?? f.account_number),
      }));
      const txns = (acc.transactions as ParsedBankTx[]) ?? [];
      setParsedTransactions(txns);
      const txMsg = txns.length ? ` · ${txns.length} transaction${txns.length !== 1 ? 's' : ''} detected` : '';
      setUploadMsg(`Document parsed${txMsg} — please review the details below.`);
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formSnapshot = { name: form.name, institution: form.institution, bsb: form.bsb || undefined, account_number: form.account_number || undefined };
    const capturedForm = { ...form };
    const capturedTxns = [...parsedTransactions];
    const doAdd = (existing?: BankAccount) => {
      // When the account already exists, import the parsed transactions INTO it
      // instead of creating a second account instance. Creating duplicate accounts
      // is what historically spawned orphan transactions (transactions tied to an
      // account instance that later gets deleted/deduped).
      const acc = existing ?? accountsDS.add({
        name: capturedForm.name, institution: capturedForm.institution, account_type: capturedForm.account_type,
        balance: parseFloat(capturedForm.balance) || 0, currency: capturedForm.currency,
        bsb: capturedForm.bsb || undefined, account_number: capturedForm.account_number || undefined,
        is_manual: true,
      });
      if (capturedTxns.length) {
        const batchState = new Map<string, number>();
        for (const tx of capturedTxns) {
          const normalizedAmt = tx.type === 'credit' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
          // Canonical ingestion: content_hash (user+account+date+signed-cents+
          // normalised merchant) recognises a re-imported statement line while
          // still letting two genuinely-distinct same-value purchases coexist.
          transactionsDS.ingest({
            account_id: acc.id, account_type: 'bank', date: tx.date, merchant: tx.merchant,
            raw_description: tx.merchant,
            amount: normalizedAmt, currency: acc.currency, category: autoCategory(tx.merchant),
            category_source: 'auto',
            is_duplicate_flagged: false, is_subscription: false,
            source: 'statement',
          }, { batchState });
        }
      }
    };
    setForm({ name: '', institution: '', account_type: 'Everyday', balance: '', currency: 'AUD', bsb: '', account_number: '' });
    setUploadMsg('');
    setParsedTransactions([]);
    onSave(formSnapshot, doAdd);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Bank Account">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-zinc-200 dark:border-zinc-800 hover:border-brand/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{uploading ? 'Reading document…' : 'Upload statement (PDF / image) to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('requires') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>
          {uploadMsg}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Account name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. CommBank Everyday" required />
        <Input label="Institution" value={form.institution} onChange={e => setForm(f => ({ ...f, institution: e.target.value }))} placeholder="e.g. CommBank" required />
        <Select label="Account type" value={form.account_type} onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))} options={ACCOUNT_TYPES} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Balance" type="number" step="0.01" prefix="$" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} required />
          <Input label="Currency" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="BSB (optional)" value={form.bsb} onChange={e => setForm(f => ({ ...f, bsb: e.target.value }))} placeholder="012-345" />
          <Input label="Account number" value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Account</Button>
        </div>
      </form>
    </Modal>
  );
}
