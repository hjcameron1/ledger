/**
 * Settings → Sharing & Households → the households half.
 *
 * The one screen where a household is created, joined, staffed and closed. Every
 * figure it shows comes from rows that already belonged to its members and still
 * do — this screen can add a person and it can share a row into the household,
 * and that
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
import LinkedDocuments from '../common/LinkedDocuments';
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
  ['investment', 'Investments'],
  ['income', 'Income'],
  ['bill', 'Bills & reminders'],
];

export default function HouseholdSection() {
  const { user, households, householdMembers, householdInvitations, activeHouseholdId, financeScope } = useStore();
  const currency = user?.currency_preference ?? 'AUD';

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
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

  // The settings screen mirrors the pill the user picked, exactly as the rest of
  // the app does: on "My Finances" it shows their own finances and NO household
  // detail; on a household it shows that household. Managing a household is done
  // by selecting it — the same act that points the whole ledger at it.
  const showingHousehold = financeScope === 'household';
  const mine = householdsDS.mine();
  const current = showingHousehold ? householdsDS.current() : null;
  const myInvites = householdsDS.myInvitations();
  const outgoing = householdsDS.outgoingInvitations();
  const report = current ? householdReportDS.build(current.household.id) : null;
  const summary = current ? sharingDS.summary(current.household.id) : null;
  // Phase 7.2 — this month's shared spending, per member: paid vs responsible.
  const spending = current ? sharingDS.memberSpending(current.household.id) : null;
  const spendingTotal = spending?.reduce((s, m) => s + m.responsible, 0) ?? 0;

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

      {/* ── Which household ───────────────────────────────────────────────── */}
      {/* A person can be in several — a couple, a family, an investment group —
          and each is its own picture with its own totals. So they are switched
          between, never merged: a combined "all my households" figure would
          double-count anybody who is in two of them with the same partner. */}
      {/* The one place the My Finances / household switch lives now — it used to
          float over every page. "My Finances" is everything you own (shared or
          not); each household is only what its members put into it, counted once.
          The rest of this screen keeps showing the active household for you to
          manage even while you're viewing your own finances. */}
      {mine.length >= 1 && (
        <div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
            Viewing across the app
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => householdsDS.switchTo(null)}
              aria-pressed={financeScope === 'personal'}
              title="Everything you own, shared or not"
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors
                ${financeScope === 'personal'
                  ? 'bg-brand text-white'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'}`}
            >
              My Finances
            </button>
            {mine.map(h => (
              <button
                key={h.household.id}
                onClick={() => householdsDS.switchTo(h.household.id)}
                aria-pressed={financeScope === 'household' && h.isActive}
                title="Only what this household shares — private accounts stay private"
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors max-w-[200px] truncate
                  ${financeScope === 'household' && h.isActive
                    ? 'bg-brand text-white'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'}`}
              >
                {h.household.name}
                <span className="ml-1.5 opacity-70">{h.memberCount}</span>
              </button>
            ))}
            <button
              onClick={() => setCreateOpen(true)}
              className="px-3 py-1.5 rounded-full text-xs font-medium border border-dashed
                border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400
                hover:border-brand hover:text-brand"
            >
              + New
            </button>
          </div>
        </div>
      )}

      {/* ── No household yet ──────────────────────────────────────────────── */}
      {mine.length === 0 && (
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

      {/* ── Viewing My Finances, but households exist ─────────────────────── */}
      {/* The whole app — and this screen — is on the user's own finances. A
          household is only shown once it's the one selected above, so what's on
          screen always matches what the rest of the ledger is showing. */}
      {mine.length >= 1 && !showingHousehold && (
        <Card>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            You're viewing <span className="font-medium text-zinc-700 dark:text-zinc-200">My Finances</span> —
            everything you own, shared or not. Pick a household above to view and
            manage it.
          </p>
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
                <div className="flex gap-2 shrink-0">
                  <Button variant="primary" onClick={() => setLinkOpen(true)}>Invite with a code</Button>
                </div>
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

          {/* ── The household's own paperwork ─────────────────────────────── */}
          {/* A document can be filed against a HOUSEHOLD, the same way one can be
              filed against an account or a loan — the lease, the strata notice,
              the policy that belongs to the group rather than to one person. That
              link had no home to be read from until now: this is that end of it.
              Everything ELSE the household can see (documents shared into it, and
              documents filed against what it shares) is on the Documents page with
              this household selected — one place per question, not two. */}
          <Card>
            <h3 className="font-semibold mb-1">Documents</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
              Filed against {current.household.name} itself. Paperwork shared into the
              household, or filed against something it shares, is on the Documents page
              while this household is the view.
            </p>
            <LinkedDocuments
              linkedType="household"
              linkedId={current.household.id}
              title="Filed against this household"
              emptyText="Nothing filed against the household itself yet — upload it in Documents and link it to this household." />
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

          {/* ── Spending by member (Phase 7.2) ────────────────────────────── */}
          {/* Two columns per person, deliberately: PAID is who handed over the
              money, RESPONSIBLE is whose spending it was — the split feature
              exists exactly because those differ. Both columns total the same
              number, so the net positions always sum to zero: a statement about
              the shared rows, never a recorded debt. */}
          {spending && spending.length > 0 && spendingTotal !== 0 && (
            <Card>
              <h3 className="font-semibold mb-1">Spending by member</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
                This month's shared spending — what each person paid for, next to
                the share that was theirs. Set it per transaction with "Who paid
                &amp; split". Reporting only: no balance moves and nothing is owed
                or recorded against anyone.
              </p>
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 text-sm items-baseline">
                <span />
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 text-right">Paid</span>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 text-right">Their share</span>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 text-right">Difference</span>
                {spending.map(m => (
                  <div key={m.userId} className="contents">
                    <span className="text-zinc-600 dark:text-zinc-300 truncate">
                      {m.name || m.email || 'Member'}{m.isYou && ' (you)'}
                      {!m.isMember && <span className="text-zinc-400"> · no longer in household</span>}
                    </span>
                    <span className="amount text-right">{formatCurrency(m.paid, currency)}</span>
                    <span className="amount text-right">{formatCurrency(m.responsible, currency)}</span>
                    <span className={`amount text-right ${m.net > 0.004 ? 'text-[#22a06b]' : m.net < -0.004 ? 'text-[#f59e0b]' : 'text-zinc-400'}`}>
                      {m.net > 0.004 ? '+' : ''}{formatCurrency(m.net, currency)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-3">
                {formatCurrency(spendingTotal, currency)} shared spending this month.
                A positive difference means they covered more than their share.
              </p>
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
            <div className="flex gap-2 flex-wrap">
              {mine.length === 1 && (
                <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                  Create another
                </Button>
              )}
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
              }, 'Household created. Now invite someone with a code.')}>
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

      {/* ── The standing invite link ──────────────────────────────────────── */}
      {/* The other half of getting somebody in. An invitation names one address;
          a link names nobody, so whoever holds it joins — which is why it hands
          out the household's `join_role` and never anything more, and why
          rotating it invalidates the old one in the same single write. */}
      <Modal
        isOpen={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Invite with a code"
        size="sm"
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setLinkOpen(false)}>Done</Button>
            {current?.household.join_code && (
              <Button variant="danger" disabled={busy}
                onClick={() => run(
                  () => householdsDS.revokeJoinCode(current.household.id),
                  'Code switched off. Everyone already in stays in.',
                )}>
                Switch it off
              </Button>
            )}
            <Button variant="primary" disabled={busy}
              onClick={() => run(
                () => householdsDS.regenerateJoinCode(current!.household.id),
                current?.household.join_code ? 'New code created. The old one no longer works.' : 'Code created.',
              )}>
              {current?.household.join_code ? 'New code' : 'Create code'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Anyone with this code can join as a {ROLE_LABEL[(current?.household.join_role ?? 'member') as HouseholdRole].toLowerCase()}.
            Nothing of yours is shared by them joining — you still choose what goes
            into the household.
          </p>
          {current?.household.join_code ? (
            <>
              <code className="block w-full px-3 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800
                text-xs break-all select-all">{current.household.join_code}</code>
              <button
                onClick={() => { void navigator.clipboard?.writeText(current.household.join_code!); }}
                className="text-xs text-brand hover:underline"
              >
                Copy code
              </button>
            </>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              There's no code at the moment. Creating one lets people join without
              you knowing their email address.
            </p>
          )}
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
