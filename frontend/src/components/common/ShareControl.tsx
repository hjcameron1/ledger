/**
 * Where one row is assigned: personal, in a household, or shown to one named
 * person directly.
 *
 * One component for all seven shareable entities, because it is one decision.
 * Everything it does is either a single column on a row that already exists
 * (`household_id`) or a grant beside it (`record_shares`) — it never creates a
 * financial row, never copies one and cannot touch a balance, which is what lets
 * the wording be as blunt as it is.
 *
 * The two kinds of sharing are shown as what they are, because they genuinely
 * differ:
 *
 *   A HOUSEHOLD is a shared picture with totals of its own. Putting a row in one
 *   makes it part of what that household counts.
 *
 *   A PERSON is shown the row and nothing else. It stays yours, it stays in your
 *   totals and only your totals, and they see the same balance you do.
 *
 * It renders nothing when the row isn't the user's: somebody else's account is
 * not this user's decision to make, and a control that only ever refuses is
 * worse than no control.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { sharingDS, sharesDS, type ShareableKind } from '../../services/dataService';
import type { SharePermission } from '../../types';

interface Props {
  kind: ShareableKind;
  id: string;
  /** What to call this thing in the copy ("account", "goal"). */
  noun?: string;
  onChange?: () => void;
}

export default function ShareControl({ kind, id, noun = 'this', onChange }: Props) {
  // Subscribed so the label re-renders the moment a grant or a stamp changes.
  useStore(s => [s.households, s.householdMembers, s.recordShares, s.accounts]);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setMinted(null); }
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const assignment = sharingDS.assignment(kind, id);
  if (!assignment || !assignment.mine) return null;

  const { scope, householdName, directCount, direct, targets, pendingCodes } = assignment;

  // Nothing to offer: no household to share into and no way to have shared it
  // with anybody. A menu whose every item is unavailable is clutter.
  const canOfferHousehold = targets.length > 0 || scope === 'household';

  const label = scope === 'household'
    ? `● ${householdName ?? 'Shared'}`
    : directCount > 0
      ? `● Shared with ${directCount === 1 ? '1 person' : `${directCount} people`}`
      : 'Share';

  async function run(action: () => Promise<unknown> | unknown, close = true) {
    setBusy(true); setError(null);
    try {
      await action();
      if (close) { setOpen(false); setMinted(null); }
      onChange?.();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error ?? (err as Error)?.message ?? 'Could not change that.';
      setError(typeof message === 'string' ? message : 'Could not change that.');
    } finally {
      setBusy(false);
    }
  }

  const toHousehold = (householdId: string) => run(() => {
    const result = sharingDS.share(kind, id, householdId);
    if (!result.ok) throw new Error(result.error ?? 'Could not share that.');
  });

  const toPersonal = () => run(() => {
    const result = sharingDS.unshare(kind, id);
    if (!result.ok) throw new Error(result.error ?? 'Could not change that.');
  });

  const mint = (permission: SharePermission) => run(async () => {
    const code = await sharesDS.createCode(kind, id, permission);
    setMinted(code.code);
  }, false);

  return (
    <div ref={box} className="relative inline-block">
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); setError(null); }}
        title={scope === 'household'
          ? `Everyone in ${householdName} can see ${noun}. It's still yours.`
          : directCount > 0
            ? `${directCount === 1 ? 'One person' : `${directCount} people`} can see ${noun}. It's still yours, and still only in your totals.`
            : `Show ${noun} to a household or to one person. Sharing shows it — it doesn't hand it over.`}
        className={`text-xs hover:underline ${scope === 'household' || directCount > 0
          ? 'text-brand'
          : 'text-zinc-500 dark:text-zinc-400 hover:text-brand'}`}
      >
        {label}
      </button>

      {open && (
        <div
          onClick={e => e.stopPropagation()}
          className="absolute z-50 right-0 mt-1 w-72 p-1 rounded-xl bg-white dark:bg-zinc-900
            border border-zinc-200 dark:border-zinc-800 shadow-lg text-left"
        >
          <Row
            title="Personal"
            hint="Only you."
            selected={scope === 'personal' && directCount === 0}
            disabled={busy || scope !== 'household'}
            onClick={toPersonal}
          />

          {canOfferHousehold && (
            <>
              <Divider label="Share with a household" />
              {scope === 'household' && (
                <Row
                  title={householdName ?? 'This household'}
                  hint="Counted once in this household's totals."
                  selected
                  disabled
                  onClick={() => {}}
                />
              )}
              {targets.map(h => (
                <Row
                  key={h.id}
                  title={h.name}
                  hint="Everyone in it sees this. It stays yours."
                  selected={false}
                  disabled={busy}
                  onClick={() => toHousehold(h.id)}
                />
              ))}
            </>
          )}

          <Divider label="Share with one person" />
          <p className="px-3 pb-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            They see the same {noun === 'this' ? 'record' : noun} you do. It stays yours, and stays
            only in your totals.
          </p>

          {minted ? (
            <div className="px-3 py-2">
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">
                Send them this code. It works once, and expires in 14 days.
              </p>
              <code className="block w-full px-2 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800
                text-[11px] break-all select-all">{minted}</code>
              <button
                onClick={() => { void navigator.clipboard?.writeText(minted); }}
                className="mt-1 text-[11px] text-brand hover:underline"
              >
                Copy
              </button>
            </div>
          ) : (
            <div className="flex gap-1 px-1">
              <button
                disabled={busy}
                onClick={() => mint('view')}
                className="flex-1 px-2 py-2 rounded-lg text-xs text-zinc-700 dark:text-zinc-200
                  hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                Get a view link
              </button>
              <button
                disabled={busy}
                onClick={() => mint('edit')}
                className="flex-1 px-2 py-2 rounded-lg text-xs text-zinc-700 dark:text-zinc-200
                  hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                …with editing
              </button>
            </div>
          )}

          {(direct.length > 0 || pendingCodes.length > 0) && (
            <p className="px-3 pt-1 pb-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              {direct.length > 0 && (
                <>Shared with {direct.map(g => g.shared_with_name || g.shared_with_email || 'someone').join(', ')}. </>
              )}
              {pendingCodes.length > 0 && <>{pendingCodes.length} link not used yet. </>}
              Manage in Settings → Sharing.
            </p>
          )}

          {error && <p className="px-3 pb-2 text-[11px] text-rose-600">{error}</p>}
        </div>
      )}
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <p className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide
      text-zinc-400 dark:text-zinc-500">{label}</p>
  );
}

function Row({ title, hint, selected, disabled, onClick }: {
  title: string; hint: string; selected: boolean; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg text-xs disabled:cursor-default
        ${selected ? 'text-brand font-medium' : 'text-zinc-700 dark:text-zinc-200'}
        ${disabled ? 'opacity-60' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
    >
      <span className="block truncate">{selected ? `✓ ${title}` : title}</span>
      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>
    </button>
  );
}
