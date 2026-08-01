import { Router, Response } from 'express';
import {
  createBasiqUser,
  deleteBasiqUser,
  getAuthLink,
  getBasiqAccounts,
  getBasiqTransactions,
  getLatestJobSummary,
  institutionName,
  mapAccountType,
  BasiqConsentExpiredError,
  BasiqUserNotFoundError,
} from '../services/basiqService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';

const router = Router();

// The clean payload the frontend gets whenever the stored Basiq user is gone.
// `basiq_user_id` is the single key every part of the connection hangs off, so
// clearing it (below) invalidates consent, connection and last-synced state in
// one move — the user then reconnects from scratch (a fresh Basiq user).
const RECONNECT_RESPONSE = {
  connected: false,
  requiresReconnect: true,
  message: 'Your bank connection no longer exists. Please reconnect your bank.',
} as const;

// Drop the local Basiq link for a Ledger user. Used when Basiq tells us the user
// was deleted, and by the explicit Disconnect endpoint. Returns whatever id we
// had stored so callers can log the old→(none) transition. Never logs secrets.
async function clearBasiqLink(ledgerUserId: string): Promise<string | null> {
  const { data } = await supabase
    .from('users')
    .select('basiq_user_id')
    .eq('id', ledgerUserId)
    .single();
  const oldId = data?.basiq_user_id ?? null;

  const { error } = await supabase
    .from('users')
    .update({ basiq_user_id: null })
    .eq('id', ledgerUserId);
  if (error) console.error('[basiq] failed to clear basiq_user_id:', error.message);

  return oldId;
}

// All Basiq routes require an authenticated user — they expose live bank data.
router.use(authenticate);

// ── POST /api/basiq/connect ───────────────────────────────────────────────────
// Always mints a BRAND-NEW Basiq user (deleting any stale prior one first) and
// returns a fresh consent URL tied to that new id. Never reuses a previous user.
router.post('/connect', async (req: AuthRequest, res: Response) => {
  const { email, mobile, business } = req.body as {
    email?: string;
    mobile?: string;
    business?: {
      businessName?: string;
      businessIdNo?: string;
      businessIdNoType?: 'ABN' | 'ACN';
      businessAddress?: { addressLine1?: string; suburb?: string; state?: string; postcode?: string };
    };
  };
  if (!email) { res.status(400).json({ error: 'email is required' }); return; }
  if (!mobile) { res.status(400).json({ error: 'mobile is required (format: +61400000000)' }); return; }

  // If business details are supplied, validate the full identity block Basiq needs.
  let businessDetails;
  if (business) {
    const a = business.businessAddress ?? {};
    if (!business.businessName || !business.businessIdNo ||
        !a.addressLine1 || !a.suburb || !a.state || !a.postcode) {
      res.status(400).json({ error: 'business requires businessName, businessIdNo and a full address (addressLine1, suburb, state, postcode)' });
      return;
    }
    businessDetails = {
      businessName: business.businessName,
      businessIdNo: business.businessIdNo,
      businessIdNoType: business.businessIdNoType ?? 'ABN' as const,
      businessAddress: {
        addressLine1: a.addressLine1,
        suburb: a.suburb,
        state: a.state,
        postcode: a.postcode,
      },
    };
  }

  console.log('[basiq] connect →', email, businessDetails ? '(business)' : '(personal)');
  try {
    // Never reuse a previous Basiq user. If one is still stored (e.g. an expired
    // or orphaned link), best-effort delete it at Basiq so we don't leave dangling
    // users, then mint a brand-new one below with its own fresh consent link.
    const { data: existing } = await supabase
      .from('users')
      .select('basiq_user_id')
      .eq('id', req.user!.userId)
      .single();
    const previousBasiqUserId = existing?.basiq_user_id ?? null;
    if (previousBasiqUserId) {
      try {
        await deleteBasiqUser(previousBasiqUserId);
      } catch (e) {
        console.warn('[basiq] could not delete previous user', previousBasiqUserId, '-', e instanceof Error ? e.message : e);
      }
    }

    const user = await createBasiqUser(email, mobile, businessDetails);
    const authLink = await getAuthLink(user.id, mobile);
    console.log('[basiq] connect: previous user', previousBasiqUserId ?? '(none)', '→ new user', user.id, '(fresh consent link generated)');

    // Persist the NEW Basiq user id to our DB so the connection survives a cleared
    // localStorage or a device switch. user_id references public.users(id)
    // (NOT auth.users) — match on the JWT's userId directly.
    const { error: dbErr } = await supabase
      .from('users')
      .update({ basiq_user_id: user.id })
      .eq('id', req.user!.userId);
    if (dbErr) console.error('[basiq] failed to persist basiq_user_id:', dbErr.message);

    res.json({ basiqUserId: user.id, authLink });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] connect failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/basiq/me ─────────────────────────────────────────────────────────
// Returns the authenticated user's stored Basiq user id (null if not connected).
// Lets the frontend treat localStorage as a cache and the DB as source of truth.
router.get('/me', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('users')
    .select('basiq_user_id')
    .eq('id', req.user!.userId)
    .single();

  if (error) {
    console.error('[basiq] /me failed:', error.message);
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ basiqUserId: data?.basiq_user_id ?? null });
});

// ── DELETE /api/basiq/disconnect ──────────────────────────────────────────────
// Disconnect the bank: best-effort delete the Basiq user at Basiq (so no data
// lingers with the third party) and clear the local link records. Safe to call
// when consent is revoked or the Basiq user is already deleted — a missing user
// deletes as a no-op (deleteBasiqUser treats 404 as success). A later reconnect
// mints a brand-new Basiq user, never reusing the old id.
router.delete('/disconnect', async (req: AuthRequest, res: Response) => {
  try {
    const oldId = await clearBasiqLink(req.user!.userId);
    if (oldId) {
      try {
        await deleteBasiqUser(oldId);
        console.log('[basiq] disconnect: cleared + deleted Basiq user', oldId);
      } catch (e) {
        // Local link is already cleared; a Basiq-side failure shouldn't block the user.
        console.warn('[basiq] disconnect: cleared local link but Basiq delete failed for', oldId, '-', e instanceof Error ? e.message : e);
      }
    } else {
      console.log('[basiq] disconnect: no stored Basiq user to clear');
    }
    res.json({ ...RECONNECT_RESPONSE, success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] disconnect failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/basiq/auth_link?userId=xxx ───────────────────────────────────────
// Regenerates an auth link for an existing Basiq user (for re-linking a bank).
router.get('/auth_link', async (req: AuthRequest, res: Response) => {
  const { userId, mobile } = req.query as { userId?: string; mobile?: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

  try {
    const authLink = await getAuthLink(userId, mobile);
    res.json({ authLink });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/basiq/accounts?userId=xxx ───────────────────────────────────────
// Returns live Basiq accounts normalised into Ledger's bank_account shape.
router.get('/accounts', async (req: AuthRequest, res: Response) => {
  const { userId } = req.query as { userId?: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

  // The Basiq user id we're syncing (query param) and the connection(s) the
  // returned accounts belong to are logged below — never any token or API key.
  console.log('[basiq] fetch accounts → basiqUserId', userId);
  try {
    const raw = await getBasiqAccounts(userId);
    console.log(`[basiq] accounts returned by Basiq: ${raw.length}`);

    // Point 12: an empty accounts array is NOT a healthy sync — pull the latest
    // connection job and report the retrieve-accounts step so we can see whether
    // the bank actually returned accounts or the job failed/stalled.
    if (raw.length === 0) {
      try {
        const job = await getLatestJobSummary(userId);
        if (!job) {
          console.warn('[basiq] accounts empty and no connection job found for', userId);
        } else {
          const accStep = job.steps.find(s => s.title.includes('account'));
          console.warn(
            `[basiq] accounts empty — latest job ${job.jobId} (updated ${job.updated ?? '?'}):`,
            `retrieve-accounts step =`, accStep ? `${accStep.status}` : '(no accounts step)',
            accStep?.result ? `error=${JSON.stringify(accStep.result)}` : '',
          );
          console.warn('[basiq] full job steps:', JSON.stringify(job.steps));
        }
      } catch (e) {
        console.warn('[basiq] could not fetch job diagnostics:', e instanceof Error ? e.message : e);
      }
    }

    // Log every returned account's key fields (point 5) and split bank vs credit.
    // Reject (rather than silently drop) accounts Basiq marks unavailable — the
    // old code required status === 'active', but Basiq uses 'available'/'unavailable',
    // so that filter dropped EVERY account (incl. the Hooli sandbox) while
    // transactions still imported. We now include anything not 'unavailable'.
    const bankAccounts: Array<Record<string, unknown>> = [];
    const creditCards: Array<Record<string, unknown>> = [];
    const rejected: Array<{ id: string; status: string; reason: string }> = [];

    for (const a of raw) {
      // Sandbox institution (Hooli) is AU00000 — tag its source so it is never
      // merged into a manually-added statement account downstream.
      const source = a.institution === 'AU00000' ? 'basiq_sandbox' : 'basiq';
      console.log('[basiq] account:', JSON.stringify({
        id: a.id,
        name: a.name,
        balance: a.balance,
        availableFunds: a.availableFunds ?? null,
        currency: a.currency,
        institution: a.institution,
        connection: a.connection ?? null,
        status: a.status,
        classType: a.class?.type ?? null,
        source,
      }));

      if (a.status === 'unavailable') {
        rejected.push({ id: a.id, status: a.status, reason: 'status=unavailable' });
        console.warn(`[basiq] rejected account ${a.id}: status=unavailable`);
        continue;
      }

      if (a.class?.type === 'credit') {
        creditCards.push({
          basiq_account_id: a.id,
          name: a.name,
          institution: institutionName(a.institution),
          balance_owing: Math.abs(parseFloat(a.balance ?? '0')),
          credit_limit: Math.abs(parseFloat(a.availableFunds ?? '0')) + Math.abs(parseFloat(a.balance ?? '0')),
          currency: a.currency ?? 'AUD',
          source,
          is_manual: false,
        });
      } else {
        bankAccounts.push({
          basiq_account_id: a.id,
          name: a.name,
          institution: institutionName(a.institution),
          account_type: mapAccountType(a.class?.type),
          balance: parseFloat(a.balance ?? '0'),
          available_funds: a.availableFunds != null ? parseFloat(a.availableFunds) : null,
          bsb: a.bsb ?? null,
          account_number: a.accountNo ?? null,
          currency: a.currency ?? 'AUD',
          source,
          is_manual: false,
        });
      }
    }

    // Separate counts so the caller never mistakes "transactions imported" for a
    // successful account sync (points 10/11 — insert/update is decided client-side
    // during merge; the server reports returned vs mapped vs rejected).
    const counts = {
      returned: raw.length,
      bankAccounts: bankAccounts.length,
      creditCards: creditCards.length,
      rejected: rejected.length,
    };
    console.log('[basiq] account sync counts:', JSON.stringify(counts), rejected.length ? `rejected=${JSON.stringify(rejected)}` : '');
    res.json({ bankAccounts, creditCards, counts, rejected });
  } catch (err) {
    if (err instanceof BasiqUserNotFoundError) {
      // The stored Basiq user was deleted / data sharing revoked. Clear the dead
      // link so we stop calling accounts/transactions with a non-existent id, and
      // tell the frontend to reconnect.
      const oldId = await clearBasiqLink(req.user!.userId);
      console.warn('[basiq] accounts: Basiq user deleted — cleared link, old id', oldId ?? userId, '→ requires reconnect');
      res.status(409).json(RECONNECT_RESPONSE);
      return;
    }
    if (err instanceof BasiqConsentExpiredError) {
      console.warn('[basiq] accounts: consent expired for', userId);
      res.status(401).json({ error: 'consent_expired' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] accounts failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/basiq/transactions?userId=xxx[&accountId=yyy] ───────────────────
// Returns live Basiq transactions normalised to Ledger's transaction shape.
router.get('/transactions', async (req: AuthRequest, res: Response) => {
  const { userId, accountId } = req.query as { userId?: string; accountId?: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

  console.log('[basiq] fetch transactions →', userId);
  try {
    const raw = await getBasiqTransactions(userId, accountId);

    const transactions = raw.map(t => ({
      basiq_tx_id: t.id,
      account_id: t.account,   // Basiq account ID — frontend maps to local account ID
      date: t.postDate,
      merchant: t.enrich?.merchant?.businessName ?? t.description ?? 'Unknown',
      amount: parseFloat(t.amount),  // negative = debit, positive = credit
      currency: t.currency ?? 'AUD',
      category: t.enrich?.category?.anzsic?.title ?? null,
      type: t.type,
    }));

    console.log(`[basiq] ${transactions.length} transactions`);
    res.json({ transactions });
  } catch (err) {
    if (err instanceof BasiqUserNotFoundError) {
      const oldId = await clearBasiqLink(req.user!.userId);
      console.warn('[basiq] transactions: Basiq user deleted — cleared link, old id', oldId ?? userId, '→ requires reconnect');
      res.status(409).json(RECONNECT_RESPONSE);
      return;
    }
    if (err instanceof BasiqConsentExpiredError) {
      console.warn('[basiq] transactions: consent expired for', userId);
      res.status(401).json({ error: 'consent_expired' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] transactions failed:', msg);
    res.status(500).json({ error: msg });
  }
});

export default router;
