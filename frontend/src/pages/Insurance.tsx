/**
 * Phase 8.2 — insurance.
 *
 * Home, contents, landlord, car, health, life, income protection: who covers
 * what, for how much, until when. Local-first like every other financial entity
 * (the store answers instantly and `syncWithRetry` catches up), unlike the
 * document vault next door — a policy is rows, not bytes.
 *
 * The page holds NO arithmetic. `insuranceReportDS.visible()` runs the pure
 * engine (utils/insurance.ts) over the policies in the store and hands back
 * lines that already know their yearly cost, their days to renewal, whether
 * cover has lapsed and what the premium last did. Everything below is
 * formatting, an action per row, and which rows to show.
 *
 * Sharing needs no controls here at all: A POLICY FOLLOWS THE THING IT COVERS.
 * Point it at a property shared with a household and every member sees it under
 * "Shared with you"; un-share the property and it goes with it. Editing and
 * deleting stay owner-only — the server enforces that, and this page simply
 * doesn't offer the buttons.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { PageHeader, Empty } from '../components/design-kit/UI';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input, { Select } from '../components/common/Input';
import Modal from '../components/common/Modal';
import { useStore } from '../store';
import {
  insuranceDS, insuranceReportDS, insurancePremiumHistoryDS, householdsDS,
} from '../services/dataService';
import { documentsApi } from '../services/api';
import LinkedDocuments from '../components/common/LinkedDocuments';
import { formatCurrency, formatDate } from '../utils/format';
import type { InsurancePolicy, LedgerDocument } from '../types';
import {
  POLICY_TYPES, PREMIUM_FREQUENCIES, FREQUENCY_SUFFIX, STATUS_LABEL,
  policyTypeLabel, filterPolicies,
  type InsuranceLine, type PolicyType, type PolicyStatus, type PolicyLinkType,
  type PremiumFrequency,
} from '../utils/insurance';
import { displayName, type LinkSources } from '../utils/documents';

// ── Small pieces ─────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<PolicyStatus, string> = {
  active: 'bg-[#22c55e]/15 text-[#16a34a]',
  'due-soon': 'bg-[#f59e0b]/15 text-[#d97706]',
  expired: 'bg-[#ef4444]/15 text-[#ef4444]',
  inactive: 'bg-zinc-500/15 text-zinc-500',
};

function StatusBadge({ status }: { status: PolicyStatus }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function TypeBadge({ type }: { type: PolicyType }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap bg-brand/15 text-brand">
      {policyTypeLabel(type)}
    </span>
  );
}

/** What the policy covers, in words. Unresolvable targets (a house shared with
 *  you that this device hasn't loaded) still SAY what kind of thing they are
 *  rather than pretending the link isn't there. */
const LINK_LABEL: Record<PolicyLinkType, string> = {
  account: 'Account',
  card: 'Credit card',
  loan: 'Loan',
  property: 'Property',
  investment: 'Investment',
  household: 'Household',
};

function coversText(line: InsuranceLine, sources: LinkSources): string | null {
  if (!line.linkedType || !line.linkedId) return null;
  const pool: Record<string, { id: string; name?: string | null }[]> = {
    account: sources.accounts,
    card: sources.creditCards,
    loan: sources.loans,
    property: sources.properties,
    investment: sources.investments,
    household: sources.households,
  };
  const hit = (pool[line.linkedType] ?? []).find(r => r.id === line.linkedId);
  const label = LINK_LABEL[line.linkedType];
  return hit ? `${label} · ${displayName(hit)}` : label;
}

/** When it renews, said the way a person would say it. */
function renewalText(line: InsuranceLine): string | null {
  if (!line.renewalDate || line.daysToRenewal == null) return null;
  const d = line.daysToRenewal;
  if (d < 0) return `Expired ${formatDate(line.renewalDate)}`;
  if (d === 0) return 'Renews today';
  if (d === 1) return 'Renews tomorrow';
  if (d <= 60) return `Renews in ${d} days`;
  return `Renews ${formatDate(line.renewalDate)}`;
}

// ── Covers picker ────────────────────────────────────────────────────────────

interface LinkChoice { linked_type: PolicyLinkType | ''; linked_id: string }

function CoversPicker({ value, onChange, sources }: {
  value: LinkChoice;
  onChange: (v: LinkChoice) => void;
  sources: LinkSources;
}) {
  const targetOptions = useMemo(() => {
    const opts = (rows: { id: string; name?: string | null }[]) =>
      rows.map(r => ({ value: r.id, label: displayName(r) }));
    switch (value.linked_type) {
      case 'account': return opts(sources.accounts);
      case 'card': return opts(sources.creditCards);
      case 'loan': return opts(sources.loans);
      case 'property': return opts(sources.properties);
      case 'investment': return opts(sources.investments);
      case 'household': return opts(sources.households);
      default: return [];
    }
  }, [value.linked_type, sources]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <Select
        label="Covers"
        value={value.linked_type}
        onChange={e => onChange({ linked_type: e.target.value as LinkChoice['linked_type'], linked_id: '' })}
        options={[
          { value: '', label: 'Nothing in particular' },
          { value: 'property', label: 'Property' },
          { value: 'account', label: 'Account' },
          { value: 'card', label: 'Credit card' },
          { value: 'loan', label: 'Loan' },
          { value: 'investment', label: 'Investment' },
          { value: 'household', label: 'Household' },
        ]}
      />
      {value.linked_type && (
        <Select
          label="Which one"
          value={value.linked_id}
          onChange={e => onChange({ ...value, linked_id: e.target.value })}
          options={[{ value: '', label: 'Choose…' }, ...targetOptions]}
        />
      )}
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export default function Insurance() {
  const user = useStore(s => s.user);
  const currency = user?.currency_preference ?? 'AUD';

  // Subscribed so the list re-renders the moment a local-first write lands.
  const policies = useStore(s => s.insurancePolicies);
  const premiumHistory = useStore(s => s.insurancePremiumHistory);
  const accounts = useStore(s => s.accounts);
  const creditCards = useStore(s => s.creditCards);
  const loans = useStore(s => s.loans);
  const properties = useStore(s => s.properties);
  const investments = useStore(s => s.investments);
  const households = useStore(s => s.households);

  const [params, setParams] = useSearchParams();
  const focusId = params.get('focus');

  const [typeFilter, setTypeFilter] = useState<PolicyType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<InsuranceLine | null>(null);
  const [deleting, setDeleting] = useState<InsuranceLine | null>(null);
  const [documents, setDocuments] = useState<LedgerDocument[]>([]);

  // Server truth on arrival: policies shared through somebody else's property
  // only exist on the server until this lands.
  useEffect(() => {
    void insuranceDS.refresh();
    void householdsDS.refresh();
    documentsApi.getAll().then(setDocuments).catch(() => setDocuments([]));
  }, []);

  const sources: LinkSources = useMemo(() => ({
    accounts, creditCards, loans, properties, investments, households: households ?? [],
  }), [accounts, creditCards, loans, properties, investments, households]);

  // Rebuilt whenever the policies or their price history change — the ONE
  // calculation, shared with the alerts and insights engines.
  const report = useMemo(
    () => insuranceReportDS.visible(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [policies, premiumHistory],
  );

  const filtered = useMemo(
    () => filterPolicies(report.lines, typeFilter, search),
    [report.lines, typeFilter, search],
  );
  // Yours versus shared with you, by OWNERSHIP — the same split every other
  // screen draws. A policy on somebody else's shared house is theirs, however
  // plainly you can see it.
  const ownedIds = useMemo(
    () => new Set(policies.filter(p => !p.user_id || p.user_id === user?.id).map(p => p.id)),
    [policies, user?.id],
  );
  const mine = filtered.filter(l => ownedIds.has(l.id));
  const shared = filtered.filter(l => !ownedIds.has(l.id));

  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusId && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusId, filtered.length]);

  const money = (n: number) => formatCurrency(n, currency);

  const row = (line: InsuranceLine, owned: boolean) => {
    const focused = line.id === focusId;
    const detail = [
      line.insurer,
      line.policyNumber ? `#${line.policyNumber}` : null,
      line.premium > 0 ? `${money(line.premium)} ${FREQUENCY_SUFFIX[line.frequency]}` : null,
      line.premium > 0 && line.frequency !== 'annually' ? `${money(line.annualPremium)} a year` : null,
      renewalText(line),
      line.excess != null ? `${money(line.excess)} excess` : null,
      line.coverageAmount != null ? `${money(line.coverageAmount)} cover` : null,
      coversText(line, sources),
    ].filter(Boolean).join(' · ');

    return (
      <div
        key={line.id}
        ref={focused ? focusRef : undefined}
        className={`flex items-start gap-3 py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0 ${
          focused ? 'ring-2 ring-brand/40 rounded-[10px] px-2 -mx-2' : ''
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{line.name}</span>
            <TypeBadge type={line.type} />
            <StatusBadge status={line.status} />
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">{detail}</div>
          {line.premiumChange && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {line.premiumChange.delta > 0 ? 'Up' : 'Down'} {money(Math.abs(line.premiumChange.delta))} a year
              {' '}since {formatDate(line.premiumChange.date)}
              {' '}({money(line.premiumChange.previousAnnual)} → {money(line.premiumChange.annual)})
            </div>
          )}
          {line.notes && (
            <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{line.notes}</div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {owned ? (
            <>
              <button onClick={() => setEditing(line)}
                className="px-2 py-1 text-xs rounded-[6px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                Edit
              </button>
              <button onClick={() => insuranceDS.setActive(line.id, !line.active)}
                title={line.active ? 'Mark as no longer held' : 'Mark as held again'}
                className="px-2 py-1 text-xs rounded-[6px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                {line.active ? 'Not held' : 'Reinstate'}
              </button>
              <button onClick={() => setDeleting(line)}
                className="px-2 py-1 text-xs rounded-[6px] text-[#ef4444] hover:bg-[#ef4444]/10">
                Delete
              </button>
            </>
          ) : (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 px-2">Shared</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <Layout>
      <PageHeader
        title="Insurance"
        subtitle="What you're covered for, what it costs, and when it renews."
        action={<Button onClick={() => setAdding(true)}>Add policy</Button>}
      />

      {/* The summary is the report's own figures — nothing is added up here. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <SummaryTile label="Premiums a year" value={money(report.totalAnnualPremium)} />
        <SummaryTile label="A month" value={money(report.totalMonthlyPremium)} />
        <SummaryTile label="Policies held" value={String(report.held.length)}
          hint={report.expired.length > 0 ? `${report.expired.length} expired` : undefined}
          hintTone={report.expired.length > 0 ? 'bad' : undefined} />
        <SummaryTile
          label="Next renewal"
          value={report.nextRenewal?.renewalDate ? formatDate(report.nextRenewal.renewalDate) : '—'}
          hint={report.nextRenewal?.name}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex-1">
          <Input placeholder="Search name, insurer, policy number…" value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sm:w-56">
          <Select value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as PolicyType | 'all')}
            options={[{ value: 'all', label: 'All types' },
              ...POLICY_TYPES.map(t => ({ value: t.value, label: t.label }))]} />
        </div>
      </div>

      <Card>
        {mine.length === 0 ? (
          <Empty>
            {report.lines.length === 0
              ? 'No policies yet. Add one to track its renewal, its premium and what it covers.'
              : 'Nothing matches that filter.'}
          </Empty>
        ) : mine.map(l => row(l, true))}
      </Card>

      {shared.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">
            Shared with you
          </h2>
          <Card>{shared.map(l => row(l, false))}</Card>
        </>
      )}

      {report.byType.length > 1 && (
        <>
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">
            What you spend on cover
          </h2>
          <Card>
            {report.byType.map(t => (
              <div key={t.type} className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
                <span className="text-sm text-zinc-700 dark:text-zinc-200">
                  {policyTypeLabel(t.type)}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400"> · {t.count} polic{t.count === 1 ? 'y' : 'ies'}</span>
                </span>
                <span className="text-sm font-medium">{money(t.annualPremium)} a year</span>
              </div>
            ))}
          </Card>
        </>
      )}

      {(adding || editing) && (
        <PolicyModal
          line={editing}
          sources={sources}
          documents={documents.filter(d => d.user_id === user?.id)}
          currency={currency}
          onClose={() => { setAdding(false); setEditing(null); if (focusId) setParams({}); }}
        />
      )}

      {deleting && (
        <Modal isOpen onClose={() => setDeleting(null)} title="Delete policy" size="sm"
          footer={
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" onClick={() => { insuranceDS.remove(deleting.id); setDeleting(null); }}>
                Delete
              </Button>
            </div>
          }>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Delete <span className="font-medium">{deleting.name}</span> and its premium history?
            If you simply no longer hold this cover, use <span className="font-medium">Not held</span> instead —
            that keeps the record of what it was and what it cost.
          </p>
        </Modal>
      )}
    </Layout>
  );
}

function SummaryTile({ label, value, hint, hintTone }: {
  label: string; value: string; hint?: string; hintTone?: 'bad';
}) {
  return (
    <Card className="p-3">
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="text-lg font-semibold truncate">{value}</div>
      {hint && (
        <div className={`text-[11px] truncate ${hintTone === 'bad' ? 'text-[#ef4444]' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {hint}
        </div>
      )}
    </Card>
  );
}

// ── Add / edit ───────────────────────────────────────────────────────────────

function PolicyModal({ line, sources, documents, currency, onClose }: {
  line: InsuranceLine | null;
  sources: LinkSources;
  documents: LedgerDocument[];
  currency: string;
  onClose: () => void;
}) {
  const existing = line ? insuranceDS.find(line.id) : undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<PolicyType>(existing?.policy_type ?? 'home');
  const [insurer, setInsurer] = useState(existing?.insurer ?? '');
  const [policyNumber, setPolicyNumber] = useState(existing?.policy_number ?? '');
  const [premium, setPremium] = useState(existing ? String(existing.premium_amount ?? '') : '');
  const [frequency, setFrequency] = useState<PremiumFrequency>(existing?.premium_frequency ?? 'annually');
  const [startDate, setStartDate] = useState(existing?.start_date ?? '');
  const [renewalDate, setRenewalDate] = useState(existing?.renewal_date ?? '');
  const [excess, setExcess] = useState(existing?.excess != null ? String(existing.excess) : '');
  const [coverage, setCoverage] = useState(existing?.coverage_amount != null ? String(existing.coverage_amount) : '');
  const [documentId, setDocumentId] = useState(existing?.document_id ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [link, setLink] = useState<LinkChoice>({
    linked_type: existing?.linked_type ?? '', linked_id: existing?.linked_id ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const history = existing ? insurancePremiumHistoryDS.forPolicy(existing.id) : [];
  const money = (n: number) => formatCurrency(n, currency);

  const num = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const submit = () => {
    if (!name.trim()) { setError('A policy needs a name.'); return; }
    if (link.linked_type && !link.linked_id) {
      setError('Choose what it covers, or set that back to nothing in particular.');
      return;
    }
    const premiumValue = num(premium);
    if (premium.trim() && premiumValue == null) { setError('The premium must be a number.'); return; }

    const fields = {
      name: name.trim(),
      policy_type: type,
      insurer: insurer.trim() || null,
      policy_number: policyNumber.trim() || null,
      premium_amount: premiumValue ?? 0,
      premium_frequency: frequency,
      start_date: startDate || null,
      renewal_date: renewalDate || null,
      excess: num(excess),
      coverage_amount: num(coverage),
      linked_type: link.linked_type || null,
      linked_id: link.linked_type ? link.linked_id : null,
      document_id: documentId || null,
      notes: notes.trim() || null,
    };

    if (existing) {
      // A premium change here is recorded as history in the same act — see
      // insuranceDS.update. Nothing on this screen writes one by hand.
      insuranceDS.update(existing.id, fields as Partial<InsurancePolicy>);
    } else {
      insuranceDS.add({ ...fields, active: true } as Omit<InsurancePolicy, 'id' | 'user_id' | 'created_at' | 'updated_at'>);
    }
    onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={existing ? 'Edit policy' : 'Add policy'} size="lg"
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>{existing ? 'Save' : 'Add policy'}</Button>
        </div>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input label="Name" placeholder="House — NRMA" value={name}
            onChange={e => setName(e.target.value)} />
          <Select label="Type" value={type}
            onChange={e => setType(e.target.value as PolicyType)}
            options={POLICY_TYPES.map(t => ({ value: t.value, label: t.label }))} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Insurer" placeholder="NRMA, Medibank, AAMI…" value={insurer}
            onChange={e => setInsurer(e.target.value)} />
          <Input label="Policy number" value={policyNumber}
            onChange={e => setPolicyNumber(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Premium" type="number" inputMode="decimal" placeholder="0.00"
            value={premium} onChange={e => setPremium(e.target.value)} />
          <Select label="Billed" value={frequency}
            onChange={e => setFrequency(e.target.value as PremiumFrequency)}
            options={PREMIUM_FREQUENCIES.map(f => ({ value: f.value, label: f.label }))} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Cover started" type="date" value={startDate}
            onChange={e => setStartDate(e.target.value)} />
          <Input label="Renews on" type="date" value={renewalDate}
            onChange={e => setRenewalDate(e.target.value)}
            hint="Reminders — and the expiry warning — are measured from this." />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input label="Excess" type="number" inputMode="decimal" value={excess}
            onChange={e => setExcess(e.target.value)} />
          <Input label="Sum insured" type="number" inputMode="decimal" value={coverage}
            onChange={e => setCoverage(e.target.value)} />
        </div>

        <CoversPicker value={link} onChange={setLink} sources={sources} />
        {link.linked_type && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {link.linked_type === 'household'
              ? 'Linked to a household, every member can see this policy.'
              : 'Whoever can see that record can see this policy — and stops being able to the moment it is un-shared.'}
          </p>
        )}

        <Select label="Policy document" value={documentId}
          onChange={e => setDocumentId(e.target.value)}
          options={[
            { value: '', label: 'None' },
            ...documents.map(d => ({ value: d.id, label: d.name })),
          ]} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400 -mt-2">
          From your document vault. Only your own documents can be attached to a policy.
        </p>
        {/* The other end of that same single pointer: the policy names its
            document, so the policy can open it. */}
        <LinkedDocuments documentIds={[documentId]} title="Policy document" />

        <Input label="Notes" value={notes} onChange={e => setNotes(e.target.value)} />

        {history.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-1">Premium history</div>
            <div className="space-y-1">
              {[...history].reverse().map(h => (
                <div key={h.id} className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{formatDate(h.effective_date)}{h.note ? ` · ${h.note}` : ''}</span>
                  <span>{money(h.premium_amount)} {FREQUENCY_SUFFIX[h.premium_frequency]}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-[#ef4444]">{error}</p>}
      </div>
    </Modal>
  );
}
