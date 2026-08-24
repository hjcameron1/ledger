/**
 * Who else can see this document.
 *
 * The same operation, the same join table and the same pills as the sharing
 * panel on an account or a loan (SharePanel.tsx — its `Pill` is imported rather
 * than re-drawn): tap a household to put the document in it, tap again to take
 * it out, and being in one household never takes it out of another.
 *
 * ONE DOCUMENT ROW, ONE STORED FILE, however many households can see it. There
 * is no copy in anybody else's vault, nothing is moved, and un-sharing deletes
 * nothing — which is why the copy below can promise exactly that.
 *
 * Two things a document has that an account does not, and both are said plainly
 * rather than hidden:
 *
 *   It can reach a household by its LINK — filed against an account that lives
 *   there. Those households are shown as a sentence, not as pills, because
 *   un-ticking them here would be a control that silently does nothing: that
 *   share belongs to the record, and ends when the record's share ends.
 *
 *   Sharing is the OWNER's. Somebody looking at a document shared with them
 *   sees who it came from and nothing to press.
 */
import { useState } from 'react';
import { useStore } from '../../store';
import { documentsDS, householdContext } from '../../services/dataService';
import { myHouseholds, can, householdsOf } from '../../utils/household';
import type { LedgerDocument } from '../../types';
import { Pill } from './SharePanel';

interface Props {
  doc: LedgerDocument;
  /** Called with the updated document after a share changes. */
  onChange?: (doc: LedgerDocument) => void;
}

export default function DocumentSharePanel({ doc, onChange }: Props) {
  const user = useStore(s => s.user);
  useStore(s => [s.households, s.householdMembers]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ctx = householdContext();
  const mine = doc.user_id === user?.id;
  const households = myHouseholds(ctx);

  // What the OWNER put it in (togglable) versus where it merely appears.
  const explicit = doc.shared_household_ids ?? [];
  const viaLink = householdsOf(doc).filter(id => !explicit.includes(id));
  const nameOf = (id: string) => households.find(h => h.id === id)?.name ?? 'another household';

  const set = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      onChange?.(await documentsDS.setHouseholds(doc.id, ids));
    } catch (err) {
      const detail = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(detail ?? 'Could not change that.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (householdId: string) => set(
    explicit.includes(householdId)
      ? explicit.filter(id => id !== householdId)
      : [...explicit, householdId],
  );

  // Somebody else's document. The one honest thing to say is where it came
  // from — sharing it on is not theirs to decide.
  if (!mine) {
    return (
      <Shell>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Shared with you{viaLink.length || explicit.length
            ? <> through <span className="font-medium">{nameOf(householdsOf(doc)[0] ?? '')}</span></>
            : null}.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          It stays its owner's — only they can rename it, have it read, share it further or delete it.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1.5">
        Shared with
      </p>
      {households.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          You're not in a household yet — only you can see this.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {households.map(h => {
              const selected = explicit.includes(h.id);
              const allowed = can(ctx, 'share_own', h.id);
              return (
                <Pill
                  key={h.id}
                  label={h.name}
                  hint={selected
                    ? 'Everyone in it can see and download this — tap to take it out'
                    : allowed ? 'Everyone in it can see and download it' : 'Viewers can look, not add'}
                  selected={selected}
                  disabled={busy || (!selected && !allowed)}
                  onClick={() => void toggle(h.id)}
                />
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            {explicit.length === 0
              ? 'In no household — only you can see it.'
              : <>In {explicit.length === 1 ? 'one household' : `${explicit.length} households`}. One
                  document, one file — shown in each, copied into none.{' '}
                <button
                  disabled={busy}
                  onClick={() => void set([])}
                  className="text-brand hover:underline disabled:opacity-50"
                >
                  Make it personal
                </button>
              </>}
          </p>
        </>
      )}

      {viaLink.length > 0 && (
        <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          Also visible in {viaLink.map(nameOf).join(' and ')} through what it's filed against —
          that ends when that record stops being shared.
        </p>
      )}

      {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3">
      <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 mb-2">Sharing</p>
      {children}
    </div>
  );
}
