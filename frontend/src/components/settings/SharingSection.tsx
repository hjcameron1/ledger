/**
 * Settings → Households.
 *
 * A household is a standing group with a shared picture of its own — a couple, a
 * family, an investment group. What a member puts into it is counted once, from
 * every member, and everyone's private accounts stay private. You can be in as
 * many as you like, and this is where they're created, joined, staffed and
 * switched between.
 *
 * Direct account sharing — showing one bank account or credit card to one named
 * person by a pairing code — does NOT live here any more. It lives on the account
 * itself: open an account or card and share it from there. This screen is only
 * about households, plus the one control that belongs to both: the My Finances ↔
 * household view switch (inside HouseholdSection), which used to float over every
 * page and now has a single home.
 *
 * Nothing on this screen creates, copies or moves a financial row. Joining,
 * leaving, or closing a household only ever changes who can SEE a row — never how
 * many there are, and never whose they are.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { sharesDS, householdsDS } from '../../services/dataService';
import HouseholdSection from './HouseholdSection';
import Card from '../common/Card';
import Button from '../common/Button';
import Modal from '../common/Modal';
import Input from '../common/Input';

export default function SharingSection() {
  const { households } = useStore();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');

  // Households are shared with other people, so their truth is the server's: a
  // partner may have changed something from their own device since this cache was
  // written. Grants are refreshed too, so a code redeemed here lands cleanly.
  useEffect(() => { void householdsDS.refresh(); void sharesDS.refresh(); }, []);

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
    }
  }

  /**
   * One box for any code somebody sends you.
   *
   * A household join link and an account share code are different things, but
   * nobody pasting one knows or should have to care which. Both are tried,
   * household first, and whichever it turns out to be is what happens. Neither
   * attempt can do harm: a wrong code simply isn't found.
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
      // Not a household link — try it as an account share code before giving up.
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
      {/* The button sits on its OWN line under the copy, not squeezed beside it —
          on a narrow column a side-by-side button wraps its label into a cramped
          square. Full-width row gives it room to be a proper rectangle. */}
      <Card>
        <div>
          <h3 className="font-semibold mb-1">Households</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            A household is a group with a shared picture of its own — a couple, a
            family, an investment group. You can be in as many as you like, and each
            one only ever shows what its members have put into it.
            {households.length === 0 && ' Been sent a code? Use “Join with a code”.'}
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2">
            To share a single account or card with one person, open it from the
            Accounts page and use its Sharing panel — that's where pairing codes live.
          </p>
        </div>
        <div className="mt-4">
          <Button variant="primary" onClick={() => setJoinOpen(true)}>
            <span className="whitespace-nowrap">Join with a code</span>
          </Button>
        </div>
      </Card>

      {/* ── Households (create / switch / staff / leave) ──────────────────── */}
      <HouseholdSection />

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
          hint="Works for either kind: a household code, or a code for one account somebody shared with you."
        />
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Nothing of yours is shared by using a code. It only ever adds something to
          what you can see.
        </p>
      </Modal>
    </div>
  );
}
