import { Router, Request, Response } from 'express';
import {
  createBasiqUser,
  getAuthLink,
  getBasiqAccounts,
  getBasiqTransactions,
  institutionName,
  mapAccountType,
} from '../services/basiqService';

const router = Router();

// ── POST /api/basiq/connect ───────────────────────────────────────────────────
// Creates a Basiq user (or re-uses if id supplied) and returns a consent URL.
router.post('/connect', async (req: Request, res: Response) => {
  const { email, mobile } = req.body as { email?: string; mobile?: string };
  if (!email) { res.status(400).json({ error: 'email is required' }); return; }
  if (!mobile) { res.status(400).json({ error: 'mobile is required (format: +61400000000)' }); return; }

  console.log('[basiq] connect →', email);
  try {
    const user = await createBasiqUser(email, mobile);
    const authLink = await getAuthLink(user.id, mobile);
    console.log('[basiq] created user', user.id, '→ auth link generated');
    res.json({ basiqUserId: user.id, authLink });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] connect failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/basiq/auth_link?userId=xxx ───────────────────────────────────────
// Regenerates an auth link for an existing Basiq user (for re-linking a bank).
router.get('/auth_link', async (req: Request, res: Response) => {
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
router.get('/accounts', async (req: Request, res: Response) => {
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] accounts failed:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/basiq/transactions?userId=xxx[&accountId=yyy] ───────────────────
// Returns live Basiq transactions normalised to Ledger's transaction shape.
router.get('/transactions', async (req: Request, res: Response) => {
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[basiq] transactions failed:', msg);
    res.status(500).json({ error: msg });
  }
});

export default router;
