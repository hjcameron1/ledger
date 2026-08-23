/**
 * The owner's approval inbox, surfaced as a modal the moment they're signed in.
 *
 * A household member with an editing role changed — or removed — something of
 * this user's that was shared into the household. The household already sees
 * the member's version (an edit renders as an overlay in the household view; a
 * delete already took the row out of that household). THE OWNER'S OWN RECORD
 * HAS NOT MOVED. This modal asks the only question left: should it?
 *
 *   Apply / Delete it  → the member's change becomes the owner's record too,
 *                        and the two views converge again.
 *   Keep mine          → the owner's record stays exactly as it is. For an
 *                        edit, the household keeps seeing ITS version — that
 *                        divergence is the agreed outcome, not an error. If the
 *                        owner later un-shares and re-shares the row, they'll
 *                        be asked which version to share.
 *
 * Mounted once in App (like AlertNotifier); checks on login, on tab focus, and
 * on a slow heartbeat — the same cadence shared data refreshes on. The same
 * question also goes out on Telegram with Apply/Keep buttons; whichever side
 * answers first wins, and the other finds the request gone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { householdsApi } from '../../services/api';
import { bootstrapData } from '../../services/dataService';
import Modal from './Modal';
import type { HouseholdChangeRequest, ShareRecordType } from '../../types';

const NOUN: Record<ShareRecordType, string> = {
  account: 'bank account', card: 'credit card', transaction: 'transaction',
  loan: 'loan', property: 'property', budget: 'budget', goal: 'goal',
  investment: 'investment', income: 'income entry',
};

const prettyKey = (key: string) => key.replace(/_/g, ' ');
const prettyValue = (value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : String(value);

export default function HouseholdApprovals() {
  const user = useStore(s => s.user);
  const token = useStore(s => s.token);
  const [requests, setRequests] = useState<HouseholdChangeRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [snoozed, setSnoozed] = useState(false);
  const lastFetch = useRef(0);

  const refresh = useCallback(async (force = false) => {
    if (!force && Date.now() - lastFetch.current < 60_000) return;
    lastFetch.current = Date.now();
    try {
      const data = await householdsApi.changeRequests() as { requests?: HouseholdChangeRequest[] };
      setRequests(data.requests ?? []);
    } catch {
      // Offline or an old backend — nothing to ask right now. Never block login.
    }
  }, []);

  useEffect(() => {
    if (!user || !token) return;
    setSnoozed(false);
    void refresh(true);
    const onFocus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const timer = window.setInterval(onFocus, 5 * 60_000);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [user?.id, token, refresh]);

  // A new request arriving after a snooze re-opens the ask.
  const seenIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (requests.some(r => !seenIds.current.has(r.id))) setSnoozed(false);
    seenIds.current = new Set(requests.map(r => r.id));
  }, [requests]);

  const respond = async (request: HouseholdChangeRequest, accept: boolean) => {
    setBusy(request.id);
    try {
      await householdsApi.respondToChangeRequest(request.id, accept);
      setRequests(prev => prev.filter(r => r.id !== request.id));
      // An applied edit or delete changed real data — pull it fresh everywhere.
      if (accept) void bootstrapData();
    } catch {
      // Answered elsewhere (Telegram) or already gone — refresh tells the truth.
      void refresh(true);
    } finally {
      setBusy(null);
    }
  };

  if (!user || !token || snoozed || requests.length === 0) return null;

  return (
    <Modal
      isOpen
      onClose={() => setSnoozed(true)}
      title="Changes waiting for you"
      size="lg"
    >
      <div className="px-6 py-4 space-y-4 overflow-y-auto">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Someone in your household changed things you own. The household already
          sees their version — nothing on your side moves unless you say yes.
        </p>
        {requests.map(request => {
          const who = request.requested_by_name ?? 'A household member';
          const where = request.household_name ?? 'your household';
          const what = `${NOUN[request.record_type]}${request.record_label ? ` “${request.record_label}”` : ''}`;
          const keys = Object.keys(request.patch ?? {});
          return (
            <div
              key={request.id}
              className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3"
            >
              {request.kind === 'edit' ? (
                <>
                  <p className="text-sm text-zinc-800 dark:text-zinc-100">
                    <span className="font-medium">{who}</span> changed the {what} in{' '}
                    <span className="font-medium">{where}</span>.
                  </p>
                  <div className="mt-2 space-y-1">
                    {keys.map(key => (
                      <p key={key} className="text-xs text-zinc-600 dark:text-zinc-300">
                        <span className="capitalize">{prettyKey(key)}</span>:{' '}
                        <span className="line-through opacity-60">
                          {prettyValue(request.previous?.[key])}
                        </span>{' '}
                        → <span className="font-medium">{prettyValue(request.patch?.[key])}</span>
                      </p>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                    Apply it to your own account too? Saying no keeps yours as it
                    is — the household keeps seeing their version.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-zinc-800 dark:text-zinc-100">
                    <span className="font-medium">{who}</span> removed the {what} from{' '}
                    <span className="font-medium">{where}</span> and asked to delete
                    it from your account as well.
                  </p>
                  <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                    It's already out of the household view. Your own copy is
                    untouched until you say so — and deleting is permanent.
                  </p>
                </>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  disabled={busy === request.id}
                  onClick={() => respond(request, true)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50
                    ${request.kind === 'delete' ? 'bg-[#ef4444] hover:opacity-90' : 'bg-brand hover:opacity-90'}`}
                >
                  {request.kind === 'edit' ? 'Apply to my account' : 'Delete it for me too'}
                </button>
                <button
                  disabled={busy === request.id}
                  onClick={() => respond(request, false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 dark:text-zinc-200
                    border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  {request.kind === 'edit' ? 'Keep mine' : 'Keep it'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
