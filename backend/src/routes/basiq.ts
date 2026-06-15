import { Router, Response } from 'express';
import {
  createBasiqUser,
  getAuthLink,
  getBasiqAccounts,
  getBasiqTransactions,
  institutionName,
  mapAccountType,
  BasiqConsentExpiredError,
} from '../services/basiqService';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';

const router = Router();

// All Basiq routes require an authenticated user — they expose live bank data.
router.use(authenticate);

// ── POST /api/basiq/connect ───────────────────────────────────────────────────
// Creates a Basiq user (or re-uses if id supplied) and returns a consent URL.
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
    const user = await createBasiqUser(email, mobile, businessDetails);
    const authLink = await getAuthLink(user.id, mobile);
    console.log('[basiq] created user', user.id, '→ auth link generated');

    // Persist the Basiq user id to our DB so the connection survives a cleared
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
// Clears the stored Basiq user id for the authenticated user (e.g. to drop a
// stale id created under a different API key). Does not delete the Basiq user
// itself — just unlinks it locally.
router.delete('/disconnect', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('users')
    .update({ basiq_user_id: null })
    .eq('id', req.user!.userId);

  if (error) {
    console.error('[basiq] disconnect failed:', error.message);
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true });
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

  console.log('[basiq] fetch accounts →', userId);
  try {
    const raw = await getBasiqAccounts(userId);

    // Separate bank accounts from credit cards
    const bankAccounts = raw
      .filter(a => a.status === 'active' && a.class?.type !== 'credit')
      .map(a => ({
        basiq_account_id: a.id,
        name: a.name,
        institution: institutionName(a.institution),
        account_type: mapAccountType(a.class?.type),
        balance: parseFloat(a.balance ?? '0'),
        bsb: a.bsb ?? null,
        account_number: a.accountNo ?? null,
        currency: a.currency ?? 'AUD',
        is_manual: false,
      }));

    const creditCards = raw
      .filter(a => a.status === 'active' && a.class?.type === 'credit')
      .map(a => ({
        basiq_account_id: a.id,
        name: a.name,
        institution: institutionName(a.institution),
        balance_owing: Math.abs(parseFloat(a.balance ?? '0')),
        credit_limit: Math.abs(parseFloat(a.availableFunds ?? '0')) + Math.abs(parseFloat(a.balance ?? '0')),
        currency: a.currency ?? 'AUD',
        is_manual: false,
      }));

    console.log(`[basiq] ${bankAccounts.length} accounts, ${creditCards.length} credit cards`);
    res.json({ bankAccounts, creditCards });
  } catch (err) {
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
