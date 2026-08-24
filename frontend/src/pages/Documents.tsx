/**
 * Phase 8.1 — the financial document vault.
 *
 * Statements, payslips, tax paperwork, loan and property documents, insurance
 * policies — uploaded here, kept in a private bucket, and only ever fetched
 * through the authenticated API (no URL to a document exists outside this tab).
 *
 * Server-truth, like Households: files are shared with other people and can't
 * live in the local-first store, so this page awaits every call and refetches
 * the list after each change. Presentation decisions (labels, link names, the
 * yours/shared split, FY options) live in utils/documents.ts, tested.
 *
 * Phase 8.3 adds READING: for an insurance, loan or statement PDF or photo the
 * owner can ask Ledger what it says, and what comes back is stored field by
 * field WITH THE WORDS ON THE PAGE IT CAME FROM. Every reading is shown beside
 * its quote, a reading the model was unsure of is marked and does nothing
 * until it is confirmed, and a value the user corrects becomes theirs. Nothing
 * on this page infers a field a document does not state — the server discards
 * those before they reach here (backend/src/services/documentFacts.ts).
 *
 * A document reaches other people two ways, and only two. It FOLLOWS THE RECORD
 * IT IS LINKED TO — filed against a shared account, loan, property or
 * investment, whoever sees that record sees the paperwork — and its owner can
 * SHARE IT TO HOUSEHOLDS in its own right, through the same join table an
 * account uses. One document row and one stored file either way, in as many
 * households as it was put in, copied into none.
 *
 * Which is what makes the two views honest. My Finances is the whole vault this
 * device was sent; a household shows the documents in THAT household and
 * nothing else, so being in two households never puts one's paperwork in the
 * other's view. Rename, re-file, read, share and delete are owner-only — the
 * server enforces it, this page just doesn't offer the buttons.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Layout from '../components/layout/Layout';
import { PageHeader, Empty, Spinner } from '../components/design-kit/UI';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input, { Select } from '../components/common/Input';
import Modal from '../components/common/Modal';
import { useStore } from '../store';
import { documentsApi } from '../services/api';
import { householdsDS, householdContext, currentScope } from '../services/dataService';
import DocumentSharePanel from '../components/common/DocumentSharePanel';
import { Pill } from '../components/common/SharePanel';
import { myHouseholds, can } from '../utils/household';
import { formatDate, formatCurrency } from '../utils/format';
import type { LedgerDocument, DocumentKind, DocumentLinkType, DocumentFact } from '../types';
import {
  factsForDocument, isReadableDocument, FACT_TRUST_FLOOR, type DocumentFactView,
} from '../utils/documentFacts';
import {
  DOCUMENT_KINDS, KIND_BADGE, kindLabel, formatBytes, canPreview, displayName,
  linkDisplay, splitByOwnership, filterDocuments, fyOptions, LinkSources,
  scopeDocuments, documentHouseholds,
} from '../utils/documents';

// ── Small pieces ─────────────────────────────────────────────────────────────

function KindBadge({ kind }: { kind: DocumentKind }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${KIND_BADGE[kind] ?? KIND_BADGE.other}`}>
      {kindLabel(kind)}
    </span>
  );
}

function FileIcon({ mime }: { mime: string }) {
  const glyph = mime === 'application/pdf' ? 'PDF'
    : mime.startsWith('image/') ? 'IMG'
    : mime.includes('spreadsheet') || mime.includes('csv') || mime.includes('excel') ? 'XLS'
    : mime.includes('word') ? 'DOC'
    : 'TXT';
  return (
    <div className="w-9 h-9 rounded-[8px] bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0">
      <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400">{glyph}</span>
    </div>
  );
}

// ── Link picker ──────────────────────────────────────────────────────────────

interface LinkChoice { linked_type: DocumentLinkType | ''; linked_id: string }

function LinkPicker({ value, onChange, sources }: {
  value: LinkChoice;
  onChange: (v: LinkChoice) => void;
  sources: LinkSources;
}) {
  const targetOptions = useMemo(() => {
    const opts = (rows: { id: string; name?: string | null }[]) =>
      rows.map(r => ({ value: r.id, label: displayName(r) }));
    switch (value.linked_type) {
      case 'account':    return opts(sources.accounts);
      case 'card':       return opts(sources.creditCards);
      case 'loan':       return opts(sources.loans);
      case 'property':   return opts(sources.properties);
      case 'investment': return opts(sources.investments);
      case 'household':  return opts(sources.households);
      case 'tax_year':   return fyOptions(new Date()).map(fy => ({ value: fy, label: `FY ${fy}` }));
      default:           return [];
    }
  }, [value.linked_type, sources]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <Select
        label="Link to"
        value={value.linked_type}
        onChange={e => onChange({ linked_type: e.target.value as LinkChoice['linked_type'], linked_id: '' })}
        options={[
          { value: '', label: 'Nothing — keep it personal' },
          { value: 'account', label: 'Account' },
          { value: 'card', label: 'Credit card' },
          { value: 'loan', label: 'Loan' },
          { value: 'property', label: 'Property' },
          { value: 'investment', label: 'Investment' },
          { value: 'tax_year', label: 'Tax year' },
          { value: 'household', label: 'Household' },
        ]}
      />
      {value.linked_type && (
        <Select
          label={value.linked_type === 'tax_year' ? 'Which year' : 'Which one'}
          value={value.linked_id}
          onChange={e => onChange({ ...value, linked_id: e.target.value })}
          options={[{ value: '', label: 'Choose…' }, ...targetOptions]}
        />
      )}
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

// ── What a document says (Phase 8.3) ─────────────────────────────────────────

/** One reading, said the way the page it came from says it. */
function factText(f: DocumentFactView, currency: string): string {
  if (f.kind === 'money' && f.number != null) return formatCurrency(f.number, currency);
  if (f.kind === 'date' && f.date) return formatDate(f.date);
  if (f.kind === 'rate' && f.number != null) return `${f.number}%`;
  return f.text;
}

/**
 * The readings for one document.
 *
 * Every value is shown WITH ITS QUOTE. That is the point of the whole panel:
 * a figure lifted off a PDF is worth having only if the person whose PDF it is
 * can see the sentence it came from and say yes or no. A reading the extractor
 * was unsure of is greyed and marked, and does nothing anywhere in the app
 * until it is confirmed.
 */
function FactsPanel({ doc, facts, owned, currency, onChange, onError }: {
  doc: LedgerDocument;
  facts: DocumentFact[];
  owned: boolean;
  currency: string;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const rows = useMemo(() => factsForDocument(facts, doc.id), [facts, doc.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<DocumentFactView | null>(null);
  const [draft, setDraft] = useState('');

  const send = async (factId: string, data: { status?: string; value?: string }) => {
    setBusy(factId);
    try {
      await documentsApi.updateFact(factId, data);
      setEditing(null);
      onChange();
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      onError(detail ?? 'Could not save that.');
    } finally {
      setBusy(null);
    }
  };

  if (!rows.length) {
    return (
      <div className="text-xs text-zinc-500 dark:text-zinc-400 py-2">
        {doc.extraction_status === 'read' || doc.extraction_status === 'nothing-found'
          ? 'Ledger read this document and found none of the details it looks for. Nothing has been guessed from it.'
          : 'Ledger has not read this document yet.'}
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-2">
      {rows.map(f => (
        <div key={f.id}
          className={`rounded-[8px] px-3 py-2 ${f.usable
            ? 'bg-zinc-50 dark:bg-zinc-800/60'
            : 'bg-amber-500/5 border border-amber-500/30'}`}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{f.label}</span>
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {factText(f, currency)}
            </span>
            {f.needsConfirmation && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                Needs confirming
              </span>
            )}
            {f.status === 'confirmed' && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                {f.source === 'user' ? 'Your correction' : 'Confirmed'}
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 italic">
            {f.page ? `p.${f.page} · ` : ''}&ldquo;{f.quote}&rdquo;
          </div>
          {f.needsConfirmation && (
            <div className="text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-0.5">
              Read with {Math.round(f.confidence * 100)}% confidence — below the {Math.round(FACT_TRUST_FLOOR * 100)}% Ledger will answer from on its own.
            </div>
          )}

          {owned && editing?.id === f.id ? (
            <div className="flex items-center gap-2 mt-2">
              <Input value={draft} onChange={e => setDraft(e.target.value)}
                placeholder={f.kind === 'date' ? '2027-03-03' : f.kind === 'money' ? '1240.50' : 'What it actually says'} />
              <Button size="sm" disabled={busy === f.id}
                onClick={() => void send(f.id, { value: draft })}>Save</Button>
              <button className="text-xs text-zinc-500 hover:underline" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : owned && (
            <div className="flex items-center gap-3 mt-1.5">
              {f.status !== 'confirmed' && (
                <button className="text-[11px] text-emerald-600 dark:text-emerald-400 hover:underline"
                  disabled={busy === f.id}
                  onClick={() => void send(f.id, { status: 'confirmed' })}>
                  That&rsquo;s right
                </button>
              )}
              <button className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:underline"
                disabled={busy === f.id}
                onClick={() => { setEditing(f); setDraft(f.kind === 'date' ? (f.date ?? '') : f.kind === 'money' || f.kind === 'rate' ? String(f.number ?? '') : f.text); }}>
                Correct it
              </button>
              <button className="text-[11px] text-[#ef4444] hover:underline"
                disabled={busy === f.id}
                onClick={() => void send(f.id, { status: 'rejected' })}>
                Not in this document
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Documents() {
  const user = useStore(s => s.user);
  const accounts = useStore(s => s.accounts);
  const creditCards = useStore(s => s.creditCards);
  const loans = useStore(s => s.loans);
  const properties = useStore(s => s.properties);
  const investments = useStore(s => s.investments);
  const households = useStore(s => s.households);
  // The view switch: which documents belong on screen is decided by scope,
  // exactly as it is for every other shareable row.
  const householdMembers = useStore(s => s.householdMembers);
  const financeScope = useStore(s => s.financeScope);
  const activeHouseholdId = useStore(s => s.activeHouseholdId);

  const [docs, setDocs] = useState<LedgerDocument[]>([]);
  /** Phase 8.3 — what has been read out of them, with its provenance. */
  const [facts, setFacts] = useState<DocumentFact[]>([]);
  /** The document being read right now. Reading is a model reading a PDF: slow,
   *  and worth saying out loud rather than spinning silently. */
  const [reading, setReading] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kindFilter, setKindFilter] = useState<DocumentKind | 'all'>('all');
  const [search, setSearch] = useState('');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<LedgerDocument | null>(null);
  const [previewing, setPreviewing] = useState<LedgerDocument | null>(null);
  const [deleting, setDeleting] = useState<LedgerDocument | null>(null);

  // Sharing (who can see a linked record) is resolved by the server; the
  // household list is only needed for the link picker's names.
  useEffect(() => { void householdsDS.refresh(); }, []);

  const sources: LinkSources = useMemo(() => ({
    accounts, creditCards, loans, properties, investments,
    households: households ?? [],
  }), [accounts, creditCards, loans, properties, investments, households]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      // The list and what has been read out of it, together: a document whose
      // readings have not arrived yet looks exactly like one nobody has read.
      const [list, read] = await Promise.all([documentsApi.getAll(), documentsApi.facts()]);
      setDocs(list);
      setFacts(read);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load documents.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(
    () => filterDocuments(docs, kindFilter, search),
    [docs, kindFilter, search],
  );

  /**
   * The documents this view may show.
   *
   * In a household, that is the documents in THAT household — its own shares
   * and whatever is filed against records it can see, merged by the server.
   * Nobody's private papers, and nothing from another household, which is the
   * whole privacy guarantee and is this one line rather than a rule anybody has
   * to remember.
   *
   * `financeScope` is read from the store rather than only through
   * currentScope() so this re-renders the instant the switch moves; the
   * resolved answer is still currentScope()'s, which refuses 'household' for
   * somebody who is in none.
   */
  const scope = financeScope === 'household' ? currentScope() : 'personal';
  const ctx = useMemo(
    () => householdContext(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [households, householdMembers, activeHouseholdId, user?.id],
  );
  const viewing = scope === 'household'
    ? (households ?? []).find(h => h.id === activeHouseholdId) ?? null
    : null;
  const inView = useMemo(
    () => scopeDocuments(filtered, ctx, scope, activeHouseholdId),
    [filtered, ctx, scope, activeHouseholdId],
  );
  const { mine, shared } = useMemo(
    () => splitByOwnership(inView, user?.id),
    [inView, user?.id],
  );
  /** Documents this user may see but does not own — none of them belong in My
   *  Finances, and all of them are one view switch away. Counted from the whole
   *  vault, not the filtered list, so a search that matches nothing of theirs
   *  doesn't claim their paperwork vanished. */
  const elsewhere = useMemo(
    () => (scope === 'household' ? 0 : docs.filter(d => d.user_id && d.user_id !== user?.id).length),
    [docs, scope, user?.id],
  );

  const download = async (doc: LedgerDocument) => {
    try {
      const blob = await documentsApi.getFileBlob(doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.original_filename || doc.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the click a beat before revoking, or some browsers cancel it.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      setError(`Could not download ${doc.name}.`);
    }
  };

  /**
   * Ask Ledger to read one document.
   *
   * Everything the reading produces is checked on the server before it is
   * stored — a value that is not in the words quoted never arrives here — so
   * the only thing this has to do honestly is report what came back, including
   * "nothing", which is a real answer and not a failure.
   */
  const read = async (doc: LedgerDocument) => {
    setReading(doc.id);
    setError(null);
    setNotice(null);
    try {
      const res = await documentsApi.extract(doc.id);
      await refresh();
      setExpanded(prev => new Set(prev).add(doc.id));
      const found = res.facts.filter(f => f.status !== 'rejected').length;
      setNotice(res.status === 'read'
        ? `Read ${doc.name} — ${found} detail${found === 1 ? '' : 's'} found, each shown with the words it came from. Check them and confirm anything marked.`
        : `Ledger read ${doc.name} and found none of the details it looks for. Nothing has been guessed from it.`);
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(detail ?? `Could not read ${doc.name}.`);
    } finally {
      setReading(null);
    }
  };

  const toggleFacts = (id: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const householdNames = (doc: LedgerDocument): string[] =>
    documentHouseholds(doc)
      .map(id => (households ?? []).find(h => h.id === id)?.name)
      .filter(Boolean) as string[];

  const row = (doc: LedgerDocument, owned: boolean) => (
    <div key={doc.id} className="flex items-center gap-3 py-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
      <FileIcon mime={doc.mime_type} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{doc.name}</span>
          <KindBadge kind={doc.document_type} />
          {/* Where else this appears. Only households this user is actually in
              are named — an id we cannot name is not ours to narrate. */}
          {scope !== 'household' && householdNames(doc).length > 0 && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
              {householdNames(doc).join(' · ')}
            </span>
          )}
          {factsForDocument(facts, doc.id).length > 0 && (
            <button onClick={() => toggleFacts(doc.id)}
              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand/10 text-brand hover:bg-brand/20">
              {factsForDocument(facts, doc.id).filter(f => f.needsConfirmation).length
                ? `${factsForDocument(facts, doc.id).filter(f => f.needsConfirmation).length} to confirm`
                : `${factsForDocument(facts, doc.id).length} read`}
            </button>
          )}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
          {[
            doc.provider,
            doc.document_date ? formatDate(doc.document_date) : null,
            formatBytes(doc.size_bytes),
            linkDisplay(doc, sources),
          ].filter(Boolean).join(' · ')}
        </div>
        {doc.notes && (
          <div className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{doc.notes}</div>
        )}
        {expanded.has(doc.id) && (
          <FactsPanel doc={doc} facts={facts} owned={owned}
            currency={user?.currency_preference ?? 'AUD'}
            onChange={() => void refresh()} onError={setError} />
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {canPreview(doc.mime_type) && (
          <button onClick={() => setPreviewing(doc)} title="Preview"
            className="px-2 py-1 text-xs rounded-[6px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Preview
          </button>
        )}
        <button onClick={() => void download(doc)} title="Download"
          className="px-2 py-1 text-xs rounded-[6px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          Download
        </button>
        {owned && isReadableDocument(doc) && (
          <button onClick={() => void read(doc)} disabled={reading === doc.id}
            title="Have Ledger read this document and store what it says"
            className="px-2 py-1 text-xs rounded-[6px] text-brand hover:bg-brand/10 disabled:opacity-50">
            {reading === doc.id ? 'Reading…' : factsForDocument(facts, doc.id).length ? 'Re-read' : 'Read'}
          </button>
        )}
        {owned && (
          <>
            <button onClick={() => setEditing(doc)} title="Edit"
              className="px-2 py-1 text-xs rounded-[6px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Edit
            </button>
            <button onClick={() => setDeleting(doc)} title="Delete"
              className="px-2 py-1 text-xs rounded-[6px] text-[#ef4444] hover:bg-[#ef4444]/10">
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <Layout>
      <PageHeader
        title="Documents"
        subtitle="Statements, payslips, tax paperwork and policies — filed against the things they belong to. Have a policy, loan or statement read, and Ask Ledger can answer from what it says."
        action={<Button onClick={() => setUploadOpen(true)}>Upload</Button>}
      />

      {error && (
        <div className="mb-4 px-4 py-2.5 rounded-[10px] bg-[#ef4444]/10 text-[#ef4444] text-sm">
          {error}
        </div>
      )}

      {notice && (
        <div className="mb-4 px-4 py-2.5 rounded-[10px] bg-brand/10 text-brand text-sm flex items-start gap-3">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="text-xs opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex-1">
          <Input placeholder="Search name, provider, notes…" value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="sm:w-56">
          <Select value={kindFilter}
            onChange={e => setKindFilter(e.target.value as DocumentKind | 'all')}
            options={[{ value: 'all', label: 'All types' },
              ...DOCUMENT_KINDS.map(k => ({ value: k.value, label: k.label }))]} />
        </div>
      </div>

      {loading ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : (
        <>
          {scope === 'household' ? (
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              The documents in {viewing?.name ?? 'this household'} — put there by their owners, or
              filed against something this household shares. Everything else stays where it is.
            </p>
          ) : elsewhere > 0 && (
            /* My Finances is what you OWN, so somebody else's paperwork is not
               listed here — but silence would read as "it's gone". One line
               says where it actually is, and the view switch takes you there. */
            <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              {elsewhere} {elsewhere === 1 ? 'document' : 'documents'} shared with you
              {' '}{elsewhere === 1 ? 'sits' : 'sit'} in the household{' '}
              {elsewhere === 1 ? 'it was' : 'they were'} shared with — switch the view to see
              {' '}{elsewhere === 1 ? 'it' : 'them'}. Anything filed against one of your own records
              also shows on that record.
            </p>
          )}

          <Card>
            {mine.length === 0 ? (
              <Empty>
                {scope === 'household'
                  ? `You haven't put any documents into ${viewing?.name ?? 'this household'} yet.`
                  : docs.length === 0
                    ? 'Nothing filed yet. Upload a statement, payslip or policy to start your vault.'
                    : 'Nothing matches that filter.'}
              </Empty>
            ) : mine.map(d => row(d, true))}
          </Card>

          {shared.length > 0 && (
            <>
              <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">
                {scope === 'household'
                  ? `Shared by others in ${viewing?.name ?? 'this household'}`
                  : 'Shared with you'}
              </h2>
              <Card>
                {shared.map(d => row(d, false))}
              </Card>
            </>
          )}
        </>
      )}

      {uploadOpen && (
        <UploadModal sources={sources}
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); void refresh(); }} />
      )}
      {editing && (
        <EditModal doc={editing} sources={sources}
          onClose={() => setEditing(null)}
          onShared={() => void refresh()}
          onDone={() => { setEditing(null); void refresh(); }} />
      )}
      {previewing && (
        <PreviewModal doc={previewing} onClose={() => setPreviewing(null)} />
      )}
      {deleting && (
        <Modal isOpen onClose={() => setDeleting(null)} title="Delete document" size="sm"
          footer={
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
              <Button variant="danger" onClick={async () => {
                try {
                  await documentsApi.remove(deleting.id);
                  setDeleting(null);
                  void refresh();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Delete failed.');
                  setDeleting(null);
                }
              }}>Delete</Button>
            </div>
          }>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Delete <span className="font-medium">{deleting.name}</span>? The file is removed
            permanently — there is no undo.
          </p>
        </Modal>
      )}
    </Layout>
  );
}

// ── Upload ───────────────────────────────────────────────────────────────────

function UploadModal({ sources, onClose, onDone }: {
  sources: LinkSources; onClose: () => void; onDone: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<DocumentKind>('statement');
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [provider, setProvider] = useState('');
  const [notes, setNotes] = useState('');
  const [link, setLink] = useState<LinkChoice>({ linked_type: '', linked_id: '' });
  /** Households to put these documents into as they are filed. The same share
   *  the edit screen makes, offered at the moment the paperwork arrives. */
  const [shareWith, setShareWith] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ctx = householdContext();
  const shareTargets = myHouseholds(ctx).filter(h => can(ctx, 'share_own', h.id));

  const submit = async () => {
    if (!files.length) { setError('Choose at least one file.'); return; }
    if (link.linked_type && !link.linked_id) { setError('Choose what to link to, or set the link back to nothing.'); return; }
    setBusy(true);
    setError(null);
    try {
      const meta: Record<string, string> = { document_type: kind };
      if (files.length === 1 && name.trim()) meta.name = name.trim();
      if (date) meta.document_date = date;
      if (provider.trim()) meta.provider = provider.trim();
      if (notes.trim()) meta.notes = notes.trim();
      if (link.linked_type && link.linked_id) {
        meta.linked_type = link.linked_type;
        meta.linked_id = link.linked_id;
      }
      // A multipart form cannot carry an array, so the ids travel as one
      // comma-separated field the server splits back apart.
      if (shareWith.length) meta.household_ids = shareWith.join(',');
      await documentsApi.upload(files, meta);
      onDone();
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(detail ?? (err instanceof Error ? err.message : 'Upload failed.'));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Upload documents" size="lg"
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? 'Uploading…' : files.length > 1 ? `Upload ${files.length} files` : 'Upload'}
          </Button>
        </div>
      }>
      <div className="space-y-4">
        <div>
          <input ref={fileInput} type="file" multiple className="hidden"
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.csv,.txt,.doc,.docx,.xls,.xlsx"
            onChange={e => setFiles(Array.from(e.target.files ?? []))} />
          <button type="button" onClick={() => fileInput.current?.click()}
            className="w-full border-2 border-dashed border-zinc-300 dark:border-zinc-700 rounded-[12px] py-8 text-center hover:border-brand transition-colors">
            {files.length === 0 ? (
              <span className="text-sm text-zinc-500 dark:text-zinc-400">
                Choose files — PDF, image, CSV, Word or Excel (up to 10, 25&nbsp;MB each)
              </span>
            ) : (
              <span className="text-sm text-zinc-700 dark:text-zinc-200">
                {files.map(f => f.name).join(', ')}
              </span>
            )}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={kind}
            onChange={e => setKind(e.target.value as DocumentKind)}
            options={DOCUMENT_KINDS.map(k => ({ value: k.value, label: k.label }))} />
          <Input label="Document date" type="date" value={date}
            onChange={e => setDate(e.target.value)} />
        </div>

        {files.length === 1 && (
          <Input label="Name" placeholder={files[0]?.name ?? 'Display name'}
            value={name} onChange={e => setName(e.target.value)}
            hint="Leave blank to keep the file's own name." />
        )}
        {files.length > 1 && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Each file keeps its own name; the type, date and link below apply to all of them.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Input label="Provider" placeholder="CommBank, ATO, NRMA…"
            value={provider} onChange={e => setProvider(e.target.value)} />
          <Input label="Notes" placeholder="Optional"
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>

        <LinkPicker value={link} onChange={setLink} sources={sources} />
        {link.linked_type === 'household' && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Linked to a household, every member can see and download this document.
          </p>
        )}

        {shareTargets.length > 0 && (
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1.5">
              Share with
            </p>
            <div className="flex flex-wrap gap-1.5">
              {shareTargets.map(h => (
                <Pill
                  key={h.id}
                  label={h.name}
                  hint="Everyone in it can see and download it"
                  selected={shareWith.includes(h.id)}
                  disabled={busy}
                  onClick={() => setShareWith(prev =>
                    prev.includes(h.id) ? prev.filter(id => id !== h.id) : [...prev, h.id])}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              {shareWith.length === 0
                ? 'Not shared — only you will see these.'
                : 'One document each, shown in every household you pick and copied into none.'}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-[#ef4444]">{error}</p>}
      </div>
    </Modal>
  );
}

// ── Edit ─────────────────────────────────────────────────────────────────────

function EditModal({ doc, sources, onClose, onShared, onDone }: {
  doc: LedgerDocument; sources: LinkSources;
  onClose: () => void; onShared: () => void; onDone: () => void;
}) {
  // Sharing saves the moment it is tapped — it is a decision about who may
  // look, not a draft — so the panel works from the document as it stands now
  // rather than from whatever was on screen when this opened.
  const [current, setCurrent] = useState(doc);
  const [name, setName] = useState(doc.name);
  const [kind, setKind] = useState<DocumentKind>(doc.document_type);
  const [date, setDate] = useState(doc.document_date ?? '');
  const [provider, setProvider] = useState(doc.provider ?? '');
  const [notes, setNotes] = useState(doc.notes ?? '');
  const [link, setLink] = useState<LinkChoice>({
    linked_type: doc.linked_type ?? '', linked_id: doc.linked_id ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setError('A document needs a name.'); return; }
    if (link.linked_type && !link.linked_id) { setError('Choose what to link to, or set the link back to nothing.'); return; }
    setBusy(true);
    setError(null);
    try {
      await documentsApi.update(doc.id, {
        name: name.trim(),
        document_type: kind,
        document_date: date || null,
        provider: provider.trim() || null,
        notes: notes.trim() || null,
        linked_type: link.linked_type || null,
        linked_id: link.linked_type ? link.linked_id : null,
      });
      onDone();
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(detail ?? (err instanceof Error ? err.message : 'Save failed.'));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Edit document" size="lg"
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      }>
      <div className="space-y-4">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Type" value={kind}
            onChange={e => setKind(e.target.value as DocumentKind)}
            options={DOCUMENT_KINDS.map(k => ({ value: k.value, label: k.label }))} />
          <Input label="Document date" type="date" value={date}
            onChange={e => setDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Provider" value={provider} onChange={e => setProvider(e.target.value)} />
          <Input label="Notes" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        <LinkPicker value={link} onChange={setLink} sources={sources} />
        <DocumentSharePanel doc={current} onChange={next => { setCurrent(next); onShared(); }} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          File: {doc.original_filename} · {formatBytes(doc.size_bytes)}
        </p>
        {error && <p className="text-sm text-[#ef4444]">{error}</p>}
      </div>
    </Modal>
  );
}

// ── Preview ──────────────────────────────────────────────────────────────────

function PreviewModal({ doc, onClose }: { doc: LedgerDocument; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void documentsApi.getFileBlob(doc.id)
      .then(blob => {
        if (cancelled) return;
        // Re-wrap with the real mime so the browser renders rather than saves.
        objectUrl = URL.createObjectURL(new Blob([blob], { type: doc.mime_type }));
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setError('Could not load the file.'); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc.id, doc.mime_type]);

  return (
    <Modal isOpen onClose={onClose} title={doc.name} size="full">
      {error ? (
        <p className="text-sm text-[#ef4444]">{error}</p>
      ) : !url ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : doc.mime_type.startsWith('image/') ? (
        <img src={url} alt={doc.name} className="max-w-full mx-auto rounded-[8px]" />
      ) : (
        <iframe src={url} title={doc.name} className="w-full h-[70vh] rounded-[8px] bg-white" />
      )}
    </Modal>
  );
}
