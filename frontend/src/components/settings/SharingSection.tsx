/**
 * Settings → Sharing & Households.
 *
 * One screen for both ways somebody else can see your money, shown as what they
 * actually are — because they are genuinely different things and a screen that
 * blurred them would be lying:
 *
 *   SHARED WITH A PERSON   One account, one named person. They see the same
 *                          balance and the same transactions you do. It stays
 *                          yours, it stays in your totals and only your totals,
 *                          and either of you can end it without deleting a thing.
 *
 *   A HOUSEHOLD            A standing group with a shared picture of its own.
 *                          What goes into it is counted once, from every member,
 *                          and everyone's private accounts stay private.
 *
 * Nothing on this screen creates, copies or moves a financial row. Every control
 * here either sets one column on a record that already exists, or makes and ends
 * a grant beside it. That is why the copy can promise, everywhere, that nothing
 * is ever deleted by un-sharing, leaving, revoking or closing.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { sharesDS, householdsDS } from '../../services/dataService';
import { RECORD_LABEL, PERMISSION_LABEL, PERMISSION_DESCRIPTION } from '../../utils/sharing';
import type { SharePermission } from '../../types';
import HouseholdSection from './HouseholdSection';
import Card from '../common/Card';
import Button from '../common/Button';
import Modal from '../common/Modal';
import Input from '../common/Input';

export default function SharingSection() {
  // Subscribed rather than read: the lists below come from sharesDS, and naming
  // these here is what re-renders the screen the instant a grant or code changes.
  const { recordShares, shareCodes, households } = useStore();
  void recordShares; void shareCodes;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [confirm, setConfirm] = useState<
    { kind: 'revoke'; grantId: string; who: string; what: string } |
    { kind: 'leave'; grantId: string; from: string; what: string } |
    null
  >(null);

  // Both halves are agreements with other people, so their truth is the
  // server's: a partner may have revoked something from their own device since
  // this cache was written.
  useEffect(() => { void sharesDS.refresh(); }, []);

  const { totals, given, held } = sharesDS.overview();

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await action();
      if (success) setNotice(success);
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } }; message?: string })
        ?.response?.data?.error ?? (err as Error)?.message ?? 'Something went wrong.';
      setError(typeof message === 'string' ? message : 'Something went wrong.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  /**
   * One box for any code somebody sends you.
   *
   * A household link and a share code are different things, but nobody pasting
   * one knows or should have to care which they were sent. So both are tried,
   * household first, and whichever it turns out to be is what happens. Neither
   * attempt can do any harm: a wrong code simply isn't found.
   */
  const redeemAnything = () => run(async () => {
    const code = joinCode.trim();
    if (!code) throw new Error('Paste the code they sent you.');
    try {
      const household = await householdsDS.joinByCode(code);
      setJoinOpen(false); setJoinCode('');
      setNotice(`You've joined ${household?.name ?? 'the household'}.`);
      return;
    } catch {
      // Not a household link — try it as a share code before giving up.
    }
    const result = await sharesDS.redeem(code);
    setJoinOpen(false); setJoinCode('');
    setNotice(result.already
      ? 'You already had access to that.'
      : "Done — it's in your accounts now, marked as theirs.");
  });

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`text-sm rounded-xl px-4 py-3 ${error
          ? 'bg-[#fdeaea] dark:bg-[#3a1f1f] text-[#ef4444]'
          : 'bg-[#eaf5ea] dark:bg-[#1f3a1f] text-[#22a06b]'}`}>
          {error ?? notice}
        </div>
      )}

      {/* ── The headline ──────────────────────────────────────────────────── */}
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold mb-1">Sharing</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Sharing shows somebody an account you already have. It never moves it,
              copies it, or hands it over — and nothing anybody shares with you is
              ever counted as yours.
            </p>
          </div>
          <Button variant="primary" onClick={() => setJoinOpen(true)}>Join with a code</Button>
        </div>

        {(totals.recordsIShare > 0 || totals.recordsSharedWithMe > 0 || totals.households > 0) && (
          <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800
            grid grid-cols-3 gap-3 text-center">
            <Stat n={totals.recordsIShare} label={totals.recordsIShare === 1 ? 'thing you share' : 'things you share'} />
            <Stat n={totals.recordsSharedWithMe} label={totals.recordsSharedWithMe === 1 ? 'shared with you' : 'shared with you'} />
            <Stat n={totals.households} label={totals.households === 1 ? 'household' : 'households'} />
          </div>
        )}
      </Card>

      {/* ── What I've shared, and who with ────────────────────────────────── */}
      <Card>
        <h3 className="font-semibold mb-1">Shared with people</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          One entry per account, however many people can see it — because it is one
          account. Sharing an account shares its transactions too: they are what
          the balance means.
        </p>

        {given.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            You haven't shared anything with anyone yet. Use the Share button on an
            account to send somebody a code.
          </p>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {given.map(view => (
              <div key={`${view.type}:${view.recordId}`} className="py-3">
                <p className="text-sm font-medium">{view.label}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                  {RECORD_LABEL[view.type]} · still yours, still only in your totals
                </p>

                {view.people.map(p => (
                  <div key={p.grantId} className="flex items-center justify-between gap-3 py-1.5">
                    <div className="min-w-0">
                      <p className="text-sm truncate">{p.name}</p>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {PERMISSION_LABEL[p.permission]} — {PERMISSION_DESCRIPTION[p.permission]}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        disabled={busy}
                        onClick={() => run(
                          () => sharesDS.setPermission(
                            p.grantId, (p.permission === 'view' ? 'edit' : 'view') as SharePermission),
                          'Updated.',
                        )}
                        className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-brand hover:underline"
                      >
                        {p.permission === 'view' ? 'Let them edit' : 'View only'}
                      </button>
                      <Button variant="danger" disabled={busy}
                        onClick={() => setConfirm({
                          kind: 'revoke', grantId: p.grantId, who: p.name, what: view.label,
                        })}>
                        Stop sharing
                      </Button>
                    </div>
                  </div>
                ))}

                {view.pendingCodes.map(code => (
                  <div key={code.id} className="flex items-center justify-between gap-3 py-1.5">
                    <div className="min-w-0">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Link not used yet · {PERMISSION_LABEL[code.permission].toLowerCase()}
                      </p>
                      <code className="block text-[11px] break-all select-all
                        text-zinc-400 dark:text-zinc-500">{code.code}</code>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => { void navigator.clipboard?.writeText(code.code); }}
                        className="text-xs text-brand hover:underline"
                      >
                        Copy
                      </button>
                      <Button variant="secondary" disabled={busy}
                        onClick={() => run(() => sharesDS.revokeCode(code.id), 'Link withdrawn.')}>
                        Withdraw
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── What's been shared with me ────────────────────────────────────── */}
      {held.length > 0 && (
        <Card>
          <h3 className="font-semibold mb-1">Shared with you</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
            These belong to the people who shared them. You see the same balance they
            do, and none of it counts towards your net worth — because it isn't yours.
          </p>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {held.map(view => (
              <div key={view.grant.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{view.label}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {RECORD_LABEL[view.type]} · shared by {view.from} · {PERMISSION_LABEL[view.permission].toLowerCase()}
                  </p>
                </div>
                <Button variant="secondary" disabled={busy}
                  onClick={() => setConfirm({
                    kind: 'leave', grantId: view.grant.id, from: view.from, what: view.label,
                  })}>
                  Remove from my view
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Households ────────────────────────────────────────────────────── */}
      <div className="pt-2">
        <h3 className="font-semibold mb-1">Households</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          A household is a group with a shared picture of its own — a couple, a
          family, an investment group. You can be in as many as you like, and each
          one only ever shows what its members have put into it.
          {households.length === 0 && ' Someone sent you a code? Use “Join with a code” above.'}
        </p>
        <HouseholdSection />
      </div>

      {/* ── Join with a code ──────────────────────────────────────────────── */}
      <Modal
        isOpen={joinOpen}
        onClose={() => { setJoinOpen(false); setJoinCode(''); }}
        title="Join with a code"
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setJoinOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !joinCode.trim()} onClick={redeemAnything}>
              Use code
            </Button>
          </div>
        }
      >
        <Input
          label="Code"
          placeholder="Paste it here"
          value={joinCode}
          onChange={e => setJoinCode(e.target.value)}
          hint="Works for both kinds: a household invite link, or a code for one account somebody shared with you."
        />
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Nothing of yours is shared by using a code. It only ever adds something to
          what you can see.
        </p>
      </Modal>

      {/* ── Ending access ─────────────────────────────────────────────────── */}
      <Modal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'revoke'
          ? `Stop sharing ${confirm.what} with ${confirm.who}?`
          : confirm?.kind === 'leave'
            ? `Remove ${confirm.what} from your view?`
            : ''}
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="danger" disabled={busy}
              onClick={() => confirm && run(
                () => sharesDS.end(confirm.grantId).then(r => {
                  if (!r.ok) throw new Error(r.error ?? 'Could not do that.');
                }),
                confirm.kind === 'revoke' ? 'They can no longer see it.' : 'Removed from your view.',
              )}>
              {confirm?.kind === 'revoke' ? 'Stop sharing' : 'Remove'}
            </Button>
          </div>
        }
      >
        {/* Both say the same true thing: access ends, nothing is deleted. */}
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {confirm?.kind === 'revoke' && (
            <>It disappears from their screen, along with the transactions on it.
            Your account is untouched — same balance, same history, still yours. You
            can share it again any time.</>
          )}
          {confirm?.kind === 'leave' && (
            <>It disappears from your screen. Nothing of {confirm.from}'s is deleted
            or changed, and they aren't told anything by this — you're just handing
            the access back.</>
          )}
        </p>
      </Modal>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <p className="text-xl font-semibold amount">{n}</p>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</p>
    </div>
  );
}
