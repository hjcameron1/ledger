import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { beginIdempotentCreate, recoverIdempotentRace } from '../utils/idempotentCreate';
import { recordNetWorthSnapshot, getItemChanges, getAdjustedNwSeries, computeNetWorth } from '../services/netWorthSnapshot';
import { readPctHistory, pctWindowStart } from '../services/netWorthPctSeries';
import { nextOccurrence } from '../utils/recurrence';
import {
  classifyTransactionsAI, interpretAskQuestion, phraseAskAnswer,
  type AskVocabularyInput, type AskFigureInput,
} from '../services/claudeService';
// ── Phase 7.1: households ────────────────────────────────────────────────────
// Reads answer with the rows the user OWNS plus the rows SHARED with a household
// they're in — one row each, never a copy. Writes are checked against the row
// itself: your own always, somebody else's only when it's shared and your role
// can edit shared money. Deleting stays owner-only (see refuseDelete).
import {
  loadScope, scopedQuery, refuseWrite, refuseDelete, revokeGrantsFor,
  applyHouseholdShare, attachHouseholds, attachHouseholdsToOne,
  grantedAccountIds, grantedIds,
} from '../services/householdScope';
import { divertMemberEdit, divertMemberDelete } from '../services/householdChangeRequests';

/** Strip the sharing fields out of a body destined for a column update. Which
 *  households a row is in lives in `record_households`, not on the row, so these
 *  must never reach an INSERT/UPDATE — an unknown column fails the whole write. */
function withoutSharingFields(body: unknown): Record<string, unknown> {
  const {
    household_ids: _ids, household_id: _legacy,
    household_overlay_resolutions: _resolutions,
    ...rest
  } = (body ?? {}) as Record<string, unknown>;
  return rest;
}

const router = Router();
router.use(authenticate);

router.get('/net-worth', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const nw = await recordNetWorthSnapshot(userId);

  res.json({
    net_worth: nw.netWorth,
    bank_balance: nw.bankBalance,
    investments: nw.investments,
    credit_card_debt: nw.creditCardDebt,
    super: nw.super,
    property: nw.property,
    loans: nw.loans,
    currency: nw.currency,
  });
});

// Net-worth % change history for the Overview trend chart. The percentage is
// measured against the user's FIRST-EVER snapshot (0% baseline), so every
// timeframe shows the same cumulative series — the toggle just zooms the window.
//   ?timeframe = daily | weekly | monthly | yearly | all   (default: all)
//   daily  → intraday (hourly) rows from the last 24h
//   others → one point per day (latest of each day) within the window
router.get('/net-worth/pct-history', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const timeframe = String(req.query.timeframe ?? 'all');

  // On-demand snapshot (throttled to once/hour) so a point appears on load.
  try {
    const { data: latest } = await supabase
      .from('net_worth_history')
      .select('recorded_at')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    const lastAt = latest?.[0]?.recorded_at ? new Date(latest[0].recorded_at).getTime() : 0;
    if (Date.now() - lastAt > 55 * 60 * 1000) {
      await recordNetWorthSnapshot(userId);
    }
  } catch (err) {
    console.error('Net-worth snapshot (on-demand) failed:', err);
  }

  // The reading, the day-bucketing and the percentage all live in the service, so
  // the endpoint and the stress simulation exercise the same code rather than the
  // simulation checking a hand-written copy of it.
  const history = await readPctHistory(userId, timeframe);
  const startMs = pctWindowStart(timeframe, Date.now());

  // Structural-adjustment-aware series (newly added/removed items don't spike the
  // change). Derived from per-item history; the frontend toggle picks which to show.
  // Pass the LIVE item set so currentBase reconciles against what net worth is right
  // now (not the throttled last snapshot) — this is what stops an unhidden/added
  // account from spiking the headline before the next snapshot lands.
  let adjusted = null;
  try {
    const live = await computeNetWorth(userId);
    // …and the items the user has switched OFF, whose history is dropped from the
    // series entirely, so an excluded property/account/loan can't go on moving the
    // line after it stopped counting.
    adjusted = await getAdjustedNwSeries(
      userId, startMs, live.items,
      live.excludedItems.map(it => `${it.item_type}:${it.item_id}`),
    );
  } catch (err) {
    console.error('Adjusted net-worth series failed:', err);
  }

  res.json({
    timeframe,
    baseline: history.baseline,
    timezone: history.timezone,
    /** True only when the history is long enough that the row budget ran out; the
     *  missing points are the OLDEST ones, so the line starts late but is current. */
    truncated: history.truncated,
    points: history.points,
    adjusted,
  });
});

// Per-item net-worth change over a timeframe, for the breakdown popup. Sorted
// by biggest contribution to the net-worth change in the window.
//   ?timeframe = daily | weekly | monthly | sixmonth | yearly | all  (default: daily)
router.get('/net-worth/item-changes', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const timeframe = String(req.query.timeframe ?? 'daily');

  // On-demand snapshot (throttled to once/hour) so "current" is fresh on load.
  try {
    const { data: latest } = await supabase
      .from('net_worth_item_history')
      .select('recorded_at')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    const lastAt = latest?.[0]?.recorded_at ? new Date(latest[0].recorded_at).getTime() : 0;
    if (Date.now() - lastAt > 55 * 60 * 1000) {
      await recordNetWorthSnapshot(userId);
    }
  } catch (err) {
    console.error('Net-worth item snapshot (on-demand) failed:', err);
  }

  const { items, currency } = await getItemChanges(userId, timeframe);
  res.json({ timeframe, currency, items });
});

// The raw recorded rows. Ordered DESCENDING and reversed, so a bounded response is
// the most recent 365 days rather than the first 365 days a user ever recorded —
// which is what an ascending .limit(365) returns, and it never updates again.
router.get('/net-worth/history', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('net_worth_history')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('recorded_at', { ascending: false })
    .limit(365);

  res.json((data ?? []).slice().reverse());
});

// Bills
//
// Phase 7.2 — bills are shareable: a household bill is the SAME single row its
// owner already had, listed in `record_households` beside it. Reads answer with
// owned + household-shared rows; a member with an editing role can tick a shared
// bill paid or correct it (edits divert into a change request like every other
// entity); deleting stays owner-only. `responsible_user_id` names the member
// responsible for paying it — a reporting/reminder attribution that moves no
// money, exactly like its transaction namesake.
router.get('/bills', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(supabase.from('bills').select('*'), scope, 'bills')
    .eq('is_paid', false)
    .order('due_date', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(await attachHouseholds('bill', data ?? [], scope));
});

router.post('/bills', async (req: AuthRequest, res: Response) => {
  // Allowlist client-supplied fields (same guard as PUT — a raw spread would let
  // a stale offline payload 500 forever on an unknown column), then force the
  // server-owned user_id. Born personal — sharing is a separate act on the join.
  const fields: Record<string, unknown> = { ...pickBillFields(req.body), user_id: req.user!.userId, is_paid: false };
  const replay = await beginIdempotentCreate('bills', req.user!.userId, req.body, fields);
  if (replay) { res.status(200).json(replay); return; }

  const { data, error } = await supabase
    .from('bills')
    .insert(fields)
    .select()
    .single();

  if (error) {
    const raced = await recoverIdempotentRace('bills', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json(raced); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(201).json(data);
});

router.patch('/bills/:id/pay', async (req: AuthRequest, res: Response) => {
  // Fetch by id, not by owner: a household member with an editing role may tick a
  // shared bill off. refuseWrite answers 404 for anything they can't see and 403
  // for anything they can only look at, exactly as every other shared write does.
  const { data: bill } = await supabase
    .from('bills').select('*').eq('id', req.params.id).maybeSingle();
  if (!bill) { res.status(404).json({ error: 'Bill not found' }); return; }
  const payScope = await loadScope(req.user!.userId);
  const payRefusal = await refuseWrite('bills', req.params.id, payScope);
  if (payRefusal) { res.status(payRefusal.status).json({ error: payRefusal.error }); return; }

  await supabase
    .from('bills')
    .update({ is_paid: true, paid_at: new Date().toISOString().split('T')[0] })
    .eq('id', req.params.id);

  // Auto-create the next occurrence for recurring bills, rolled forward past ANY
  // number of missed periods to the first date that isn't already overdue (see
  // nextOccurrence). Advancing just one period left a multi-period-overdue bill
  // still overdue, so it re-surfaced and kept coming back on every tick-off. A
  // frequency we can't advance (irregular/unknown) returns null → mark paid and
  // create nothing; the user re-adds it when the next charge is known.
  const nextDue = bill.is_recurring ? nextOccurrence(bill.due_date, bill.frequency) : null;
  if (nextDue) {
    // A loan-linked mortgage/repayment bill is a PROJECTION of the loan's
    // schedule (loans.next_due_date), which the loan→bill mirror (syncLoanBill)
    // re-applies. If we don't advance the loan too, the mirror drags the bill
    // straight back to the old overdue date — the "still coming back" loop. So
    // keep exactly one live mirror: advance the loan, drop any stale unpaid
    // duplicates, then create the single new occurrence below.
    if (bill.loan_id) {
      // Keyed to the BILL's owner, not the caller: a household member ticking a
      // shared loan bill off must advance the owner's loan and clear the owner's
      // stale mirrors, not go hunting in their own account for rows that aren't
      // there.
      await supabase.from('loans')
        .update({ next_due_date: nextDue })
        .eq('id', bill.loan_id).eq('user_id', bill.user_id);
      await supabase.from('bills')
        .delete()
        .eq('user_id', bill.user_id)
        .eq('loan_id', bill.loan_id)
        .eq('is_paid', false);
    }

    // If the just-paid occurrence carried a one-off ("just this once") edit, its
    // canonical series values were snapshotted in recurring_template. The NEXT
    // occurrence reverts to those, and the template is cleared so the series is
    // back to normal. Older rows have no template → plain duplication (unchanged).
    const tmpl = bill.recurring_template ?? null;
    // Carry per-bill reminders forward, but reset each entry's last_sent so they
    // fire again for the new occurrence's due date.
    const nextReminders = Array.isArray(bill.reminders)
      ? bill.reminders.map((r: Record<string, unknown>) => ({ ...r, last_sent: null }))
      : bill.reminders;
    const { data: nextBill } = await supabase.from('bills').insert({
      ...bill, id: undefined, is_paid: false, paid_at: null,
      ...(tmpl ?? {}),
      reminders: nextReminders,
      recurring_template: null,
      due_date: nextDue,
      // The account assignment (account_id/account_type) carries forward — the next
      // occurrence is paid from the same account — but the just-paid occurrence's
      // transaction link must NOT: a fresh unpaid bill has recorded no payment yet.
      // (`responsible_user_id` rides the spread: the next occurrence is the same
      // member's responsibility until somebody says otherwise.)
      paid_transaction_id: null,
      created_at: undefined, updated_at: undefined,
    }).select('id').single();

    // A shared recurring bill stays shared: household memberships are keyed by
    // record id, and the next occurrence is a NEW row, so its memberships are
    // copied over — otherwise every tick-off would quietly un-share the series.
    if (nextBill?.id) {
      const { data: shares } = await supabase.from('record_households')
        .select('household_id, owner_user_id')
        .eq('record_type', 'bill').eq('record_id', bill.id);
      if (shares?.length) {
        const { error: shareError } = await supabase.from('record_households').insert(
          shares.map(s => ({
            record_type: 'bill', record_id: nextBill.id,
            household_id: s.household_id, owner_user_id: s.owner_user_id,
          })),
        );
        if (shareError) console.warn('[bills] carrying shares to next occurrence failed:', shareError.message);
      }
    }
  }

  res.json({ success: true });
});

// Only real bills columns may be written. A queued offline update can carry a
// stale/derived field (e.g. from an older app build); spreading req.body raw
// would let that 500 forever on retry. Whitelisting keeps recurring intact
// (is_recurring/frequency/recurring_template are all included) while dropping junk.
const BILL_COLUMNS = new Set([
  'name', 'amount', 'due_date', 'is_recurring', 'frequency', 'colour',
  'is_paid', 'paid_at', 'subscription_id', 'loan_id', 'calendar_synced',
  'kind', 'category', 'recurring_template', 'lead_days', 'original_name', 'auto_pay',
  'reminders',
  // Phase 3.4 — account-assigned bills.
  'account_id', 'account_type', 'paid_transaction_id',
  // Phase 7.2 — the household member responsible for a shared bill. A
  // reporting/reminder attribution only: it moves no money and never changes
  // whose row the bill is.
  'responsible_user_id',
]);

// UUID-typed bill columns: '' arrives from a form that means "unset", and
// Postgres rejects it as 22P02 — coerce to NULL (the transactions routes learned
// this one the hard way).
const BILL_UUID_FIELDS = new Set([
  'subscription_id', 'loan_id', 'account_id', 'paid_transaction_id', 'responsible_user_id',
]);

/** Keep only allowlisted, defined keys from an arbitrary request body. */
function pickBillFields(body: unknown): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (!BILL_COLUMNS.has(key) || src[key] === undefined) continue;
    out[key] = BILL_UUID_FIELDS.has(key) && src[key] === '' ? null : src[key];
  }
  return out;
}

router.put('/bills/:id', async (req: AuthRequest, res: Response) => {
  const updates = pickBillFields(req.body);
  updates.updated_at = new Date().toISOString();

  // Phase 7.2 — the same write discipline as every shareable entity: your own
  // bill always, somebody else's only when it's shared with a household where
  // your role can edit shared money — and then the edit DIVERTS into a change
  // request the owner answers, never straight onto their row.
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('bills', req.params.id, scope);
  if (refusal) {
    // A queued offline update for a row that no longer exists (e.g. a recurring
    // occurrence that was paid and advanced to a new id) must ack as a no-op so
    // the sync queue drains instead of retrying forever.
    if (refusal.status === 404) { res.json({ id: req.params.id, noop: true }); return; }
    res.status(refusal.status).json({ error: refusal.error }); return;
  }

  const shareRefusal = await applyHouseholdShare('bills', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const diverted = await divertMemberEdit('bills', req.params.id, scope, updates);
  if (diverted) { res.json(await attachHouseholdsToOne('bill', diverted, scope)); return; }

  const { data, error } = await supabase
    .from('bills')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[BILL PUT] Supabase error:', JSON.stringify(error), '| keys:', Object.keys(updates));
    res.status(500).json({ error: error.message, code: error.code });
    return;
  }
  // No matching row → nothing to update; ack so the offline queue can drain.
  res.json(data ? await attachHouseholdsToOne('bill', data, scope) : { id: req.params.id, noop: true });
});

router.delete('/bills/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  // A member deleting a shared bill un-shares it from their household and asks
  // the owner — the same diversion every other entity's delete makes.
  if (await divertMemberDelete('bills', req.params.id, scope)) {
    res.json({ success: true, diverted: true });
    return;
  }
  const refusal = await refuseDelete('bills', req.params.id, scope);
  if (refusal) {
    // Deleting something that's already gone is a success for the offline queue.
    if (refusal.status === 404) { res.json({ success: true }); return; }
    res.status(refusal.status).json({ error: refusal.error }); return;
  }
  await revokeGrantsFor('bills', req.params.id);
  await supabase.from('record_households').delete()
    .eq('record_type', 'bill').eq('record_id', req.params.id);
  await supabase.from('bills').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

// Goals
router.get('/goals', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(supabase.from('goals').select('*'), scope, 'goals');
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(await attachHouseholds('goal', data ?? [], scope));
});

router.post('/goals', async (req: AuthRequest, res: Response) => {
  // Born personal — sharing is a separate act against the join (see the PUT).
  const fields: Record<string, unknown> = { ...withoutSharingFields(req.body), user_id: req.user!.userId };
  const replay = await beginIdempotentCreate('goals', req.user!.userId, req.body, fields);
  if (replay) { res.status(200).json(replay); return; }

  const { data, error } = await supabase
    .from('goals')
    .insert(fields)
    .select().single();
  if (error) {
    const raced = await recoverIdempotentRace('goals', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json(raced); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(201).json(data);
});

router.put('/goals/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('goals', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('goals', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const goalFields = { ...withoutSharingFields(req.body), updated_at: new Date().toISOString() };

  // A household member's edit never lands on the owner's row: it becomes a
  // change request whose patch the household view shows, and the owner is asked.
  const divertedGoal = await divertMemberEdit('goals', req.params.id, scope, goalFields);
  if (divertedGoal) { res.json(await attachHouseholdsToOne('goal', divertedGoal, scope)); return; }

  const { data, error } = await supabase
    .from('goals')
    .update(goalFields)
    .eq('id', req.params.id)
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(await attachHouseholdsToOne('goal', data, scope));
});

router.delete('/goals/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  // A household member's delete takes the goal out of the HOUSEHOLD only, and
  // asks its owner whether to delete it from their account as well.
  if (await divertMemberDelete('goals', req.params.id, scope)) {
    res.json({ success: true, diverted: true });
    return;
  }
  const refusal = await refuseDelete('goals', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  await revokeGrantsFor('goals', req.params.id);
  await supabase.from('goals').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ── Goal contributions (Phase 4.3) ───────────────────────────────────────────
// The ledger of money moved toward a goal. Signed amounts (+ in, − out), with
// the source recorded so the client can tell a deposit that is already visible
// in a linked account's balance from one that isn't. Every query is scoped to
// the authenticated user and the writable set is an explicit allowlist — the
// client must never set id / user_id / timestamps.
const GOAL_CONTRIBUTION_WRITABLE = [
  'goal_id', 'amount', 'date', 'source_type', 'source_id', 'note',
];

router.get('/goal-contributions', async (req: AuthRequest, res: Response) => {
  // A contribution's visibility follows its GOAL: a goal shared into a
  // household is meaningless without the money already moved toward it, so the
  // ledger of every goal this user can see comes too. Writes stay owner-only —
  // seeing a partner's contribution never makes it yours to edit.
  const scope = await loadScope(req.user!.userId);
  const { data: visibleGoals } = await scopedQuery(
    supabase.from('goals').select('id'), scope, 'goals',
  );
  const goalIds = (visibleGoals ?? []).map(g => g.id);

  let query = supabase.from('goal_contributions').select('*');
  query = goalIds.length > 0
    ? query.or(`user_id.eq.${req.user!.userId},goal_id.in.(${goalIds.join(',')})`)
    : query.eq('user_id', req.user!.userId);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/goal-contributions', async (req: AuthRequest, res: Response) => {
  const fields: Record<string, unknown> = { ...pick(req.body, GOAL_CONTRIBUTION_WRITABLE), user_id: req.user!.userId };
  const replay = await beginIdempotentCreate('goal_contributions', req.user!.userId, req.body, fields);
  if (replay) { res.status(200).json(replay); return; }

  const { data, error } = await supabase
    .from('goal_contributions')
    .insert(fields)
    .select().single();
  if (error) {
    const raced = await recoverIdempotentRace('goal_contributions', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json(raced); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(201).json(data);
});

router.put('/goal-contributions/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('goal_contributions').update(pick(req.body, GOAL_CONTRIBUTION_WRITABLE))
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  // Never seen by the server (created offline, or already deleted): 404 so the
  // sync queue drops it instead of retrying forever.
  if (!data) { res.status(404).json({ error: 'Contribution not found' }); return; }
  res.json(data);
});

router.delete('/goal-contributions/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('goal_contributions').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Alert states (Phase 4.4) ─────────────────────────────────────────────────
// The user's response to a proactive alert — dismissed, and read — and nothing
// else. The alerts themselves are re-derived client-side from the budget, goal
// and forecast engines on every load, so there is no alert row to go stale.
//
// Written by UPSERT on (user_id, alert_key) rather than create/update/delete:
// the client knows the alert's key before it knows whether a row exists, and two
// devices dismissing the same alert must converge on one row instead of racing
// to insert two. That makes the write idempotent, which is what lets the offline
// sync queue replay it safely however many times it has to.
const ALERT_STATE_WRITABLE = ['alert_key', 'dismissed_stage', 'dismissed_at', 'read_stage', 'read_at'];

router.get('/alert-states', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('alert_states').select('*').eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.put('/alert-states', async (req: AuthRequest, res: Response) => {
  const key = String(req.body?.alert_key ?? '').trim();
  if (!key) { res.status(400).json({ error: 'alert_key is required' }); return; }

  const { data, error } = await supabase
    .from('alert_states')
    .upsert(
      { ...pick(req.body, ALERT_STATE_WRITABLE), alert_key: key, user_id: req.user!.userId },
      { onConflict: 'user_id,alert_key' },
    )
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// Drop the state of an alert whose condition has resolved, so a dismissal made
// about a situation that has since passed cannot silence it when it returns.
//
// The key travels as a QUERY parameter, not a path segment: it embeds the
// category name, and a user-created category may contain a slash ("Health/
// Medical"), which survives encodeURIComponent but not every proxy's path
// normalisation on the way here.
router.delete('/alert-states', async (req: AuthRequest, res: Response) => {
  const key = String(req.query.key ?? '').trim();
  if (!key) { res.status(400).json({ error: 'key is required' }); return; }

  const { error } = await supabase
    .from('alert_states').delete()
    .eq('alert_key', key).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// Notifications
router.get('/notifications', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false })
    .limit(50);
  res.json(data ?? []);
});

router.patch('/notifications/:id/read', async (req: AuthRequest, res: Response) => {
  await supabase.from('notifications').update({ is_read: true })
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

router.patch('/notifications/read-all', async (req: AuthRequest, res: Response) => {
  await supabase.from('notifications').update({ is_read: true }).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

// ── Budgets (Phase 4.1 budgeting foundation) ─────────────────────────────────
// A monthly spending cap on one category (scope='category') or on ALL spending
// (scope='overall'). Every query is scoped to the authenticated user, and the
// writable set is an explicit allowlist — the client must never be able to set
// id / user_id / timestamps.
// Sharing writes no column here — a shared cap is one cap the household is held
// to, recorded in `record_households` and still owned by whoever set it.
const BUDGET_WRITABLE = [
  'scope', 'category', 'limit_amount', 'period',
  'rollover_enabled', 'start_month', 'active',
];

router.get('/budget', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const { data } = await scopedQuery(supabase.from('budgets').select('*'), scope, 'budgets');
  res.json(await attachHouseholds('budget', data ?? [], scope));
});

router.post('/budget', async (req: AuthRequest, res: Response) => {
  // Born personal — sharing is a separate act against the join (see the PUT).
  const { data, error } = await supabase
    .from('budgets')
    .insert({ ...pick(req.body, BUDGET_WRITABLE), user_id: req.user!.userId })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/budget/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('budgets', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('budgets', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const budgetFields = pick(req.body, BUDGET_WRITABLE);

  // Member edits divert into a change request — see the goals PUT above.
  const divertedBudget = await divertMemberEdit('budgets', req.params.id, scope, budgetFields);
  if (divertedBudget) { res.json(await attachHouseholdsToOne('budget', divertedBudget, scope)); return; }

  const { data, error } = await supabase
    .from('budgets').update(budgetFields)
    .eq('id', req.params.id).select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  // A budget the server has never seen (created offline, or already deleted):
  // 404 so the sync queue can drop it rather than retry forever.
  if (!data) { res.status(404).json({ error: 'Budget not found' }); return; }
  res.json(await attachHouseholdsToOne('budget', data, scope));
});

router.delete('/budget/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  // Member deletes divert: out of the household now, owner asked — see goals.
  if (await divertMemberDelete('budgets', req.params.id, scope)) {
    res.json({ success: true, diverted: true });
    return;
  }
  const refusal = await refuseDelete('budgets', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  await revokeGrantsFor('budgets', req.params.id);
  const { error } = await supabase.from('budgets').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Budget plan: settings (one row per user, upserted) ───────────────────────
router.get('/budget-settings', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('budget_settings').select('*').eq('user_id', req.user!.userId).maybeSingle();
  res.json(data ?? null);
});

router.put('/budget-settings', async (req: AuthRequest, res: Response) => {
  const { id, user_id, created_at, updated_at, ...patch } = req.body ?? {};
  const { data, error } = await supabase
    .from('budget_settings')
    .upsert({ ...patch, user_id: req.user!.userId }, { onConflict: 'user_id' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// ── Budget plan: line items ──────────────────────────────────────────────────
router.get('/budget-lines', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('budget_lines').select('*').eq('user_id', req.user!.userId);
  res.json(data ?? []);
});

router.post('/budget-lines', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('budget_lines').insert({ ...req.body, user_id: req.user!.userId }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/budget-lines/:id', async (req: AuthRequest, res: Response) => {
  // maybeSingle (not single): a queued update can target a row that isn't on the
  // server for this user — e.g. a stale budget line left in localStorage by a
  // previous account on a shared device. single() raises PGRST116 ("no rows"),
  // which we'd return as a 500, wedging the sync queue in an endless retry. Treat
  // a no-match as an idempotent no-op so the queue can drain.
  const { data, error } = await supabase
    .from('budget_lines').update(req.body).eq('id', req.params.id).eq('user_id', req.user!.userId).select().maybeSingle();
  if (error) {
    console.error('[BUDGET-LINE PUT] Supabase error:', JSON.stringify(error), '| keys:', Object.keys(req.body));
    res.status(500).json({ error: error.message, code: error.code });
    return;
  }
  // No matching row → nothing to update; ack so the offline queue can drain.
  res.json(data ?? { id: req.params.id, noop: true });
});

router.delete('/budget-lines/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('budget_lines').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Custom categories ────────────────────────────────────────────────────────
router.get('/custom-categories', async (req: AuthRequest, res: Response) => {
  const { data } = await supabase
    .from('custom_categories').select('*').eq('user_id', req.user!.userId);
  res.json(data ?? []);
});

router.post('/custom-categories', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('custom_categories')
    .upsert({ ...req.body, user_id: req.user!.userId }, { onConflict: 'user_id,name' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete('/custom-categories/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('custom_categories').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ─── Bill ↔ Subscription "Different bills" exclusions (cross-device) ───────────
// User-scoped rejected bill↔subscription matches, keyed by the frontend's stable
// anchor-name `decision_key` so a decision survives occurrence-id churn + renames.
// DELETE is BY KEY (?key=), not id: the client always knows the anchor key, and it
// stays valid across id churn where a stored row id might not.

router.get('/bill-subscription-exclusions', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('bill_subscription_exclusions').select('*').eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/bill-subscription-exclusions', async (req: AuthRequest, res: Response) => {
  const decisionKey = typeof req.body?.decision_key === 'string' ? req.body.decision_key.trim() : '';
  if (!decisionKey) { res.status(400).json({ error: 'decision_key required' }); return; }
  const { data, error } = await supabase
    .from('bill_subscription_exclusions')
    .upsert({ user_id: req.user!.userId, decision_key: decisionKey },
            { onConflict: 'user_id,decision_key' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete('/bill-subscription-exclusions', async (req: AuthRequest, res: Response) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!key) { res.status(400).json({ error: 'key required' }); return; }
  const { error } = await supabase
    .from('bill_subscription_exclusions')
    .delete().eq('user_id', req.user!.userId).eq('decision_key', key);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ─── Phase 2B: Merchants ──────────────────────────────────────────────────────
// GET returns GLOBAL rows (user_id IS NULL) + the caller's own rows. Writes are
// always user-owned — clients can never create/edit/delete a global merchant.
const MERCHANT_WRITABLE = ['display_name', 'merchant_normalized', 'default_category', 'logo_url'];
function pick(body: unknown, allowed: string[]): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

router.get('/merchants', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('merchants').select('*').or(`user_id.is.null,user_id.eq.${req.user!.userId}`);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/merchants', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('merchants')
    .upsert({ ...pick(req.body, MERCHANT_WRITABLE), user_id: req.user!.userId },
            { onConflict: 'user_id,merchant_normalized' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/merchants/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('merchants').update(pick(req.body, MERCHANT_WRITABLE))
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Merchant not found' }); return; }
  res.json(data);
});

router.delete('/merchants/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('merchants').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ─── Phase 2B: Merchant aliases ───────────────────────────────────────────────
const ALIAS_WRITABLE = ['merchant_id', 'pattern', 'match_type'];

router.get('/merchant-aliases', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('merchant_aliases').select('*').or(`user_id.is.null,user_id.eq.${req.user!.userId}`);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/merchant-aliases', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('merchant_aliases')
    .upsert({ ...pick(req.body, ALIAS_WRITABLE), user_id: req.user!.userId },
            { onConflict: 'user_id,match_type,pattern' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete('/merchant-aliases/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('merchant_aliases').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ─── Phase 2B: Transaction rules ──────────────────────────────────────────────
const RULE_WRITABLE = ['priority', 'enabled', 'conditions', 'actions', 'label'];

router.get('/transaction-rules', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('transaction_rules').select('*').eq('user_id', req.user!.userId)
    .order('priority', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/transaction-rules', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('transaction_rules')
    .insert({ ...pick(req.body, RULE_WRITABLE), user_id: req.user!.userId })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/transaction-rules/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('transaction_rules').update(pick(req.body, RULE_WRITABLE))
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Rule not found' }); return; }
  res.json(data);
});

router.delete('/transaction-rules/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('transaction_rules').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ─── Phase 2C: Recurring series ───────────────────────────────────────────────
// User-owned. POST upserts on (user_id, merchant_normalized, frequency) so a
// confirm/dismiss for the same pattern is idempotent and a dismissed key can't
// coexist with an active one.
const SERIES_WRITABLE = [
  'merchant_id', 'merchant_normalized', 'name', 'original_name', 'kind',
  'frequency', 'expected_amount', 'last_transaction_date', 'next_expected_date',
  'account_id', 'status',
];

router.get('/recurring-series', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('recurring_series').select('*').eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/recurring-series', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('recurring_series')
    .upsert({ ...pick(req.body, SERIES_WRITABLE), user_id: req.user!.userId },
            { onConflict: 'user_id,merchant_normalized,frequency' })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/recurring-series/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('recurring_series').update(pick(req.body, SERIES_WRITABLE))
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Series not found' }); return; }
  res.json(data);
});

router.delete('/recurring-series/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('recurring_series').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ─── Phase 2C: Transaction splits ─────────────────────────────────────────────
// The client sets splits atomically by deleting all splits for a transaction and
// re-creating the lines. The parent transaction row is never touched here.
const SPLIT_WRITABLE = ['transaction_id', 'category', 'amount', 'notes', 'tags'];

/**
 * A split is not a decision of its own: it is HOW a transaction is categorised,
 * and it travels with the transaction exactly as the transaction's household
 * stamps do. Returning only the user's own splits meant a member could see a
 * shared $600 grocery shop while its owner saw $380 groceries + $150 home + $70
 * health — one household, two different budget figures for the same row.
 *
 * So: own splits, plus the splits on any transaction shared into view. The
 * shared set is bounded by what was actually shared (stamped transactions, and
 * transactions on a shared or granted account/card), so the common
 * personal-only path is the single indexed query it always was.
 */
router.get('/transaction-splits', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);

  const { data: own, error } = await supabase
    .from('transaction_splits').select('*').eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }

  const sharedTxIds = new Set<string>(scope.householdRecords.get('transaction') ?? []);
  const carriers = [
    ...grantedAccountIds(scope),
    ...(scope.householdRecords.get('account') ?? []),
    ...(scope.householdRecords.get('card') ?? []),
  ];
  if (carriers.length) {
    const { data: carried } = await supabase
      .from('transactions').select('id')
      .in('account_id', carriers)
      .neq('user_id', req.user!.userId);
    for (const t of carried ?? []) sharedTxIds.add(t.id as string);
  }
  for (const id of grantedIds(scope, 'transaction')) sharedTxIds.add(id);

  if (!sharedTxIds.size) { res.json(own ?? []); return; }

  const { data: shared, error: sharedErr } = await supabase
    .from('transaction_splits').select('*')
    .in('transaction_id', [...sharedTxIds])
    .neq('user_id', req.user!.userId);
  if (sharedErr) { res.status(500).json({ error: sharedErr.message }); return; }

  res.json([...(own ?? []), ...(shared ?? [])]);
});

router.post('/transaction-splits', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('transaction_splits')
    .insert({ ...pick(req.body, SPLIT_WRITABLE), user_id: req.user!.userId })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete('/transaction-splits/by-transaction/:transactionId', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('transaction_splits').delete()
    .eq('transaction_id', req.params.transactionId).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

router.delete('/transaction-splits/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('transaction_splits').delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Phase 2D.3: AI classification fallback ────────────────────────────────────
// The client calls this ONLY for transactions its deterministic engine left
// uncertain (see frontend utils/aiClassification.ts). It is stateless and
// user-scoped by the auth middleware: it classifies exactly the rows in the body
// and reads no stored data, so one user's request can never see another's. The
// batch is capped to bound cost, and any model failure returns an empty result
// set (never a 500) so an AI outage can't block the user's import.
router.post('/ai-classify', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as { transactions?: unknown; categories?: unknown; currency?: unknown };
  const rawItems = Array.isArray(body.transactions) ? body.transactions : [];
  const categories = Array.isArray(body.categories)
    ? body.categories.map(String).filter(Boolean)
    : [];
  const currency = typeof body.currency === 'string' ? body.currency : 'AUD';

  if (!rawItems.length || !categories.length) {
    res.json({ results: [] });
    return;
  }

  // Normalise + cap the batch (defence in depth — the client already caps at 25).
  const items = rawItems
    .slice(0, 25)
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        id: String(o.id ?? ''),
        description: String(o.description ?? ''),
        merchant: o.merchant == null ? '' : String(o.merchant),
        amount: Number(o.amount ?? 0),
        date: o.date == null ? undefined : String(o.date),
      };
    })
    .filter((i) => i.id);

  if (!items.length) { res.json({ results: [] }); return; }

  try {
    const results = await classifyTransactionsAI(items, categories, currency);
    res.json({ results });
  } catch (err) {
    // Graceful degradation: the rows simply stay uncertain and can be retried.
    // Echo the reason so the client can tell "the AI call failed" apart from
    // "the AI had no suggestions" — otherwise the button silently does nothing.
    // Every configured provider has to fail before this fires (see aiText), so
    // the message here is usually "no key at all", which is actionable.
    const message = (err as Error).message || 'AI classification failed';
    console.error('[overview] ai-classify failed:', message);
    res.json({ results: [], error: message });
  }
});

// ─── Phase 9.1 — Ask Ledger ──────────────────────────────────────────────────
//
// Two endpoints, both stateless and both optional. Neither reads or writes the
// database: everything Ask Ledger knows is computed on the client from the
// user's own already-scoped data, and these only lend the model's help with
// reading the question and wording the answer.
//
// Both answer 200 with an `error` string when the model is unavailable rather
// than failing the request — the client falls back to its own deterministic
// matcher and its own sentence, and the user gets a complete answer either way.

/** Trim an untrusted string list to something safe to put in a prompt. */
function nameList(value: unknown, cap = 80): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => (typeof v === 'string' ? v.trim().slice(0, 60) : ''))
    .filter(Boolean)
    .slice(0, cap);
}

router.post('/ask/interpret', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as { question?: unknown; vocabulary?: unknown };
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  if (!question) { res.json({ intent: null }); return; }

  const v = (body.vocabulary ?? {}) as Record<string, unknown>;
  const vocabulary: AskVocabularyInput = {
    intents: nameList(v.intents, 40),
    categories: nameList(v.categories, 120),
    goals: nameList(v.goals, 60),
    loans: nameList(v.loans, 40),
    policies: nameList(v.policies, 40),
    documents: nameList(v.documents, 40),
    properties: nameList(v.properties, 40),
    financial_years: nameList(v.financial_years, 20),
  };
  if (!vocabulary.intents.length) { res.json({ intent: null }); return; }

  try {
    const intent = await interpretAskQuestion(question, vocabulary);
    res.json({ intent });
  } catch (err) {
    // Same graceful degradation as ai-classify: the client's rules matcher
    // already answered the question, so this is a missed improvement, not a
    // failure. The reason is echoed so a missing CLAUDE_API_KEY is visible.
    const message = (err as Error).message || 'Ask interpretation failed';
    console.error('[overview] ask/interpret failed:', message);
    res.json({ intent: null, error: message });
  }
});

router.post('/ask/phrase', async (req: AuthRequest, res: Response) => {
  const body = (req.body ?? {}) as {
    question?: unknown; intent?: unknown; statement?: unknown;
    figures?: unknown; currency?: unknown;
  };
  const statement = typeof body.statement === 'string' ? body.statement.trim().slice(0, 2000) : '';
  if (!statement) { res.json({ text: null }); return; }

  const figures: AskFigureInput[] = Array.isArray(body.figures)
    ? body.figures.slice(0, 20).map(f => {
      const o = (f ?? {}) as Record<string, unknown>;
      return {
        label: String(o.label ?? '').slice(0, 80),
        value: typeof o.value === 'number' ? o.value : String(o.value ?? '').slice(0, 40),
        kind: String(o.kind ?? '').slice(0, 20),
      };
    })
    : [];

  try {
    const text = await phraseAskAnswer({
      question: typeof body.question === 'string' ? body.question : '',
      intent: typeof body.intent === 'string' ? body.intent : '',
      statement,
      figures,
      currency: typeof body.currency === 'string' ? body.currency : 'AUD',
    });
    res.json({ text });
  } catch (err) {
    const message = (err as Error).message || 'Ask phrasing failed';
    console.error('[overview] ask/phrase failed:', message);
    res.json({ text: null, error: message });
  }
});

export default router;
