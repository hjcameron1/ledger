/**
 * Settings → Household.
 *
 * The one screen where a household is created, joined, staffed and closed. Every
 * figure it shows comes from rows that already belonged to its members and still
 * do — this screen can add a person and it can stamp a `household_id`, and that
 * is the whole of its power over anybody's money.
 *
 * Which is why the wording here is careful in exactly one direction: removing a
 * member, leaving and deleting the household all do the SAME safe thing —
 * shared rows revert to personal, owned by whoever owned them all along. The
 * copy says so, because a screen that reads like it might delete a partner's
 * savings is a screen people won't use.
 */
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { householdsDS, householdReportDS, sharingDS } from '../../services/dataService';
import { ROLE_LABEL, ROLE_DESCRIPTION } from '../../utils/household';
import type { HouseholdRole } from '../../types';
import Card from '../common/Card';
import Button from '../common/Button';
import Modal from '../common/Modal';
import Input, { Select } from '../common/Input';
import { formatCurrency } from '../../utils/format';

const ASSIGNABLE: HouseholdRole[] = ['admin', 'member', 'viewer'];

/** What each shareable entity is called on screen, and in what order. */
const ENTITY_LABELS: [keyof ReturnType<typeof sharingDS.summary>, string][] = [
  ['account', 'Bank accounts'],
  ['card', 'Credit cards'],
  ['transaction', 'Transactions'],
  ['loan', 'Loans'],
  ['property', 'Properties'],
  ['budget', 'Budgets'],
  ['goal', 'Goals'],
];

export default function HouseholdSection() {
  const { user, households, householdMembers, householdInvitations, activeHouseholdId } = useStore();
  const currency = user?.currency_preference ?? 'AUD';

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<HouseholdRole>('member');
  const [confirm, setConfirm] = useState<
    { kind: 'remove'; memberId: string; name: string } |
    { kind: 'leave' } |
    { kind: 'delete' } |
    { kind: 'transfer'; memberId: string; name: string } |
    null
  >(null);

  // The server owns a household's truth — it is shared with other people — so
  // this screen asks for it on open rather than trusting a cache a partner may
  // have changed from their own device since.
  useEffect(() => { void householdsDS.refresh(); }, []);

  const current = householdsDS.current();
  const myInvites = householdsDS.myInvitations();
  const outgoing = householdsDS.outgoingInvitations();
  const report = current ? householdReportDS.build(current.household.id) : null;
  const summary = current ? sharingDS.summary(current.household.id) : null;

  /** Run a server action, showing whatever it refuses with rather than swallowing it. */
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

  const memberName = (m: { name?: string | null; email?: string | null; user_id: string }) =>
    m.name || m.email || (m.user_id === user?.id ? 'You' : 'Member');

  return (
    <div className="space-y-4">
      {(error || notice) && (
        <div className={`text-sm rounded-xl px-4 py-3 ${error
          ? 'bg-[#fdeaea] dark:bg-[#3a1f1f] text-[#ef4444]'
          : 'bg-[#eaf5ea] dark:bg-[#1f3a1f] text-[#22a06b]'}`}>
          {error ?? notice}
        </div>
      )}

      {/* ── Invitations waiting for this user ─────────────────────────────── */}
      {myInvites.length > 0 && (
        <Card>
          <h3 className="font-semibold mb-1">You've been invited</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
            Joining lets you see what the household shares. Nothing of yours is shared
            until you choose to share it.
          </p>
          {myInvites.map(inv => {
            const name = households.find(h => h.id === inv.household_id)?.name ?? 'a household';
            return (
              <div key={inv.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    as {ROLE_LABEL[inv.role].toLowerCase()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" disabled={busy}
                    onClick={() => run(() => householdsDS.declineInvite(inv.code), 'Invitation declined.')}>
                    Decline
                  </Button>
                  <Button variant="primary" disabled={busy}
                    onClick={() => run(() => householdsDS.acceptInvite(inv.code), `You've joined ${name}.`)}>
                    Join
                  </Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {/* ── No household yet ──────────────────────────────────────────────── */}
      {!current && (
        <Card>
          <h3 className="font-semibold mb-1">Household</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            Share the money you want to share — a joint account, the mortgage, the
            grocery budget — and keep everything else to yourself. Sharing shows
            somebody an account you already have; it never moves it, copies it, or
            hands it over.
          </p>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>Create a household</Button>
        </Card>
      )}

      {current && (
        <>
          {/* ── The household ─────────────────────────────────────────────── */}
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{current.household.name}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  You're the {ROLE_LABEL[current.role ?? 'member'].toLowerCase()}
                  {' · '}{current.members.length} {current.members.length === 1 ? 'person' : 'people'}
                </p>
              </div>
              {current.can.invite && (
                <Button variant="primary" onClick={() => setInviteOpen(true)}>Invite someone</Button>
              )}
            </div>

            {report && (
              <div className="mt-5 pt-5 border-t border-zinc-200 dark:border-zinc-800">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Shared net worth</p>
                <p className="text-2xl font-semibold amount mt-1">
                  {formatCurrency(report.total.net_worth, currency)}
                </p>
                {/* The breakdown is the proof, not decoration: every shared row has
                    one owner, so these add up to the total above with nothing
                    counted twice. `reconciliation` is that difference. */}
                <div className="mt-3 space-y-1">
                  {report.members.map(m => (
                    <div key={m.userId} className="flex justify-between text-sm">
                      <span className="text-zinc-600 dark:text-zinc-300">
                        {m.name || m.email || 'Member'}{m.isYou && ' (you)'}
                      </span>
                      <span className="amount">{formatCurrency(m.netWorth.net_worth, currency)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-3">
                  Only what's been shared. Everyone's private accounts, investments
                  and super stay out of this — and out of everybody else's screen.
                  {report.reconciliation !== 0 && (
                    <span className="text-[#f59e0b]">
                      {' '}Doesn't add up — off by {formatCurrency(report.reconciliation, currency)}.
                    </span>
                  )}
                </p>
              </div>
            )}
          </Card>

          {/* ── People ────────────────────────────────────────────────────── */}
          <Card>
            <h3 className="font-semibold mb-3">People</h3>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {current.members.map(v => (
                <div key={v.member.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {memberName(v.member)}{v.isYou && ' (you)'}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {ROLE_DESCRIPTION[v.role]}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {v.canChangeRole ? (
                      <Select
                        value={v.role}
                        options={ASSIGNABLE.map(r => ({ value: r, label: ROLE_LABEL[r] }))}
                        onChange={e => run(
                          () => householdsDS.setRole(current.household.id, v.member.id, e.target.value),
                          'Role updated.',
                        )}
                      />
                    ) : (
                      <span className="text-xs px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                        {ROLE_LABEL[v.role]}
                      </span>
                    )}
                    {v.canMakeOwner && (
                      <Button variant="secondary" disabled={busy}
                        onClick={() => setConfirm({ kind: 'transfer', memberId: v.member.id, name: memberName(v.member) })}>
                        Make owner
                      </Button>
                    )}
                    {v.canRemove && (
                      <Button variant="danger" disabled={busy}
                        onClick={() => setConfirm({ kind: 'remove', memberId: v.member.id, name: memberName(v.member) })}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {outgoing.length > 0 && (
              <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">Invited, not joined yet</p>
                {outgoing.map(inv => (
                  <div key={inv.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-sm truncate">{inv.email}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400">{ROLE_LABEL[inv.role]}</span>
                      {current.can.invite && (
                        <Button variant="secondary" disabled={busy}
                          onClick={() => run(
                            () => householdsDS.revokeInvite(current.household.id, inv.id),
                            'Invitation withdrawn.',
                          )}>
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── What's shared ─────────────────────────────────────────────── */}
          {summary && (
            <Card>
              <h3 className="font-semibold mb-1">What's shared</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
                Share or un-share anything from its own screen. Un-sharing takes it
                back out of the household view and changes nothing about the account
                itself.
              </p>
              <div className="space-y-1.5">
                {ENTITY_LABELS.map(([key, label]) => {
                  const s = summary[key];
                  return (
                    <div key={key} className="flex justify-between text-sm">
                      <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
                      <span className="text-zinc-500 dark:text-zinc-400">
                        {s.householdTotal === 0
                          ? <span className="text-zinc-400">none shared</span>
                          : <>{s.householdTotal} shared{s.sharedByMe > 0 && ` · ${s.sharedByMe} yours`}</>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* ── Leaving and closing ───────────────────────────────────────── */}
          <Card>
            <h3 className="font-semibold mb-1">Leaving</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
              Whatever you've shared becomes personal again — still yours, every
              cent of it. Nothing you own is ever deleted by leaving, and nothing
              anybody else owns is affected.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm({ kind: 'leave' })}>
                Leave household
              </Button>
              {current.can.delete && (
                <Button variant="danger" disabled={busy} onClick={() => setConfirm({ kind: 'delete' })}>
                  Delete household
                </Button>
              )}
            </div>
          </Card>
        </>
      )}

      {/* ── Create ────────────────────────────────────────────────────────── */}
      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setNewName(''); }}
        title="Create a household"
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !newName.trim()}
              onClick={() => run(async () => {
                await householdsDS.create(newName.trim());
                setCreateOpen(false); setNewName('');
              }, 'Household created. Invite someone to share with.')}>
              Create
            </Button>
          </div>
        }
      >
        <Input
          label="Name"
          placeholder="Ada & Bo"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          hint="Just a label — you'll be the owner, and nothing is shared until you share it."
        />
      </Modal>

      {/* ── Invite ────────────────────────────────────────────────────────── */}
      <Modal
        isOpen={inviteOpen}
        onClose={() => { setInviteOpen(false); setInviteEmail(''); }}
        title="Invite someone"
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !inviteEmail.includes('@')}
              onClick={() => run(async () => {
                await householdsDS.invite(current!.household.id, inviteEmail.trim(), inviteRole);
                setInviteOpen(false); setInviteEmail('');
              }, 'Invitation sent.')}>
              Send invitation
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Input
            label="Email"
            type="email"
            placeholder="partner@example.com"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            hint="They'll need to accept it from this same email address."
          />
          <Select
            label="Role"
            value={inviteRole}
            options={ASSIGNABLE.map(r => ({ value: r, label: ROLE_LABEL[r] }))}
            onChange={e => setInviteRole(e.target.value as HouseholdRole)}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{ROLE_DESCRIPTION[inviteRole]}</p>
        </div>
      </Modal>

      {/* ── Confirmations ─────────────────────────────────────────────────── */}
      <Modal
        isOpen={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === 'remove'   ? `Remove ${confirm.name}?` :
          confirm?.kind === 'transfer' ? `Make ${confirm.name} the owner?` :
          confirm?.kind === 'leave'    ? 'Leave this household?' :
          confirm?.kind === 'delete'   ? 'Delete this household?' : ''
        }
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant={confirm?.kind === 'transfer' ? 'primary' : 'danger'}
              disabled={busy}
              onClick={() => {
                if (!confirm || !current) return;
                const id = current.household.id;
                if (confirm.kind === 'remove') {
                  run(() => householdsDS.removeMember(id, confirm.memberId), `${confirm.name} has been removed.`);
                } else if (confirm.kind === 'transfer') {
                  run(() => householdsDS.transfer(id, confirm.memberId), `${confirm.name} is now the owner.`);
                } else if (confirm.kind === 'leave') {
                  run(() => householdsDS.leave(id), "You've left the household.");
                } else {
                  run(() => householdsDS.remove(id), 'Household deleted.');
                }
              }}
            >
              {confirm?.kind === 'remove'   ? 'Remove' :
               confirm?.kind === 'transfer' ? 'Make owner' :
               confirm?.kind === 'leave'    ? 'Leave' : 'Delete'}
            </Button>
          </div>
        }
      >
        {/* Every one of these says the same true thing in different words: no
            money moves, and nothing is deleted. */}
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {confirm?.kind === 'remove' && (
            <>They'll stop seeing what the household shares, and anything they shared
            becomes personal to them again — still theirs, in full. Nothing of theirs
            is deleted, and nothing of yours changes.</>
          )}
          {confirm?.kind === 'transfer' && (
            <>They'll be able to invite, remove and change roles. You'll stay in the
            household as an admin.</>
          )}
          {confirm?.kind === 'leave' && (
            <>Anything you've shared becomes personal again — still yours, every cent.
            You'll stop seeing what the others share.</>
          )}
          {confirm?.kind === 'delete' && (
            <>The household goes; the money doesn't. Every shared account, loan,
            property, budget and goal becomes personal again, owned by whoever owned
            it all along.</>
          )}
        </p>
      </Modal>
    </div>
  );
}
