/**
 * The sharing panel that lives inside a shareable row's detail — the one place
 * a bank account, card, loan, property, budget, goal or investment is connected
 * to another Ledger user. One panel for every kind, because sharing is one
 * operation whatever the row is: nothing below knows or cares what entity it
 * decorates beyond what to call it in the copy.
 *
 * Two independent things sit together because to the user they are one question
 * — "who else sees this?" — even though underneath they could not be more
 * separate, and keeping them separate is what keeps the money honest:
 *
 *   A HOUSEHOLD share puts the row into a shared picture that has totals of its
 *   own, counted once however many members look. A row can be in SEVERAL
 *   households at once — one account, one balance, shown in each picture and
 *   counted once in each, because the pictures are never added together.
 *
 *   A DIRECT link (`record_shares`, minted from a `share_codes` code) shows the
 *   row to ONE named person. It stays yours, stays only in your totals, and
 *   they see the same balance you do.
 *
 * Nothing here creates, copies or moves a financial row. Every control is one
 * column on the row that already exists, or a grant beside it — which is why the
 * copy can promise, plainly, that un-sharing deletes nothing.
 *
 * When the account isn't the user's — somebody shared it with them — the panel
 * flips to the one thing that IS theirs to decide: handing the access back.
 */
import { useState } from 'react';
import { useStore } from '../../store';
import { sharingDS, sharesDS, type ShareableKind } from '../../services/dataService';
import type { SharePermission } from '../../types';

interface Props {
  kind: ShareableKind;
  id: string;
  /** What to call this thing in the copy ("account", "goal", "holding"…). */
  noun?: string;
  onChange?: () => void;
}

export default function SharePanel({ kind, id, noun = 'this account', onChange }: Props) {
  // Named so the panel re-renders the instant a grant, a code or a stamp moves —
  // every slice a shareable row can live in, because the panel serves them all.
  useStore(s => [
    s.households, s.householdMembers, s.recordShares, s.shareCodes,
    s.accounts, s.creditCards, s.loans, s.properties, s.budgets, s.goals, s.investments,
    s.incomeEntries,
  ]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Re-sharing into a household that edited this row while it was last shared:
  // the household kept its version, so the owner picks which one to share.
  const [versionChoice, setVersionChoice] = useState<{ id: string; name: string } | null>(null);

  const assignment = sharingDS.assignment(kind, id);

  async function run(action: () => Promise<unknown> | unknown, clearMinted = true) {
    setBusy(true); setError(null);
    try {
      await action();
      if (clearMinted) setMinted(null);
      onChange?.();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error ?? (err as Error)?.message ?? 'Could not change that.';
      setError(typeof message === 'string' ? message : 'Could not change that.');
    } finally {
      setBusy(false);
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  // ── Somebody else's account, shared with me ────────────────────────────────
  // The only thing here that is mine to decide is whether to keep seeing it.
  if (!assignment || !assignment.mine) {
    const grant = sharesDS.incoming().find(g => g.record_id === id);
    if (!grant) return null;
    const from = grant.owner_name || grant.owner_email || 'someone';
    return (
      <Shell>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Shared with you by <span className="font-medium">{from}</span>
          {' · '}{grant.permission === 'edit' ? 'you can edit it' : 'view only'}.
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          It's theirs — you see exactly what they do, and none of it counts towards your totals.
        </p>
        <button
          disabled={busy}
          onClick={() => run(() => sharesDS.end(grant.id).then(r => { if (!r.ok) throw new Error(r.error ?? 'Could not do that.'); }))}
          className="mt-2 text-xs text-[#ef4444] hover:underline disabled:opacity-50"
        >
          Remove from my view
        </button>
        {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
      </Shell>
    );
  }

  const { households, direct, targets, pendingCodes } = assignment;
  const canOfferHousehold = targets.length > 0 || households.length > 0;

  const shareInto = (householdId: string, resolution?: 'keep' | 'reset') => run(() => {
    setVersionChoice(null);
    const result = sharingDS.share(kind, id, householdId, resolution);
    if (!result.ok) throw new Error(result.error ?? 'Could not share that.');
  });
  const toHousehold = (household: { id: string; name: string }) => {
    // If this household edited the row while it was last shared, it kept its
    // version — sharing back means choosing which version it now sees.
    if (sharingDS.overlay(kind, id, household.id)) { setVersionChoice(household); return; }
    shareInto(household.id);
  };
  /** Take it out of ONE household. Every other one it's in is untouched. */
  const outOfHousehold = (householdId: string) => run(() => {
    const result = sharingDS.unshare(kind, id, householdId);
    if (!result.ok) throw new Error(result.error ?? 'Could not change that.');
  });
  /** Out of all of them — the "Personal" pill. */
  const toPersonal = () => run(() => {
    const result = sharingDS.unshare(kind, id);
    if (!result.ok) throw new Error(result.error ?? 'Could not change that.');
  });
  const mint = (permission: SharePermission) => run(async () => {
    const code = await sharesDS.createCode(kind, id, permission);
    setMinted(code.code);
  }, false);

  return (
    <Shell>
      {/* ── Households ────────────────────────────────────────────────────── */}
      {/* A row can sit in SEVERAL households at once — the joint account that
          belongs to both the couple and the family is one account, shown in each
          of their pictures and counted once in each. So these are toggles, not a
          choice of one: tap to put it in, tap again to take it out, and taking it
          out of one leaves it in the others. */}
      {canOfferHousehold && (
        <div className="mb-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1.5">
            Shared with
          </p>
          <div className="flex flex-wrap gap-1.5">
            {households.map(h => (
              <Pill
                key={h.id}
                label={h.name}
                hint="Counted once in its totals — tap to take it out"
                selected
                disabled={busy}
                onClick={() => outOfHousehold(h.id)}
              />
            ))}
            {targets.map(h => (
              <Pill
                key={h.id}
                label={h.name}
                hint="Everyone in it can see it"
                selected={false}
                disabled={busy}
                onClick={() => toHousehold(h)}
              />
            ))}
          </div>
          {versionChoice && (
            <div className="mt-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-2.5">
              <p className="text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
                While this was shared, <span className="font-medium">{versionChoice.name}</span> edited
                it and you kept your own version. Which one should they see now?
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <button
                  disabled={busy}
                  onClick={() => shareInto(versionChoice.id, 'keep')}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-brand text-white hover:opacity-90 disabled:opacity-50"
                >
                  Their last version
                </button>
                <button
                  disabled={busy}
                  onClick={() => shareInto(versionChoice.id, 'reset')}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-medium text-zinc-700 dark:text-zinc-200 border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50"
                >
                  Mine, as it is now
                </button>
                <button
                  disabled={busy}
                  onClick={() => setVersionChoice(null)}
                  className="px-2 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            {households.length === 0
              ? 'Not in any household — only you can see it.'
              : <>In {households.length === 1 ? 'one household' : `${households.length} households`}. {' '}
                  <button
                    disabled={busy}
                    onClick={toPersonal}
                    className="text-brand hover:underline disabled:opacity-50"
                  >
                    Make it personal
                  </button>
                </>}
          </p>
        </div>
      )}

      {/* ── Share with one person, by code ────────────────────────────────── */}
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1">
        Share with a person
      </p>
      <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400 mb-2">
        Generate a code and send it to another Ledger user. They enter it and see the same {noun} you do —
        it stays yours, and stays only in your totals.
      </p>

      {minted ? (
        <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-2.5">
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">
            Send them this code. It works once, and expires in 14 days.
          </p>
          <code className="block w-full px-2 py-1.5 rounded-md bg-white dark:bg-zinc-900 text-[11px] break-all select-all">
            {minted}
          </code>
          <div className="flex items-center gap-3 mt-1.5">
            <button onClick={() => copy(minted)} className="text-[11px] text-brand hover:underline">
              {copied ? 'Copied' : 'Copy code'}
            </button>
            <button onClick={() => setMinted(null)} className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:underline">
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <button
            disabled={busy}
            onClick={() => mint('view')}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-brand text-white hover:opacity-90 disabled:opacity-50"
          >
            Invite with a code
          </button>
          <button
            disabled={busy}
            onClick={() => mint('edit')}
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            Join via Code
          </button>
        </div>
      )}

      {/* ── Who can already see it ────────────────────────────────────────── */}
      {(direct.length > 0 || pendingCodes.length > 0) && (
        <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
          {direct.map(g => (
            <div key={g.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs truncate">{g.shared_with_name || g.shared_with_email || 'Someone'}</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {g.permission === 'edit' ? 'Can view and edit' : 'View only'}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  disabled={busy}
                  onClick={() => run(() => sharesDS.setPermission(g.id, g.permission === 'view' ? 'edit' : 'view'))}
                  className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-brand hover:underline disabled:opacity-50"
                >
                  {g.permission === 'view' ? 'Let them edit' : 'View only'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => run(() => sharesDS.end(g.id).then(r => { if (!r.ok) throw new Error(r.error ?? 'Could not do that.'); }))}
                  className="text-[11px] text-[#ef4444] hover:underline disabled:opacity-50"
                >
                  Stop sharing
                </button>
              </div>
            </div>
          ))}
          {pendingCodes.map(code => (
            <div key={code.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Code not used yet · {code.permission === 'edit' ? 'view + edit' : 'view only'}
                </p>
                <code className="block text-[11px] break-all select-all text-zinc-400 dark:text-zinc-500">{code.code}</code>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => copy(code.code)} className="text-[11px] text-brand hover:underline">Copy</button>
                <button
                  disabled={busy}
                  onClick={() => run(() => sharesDS.revokeCode(code.id))}
                  className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:underline disabled:opacity-50"
                >
                  Withdraw
                </button>
              </div>
            </div>
          ))}
        </div>
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

function Pill({ label, hint, selected, disabled, onClick }: {
  label: string; hint: string; selected: boolean; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors max-w-[180px] truncate
        ${selected
          ? 'bg-brand text-white'
          : 'text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'}
        ${disabled && !selected ? 'opacity-50' : ''} ${disabled ? 'cursor-default' : ''}`}
    >
      {selected ? `✓ ${label}` : label}
    </button>
  );
}
