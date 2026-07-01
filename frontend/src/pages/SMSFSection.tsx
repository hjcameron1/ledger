import { useState, useEffect, useCallback } from 'react';
import { smsfApi } from '../services/api';
import { formatCurrency } from '../utils/format';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';

// ── Types (shape returned by GET /api/smsf) ───────────────────────────────────
interface Fund {
  id: string; name: string; abn: string | null;
  trustee_type: 'individual' | 'corporate';
  is_audited: boolean; last_audited_on: string | null; audit_due_on: string | null;
  include_in_net_worth?: boolean;
}
interface Member {
  id: string; fund_id: string; full_name: string;
  balance: number; total_super_balance: number | null;
  concessional_used: number; non_concessional_used: number;
  concessional_cap: number; non_concessional_cap: number;
}
interface Asset { id: string; fund_id: string; asset_type: string; label: string; amount: number; }
interface Contribution {
  id: string; member_id: string; contribution_type: 'concessional' | 'non_concessional';
  amount: number; contributed_on: string; financial_year: string;
}
interface SmsfData {
  financial_year: string;
  funds: Fund[]; members: Member[]; assets: Asset[]; contributions: Contribution[];
}

const ASSET_TYPES = ['Cash', 'Australian Shares', 'International Shares', 'Property', 'Fixed Interest', 'Managed Fund', 'Crypto', 'Collectible', 'Other'];

export default function SMSFSection({ currency }: { currency: string }) {
  const [data, setData] = useState<SmsfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fundModal, setFundModal] = useState<Fund | 'new' | null>(null);
  const [memberModal, setMemberModal] = useState<string | null>(null);   // fund_id
  const [assetModal, setAssetModal] = useState<string | null>(null);     // fund_id
  const [contribModal, setContribModal] = useState<Member | null>(null);

  const reload = useCallback(async () => {
    try { setData(await smsfApi.getAll()); }
    catch { /* leave previous data */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  if (loading) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading SMSF…</p>;
  if (!data) return <p className="text-sm text-[#ef4444]">Could not load SMSF data.</p>;

  const fy = data.financial_year;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Self-Managed Super Funds</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Caps shown for financial year {fy}</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setFundModal('new')}>+ Add Fund</Button>
      </div>

      {data.funds.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <h3 className="font-medium mb-1">No SMSF added</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Add your self-managed super fund to track members, assets and contributions.</p>
            <Button variant="secondary" size="sm" onClick={() => setFundModal('new')}>+ Add Fund</Button>
          </div>
        </Card>
      ) : data.funds.map(fund => {
        const fundAssets = data.assets.filter(a => a.fund_id === fund.id);
        const fundMembers = data.members.filter(m => m.fund_id === fund.id);
        const assetTotal = fundAssets.reduce((s, a) => s + Number(a.amount), 0);
        const auditDays = fund.audit_due_on
          ? Math.ceil((new Date(fund.audit_due_on).getTime() - Date.now()) / 86_400_000)
          : null;

        return (
          <Card key={fund.id}>
            {/* Fund header */}
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-medium">{fund.name}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {fund.trustee_type === 'corporate' ? 'Corporate trustee' : 'Individual trustee'}
                  {fund.abn ? ` · ABN ${fund.abn}` : ''}
                </p>
                {fund.audit_due_on && (
                  <p className={`text-xs mt-1 ${auditDays !== null && auditDays <= 30 ? 'text-[#f59e0b]' : 'text-zinc-500 dark:text-zinc-400'}`}>
                    Audit due {new Date(fund.audit_due_on).toLocaleDateString()}
                    {auditDays !== null && (auditDays < 0 ? ` (overdue ${Math.abs(auditDays)}d)` : ` (${auditDays}d)`)}
                    {fund.is_audited ? ' · audited' : ' · not yet audited'}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Total assets</p>
                <p className="text-lg font-semibold amount">{formatCurrency(assetTotal, currency)}</p>
                <div className="flex gap-2 justify-end mt-1">
                  <button onClick={() => setFundModal(fund)} className="text-xs text-brand">Edit</button>
                  <button onClick={async () => { await smsfApi.deleteFund(fund.id); reload(); }} className="text-xs text-zinc-500 hover:text-[#ef4444]">Remove</button>
                </div>
                <div className="flex items-center gap-2 justify-end mt-2">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">In net worth</span>
                  <Toggle
                    checked={fund.include_in_net_worth !== false}
                    onChange={async (v) => { await smsfApi.updateFund(fund.id, { include_in_net_worth: v }); reload(); }}
                  />
                </div>
              </div>
            </div>

            {/* Assets */}
            <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Assets</p>
                <button onClick={() => setAssetModal(fund.id)} className="text-xs text-brand">+ Add asset</button>
              </div>
              {fundAssets.length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">No assets recorded.</p>
              ) : (
                <div className="space-y-1">
                  {fundAssets.map(a => (
                    <div key={a.id} className="flex items-center justify-between text-sm">
                      <span>{a.label} <span className="text-xs text-zinc-500 dark:text-zinc-400">· {a.asset_type}</span></span>
                      <span className="flex items-center gap-2">
                        <span className="amount font-medium">{formatCurrency(a.amount, currency)}</span>
                        <button onClick={async () => { await smsfApi.deleteAsset(a.id); reload(); }} className="text-xs text-zinc-500 hover:text-[#ef4444]">×</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Members */}
            <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Members</p>
                <button onClick={() => setMemberModal(fund.id)} className="text-xs text-brand">+ Add member</button>
              </div>
              {fundMembers.length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">No members added.</p>
              ) : (
                <div className="space-y-4">
                  {fundMembers.map(m => (
                    <div key={m.id} className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 p-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-medium">{m.full_name}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            Balance {formatCurrency(m.balance, currency)}
                            {m.total_super_balance != null ? ` · TSB ${formatCurrency(m.total_super_balance, currency)}` : ''}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setContribModal(m)} className="text-xs text-brand">+ Contribution</button>
                          <button onClick={async () => { await smsfApi.deleteMember(m.id); reload(); }} className="text-xs text-zinc-500 hover:text-[#ef4444]">Remove</button>
                        </div>
                      </div>
                      <CapBar label="Concessional" used={m.concessional_used} cap={m.concessional_cap} currency={currency} />
                      <CapBar label="Non-concessional" used={m.non_concessional_used} cap={m.non_concessional_cap} currency={currency} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        );
      })}

      {fundModal && (
        <FundModal
          fund={fundModal === 'new' ? null : fundModal}
          onClose={() => setFundModal(null)}
          onSaved={() => { setFundModal(null); reload(); }}
        />
      )}
      {memberModal && (
        <MemberModal fundId={memberModal} onClose={() => setMemberModal(null)} onSaved={() => { setMemberModal(null); reload(); }} />
      )}
      {assetModal && (
        <AssetModal fundId={assetModal} onClose={() => setAssetModal(null)} onSaved={() => { setAssetModal(null); reload(); }} />
      )}
      {contribModal && (
        <ContributionModal member={contribModal} fy={fy} onClose={() => setContribModal(null)} onSaved={() => { setContribModal(null); reload(); }} />
      )}
    </div>
  );
}

// ── Cap progress bar with approaching/over-limit warning ──────────────────────
function CapBar({ label, used, cap, currency }: { label: string; used: number; cap: number; currency: string }) {
  const pct = cap > 0 ? (used / cap) * 100 : 0;
  const over = used > cap && cap > 0;
  const near = !over && pct >= 85;
  const color = over ? 'bg-[#ef4444]' : near ? 'bg-[#f59e0b]' : 'bg-brand';
  const textColor = over ? 'text-[#ef4444]' : near ? 'text-[#f59e0b]' : 'text-zinc-500 dark:text-zinc-400';
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
        <span className={`${textColor} font-medium`}>
          {formatCurrency(used, currency)} / {formatCurrency(cap, currency)}
          {over ? ' · over cap!' : near ? ' · approaching cap' : ''}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

// ── Fund modal (add/edit) ─────────────────────────────────────────────────────
function FundModal({ fund, onClose, onSaved }: { fund: Fund | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: fund?.name ?? '',
    abn: fund?.abn ?? '',
    trustee_type: fund?.trustee_type ?? 'individual',
    is_audited: fund?.is_audited ?? false,
    last_audited_on: fund?.last_audited_on ?? '',
    audit_due_on: fund?.audit_due_on ?? '',
  });
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const payload = {
      ...form,
      abn: form.abn || null,
      last_audited_on: form.last_audited_on || null,
      audit_due_on: form.audit_due_on || null,
    };
    try {
      if (fund) await smsfApi.updateFund(fund.id, payload);
      else await smsfApi.createFund(payload);
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={fund ? 'Edit Fund' : 'Add SMSF'}>
      <form onSubmit={submit} className="space-y-4">
        <Input label="Fund name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Smith Family Super Fund" required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="ABN (optional)" value={form.abn} onChange={e => setForm(f => ({ ...f, abn: e.target.value }))} placeholder="11 digits" />
          <Select label="Trustee type" value={form.trustee_type}
            onChange={e => setForm(f => ({ ...f, trustee_type: e.target.value as 'individual' | 'corporate' }))}
            options={[{ value: 'individual', label: 'Individual' }, { value: 'corporate', label: 'Corporate' }]} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Last audited on" type="date" value={form.last_audited_on} onChange={e => setForm(f => ({ ...f, last_audited_on: e.target.value }))} />
          <Input label="Audit due on" type="date" value={form.audit_due_on} onChange={e => setForm(f => ({ ...f, audit_due_on: e.target.value }))} />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={form.is_audited} onChange={e => setForm(f => ({ ...f, is_audited: e.target.checked }))} />
          This year's audit is complete
        </label>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth disabled={saving}>{saving ? 'Saving…' : fund ? 'Save Changes' : 'Add Fund'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Member modal ──────────────────────────────────────────────────────────────
function MemberModal({ fundId, onClose, onSaved }: { fundId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ full_name: '', balance: '', total_super_balance: '' });
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await smsfApi.createMember({
        fund_id: fundId,
        full_name: form.full_name,
        balance: parseFloat(form.balance) || 0,
        total_super_balance: form.total_super_balance ? parseFloat(form.total_super_balance) : null,
      });
      onSaved();
    } finally { setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Add Member">
      <form onSubmit={submit} className="space-y-4">
        <Input label="Full name" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} required />
        <Input label="Balance in fund" type="number" step="0.01" prefix="$" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} required />
        <Input label="Total super balance (optional)" type="number" step="0.01" prefix="$" value={form.total_super_balance} onChange={e => setForm(f => ({ ...f, total_super_balance: e.target.value }))} hint="Across all super, used for contribution eligibility" />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth disabled={saving}>{saving ? 'Saving…' : 'Add Member'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Asset modal ───────────────────────────────────────────────────────────────
function AssetModal({ fundId, onClose, onSaved }: { fundId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ asset_type: ASSET_TYPES[0], label: '', amount: '' });
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await smsfApi.createAsset({ fund_id: fundId, asset_type: form.asset_type, label: form.label, amount: parseFloat(form.amount) || 0 });
      onSaved();
    } finally { setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title="Add Asset">
      <form onSubmit={submit} className="space-y-4">
        <Select label="Asset type" value={form.asset_type} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))}
          options={ASSET_TYPES.map(t => ({ value: t, label: t }))} />
        <Input label="Label" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="e.g. CBA shares, 12 Smith St" required />
        <Input label="Value" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth disabled={saving}>{saving ? 'Saving…' : 'Add Asset'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Contribution modal ────────────────────────────────────────────────────────
function ContributionModal({ member, fy, onClose, onSaved }: { member: Member; fy: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    contribution_type: 'concessional' as 'concessional' | 'non_concessional',
    amount: '',
    contributed_on: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await smsfApi.createContribution({
        member_id: member.id,
        contribution_type: form.contribution_type,
        amount: parseFloat(form.amount) || 0,
        contributed_on: form.contributed_on,
      });
      onSaved();
    } finally { setSaving(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title={`Log Contribution — ${member.full_name}`}>
      <form onSubmit={submit} className="space-y-4">
        <Select label="Type" value={form.contribution_type}
          onChange={e => setForm(f => ({ ...f, contribution_type: e.target.value as 'concessional' | 'non_concessional' }))}
          options={[{ value: 'concessional', label: 'Concessional (before-tax)' }, { value: 'non_concessional', label: 'Non-concessional (after-tax)' }]} />
        <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <Input label="Date" type="date" value={form.contributed_on} onChange={e => setForm(f => ({ ...f, contributed_on: e.target.value }))} hint={`Counts toward the financial year of this date (currently ${fy})`} required />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth disabled={saving}>{saving ? 'Saving…' : 'Log Contribution'}</Button>
        </div>
      </form>
    </Modal>
  );
}
