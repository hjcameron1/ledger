import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authenticateIntegration, requireAppKey, IntegrationRequest } from '../middleware/integrationAuth';
import { buildFinancialSummary } from '../services/integrationSummary';
import { generatePairingCode, redeemPairingCode, listLinks, revokeLink, touchLinkByToken } from '../services/integrationLinkService';

// ── Ledger Integration API (v1) ───────────────────────────────────────────────
//
// Stable, read-only surface for OTHER apps in the ecosystem. Decoupled from the
// user-facing /api/overview/* routes. Middleware is applied PER-ROUTE because the
// three endpoints authenticate differently:
//   • /link/code   — a logged-in Ledger user (JWT) mints a pairing code
//   • /link/redeem — a consuming app (app key) exchanges the code for a token
//   • /summary     — a consuming app (app key + link token) reads the summary

const router = Router();

// Logged-in Ledger user generates a one-time pairing code (Settings → Connected apps).
router.post('/link/code', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await generatePairingCode(req.user!.userId);
    res.status(201).json(result);
  } catch (err) {
    console.error('[INTEGRATION] code generation failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not generate pairing code' });
  }
});

// Logged-in Ledger user lists their connected apps + sync health (Settings → Connected apps).
router.get('/links', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const links = await listLinks(req.user!.userId);
    res.json({ links });
  } catch (err) {
    console.error('[INTEGRATION] link list failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not load connected apps' });
  }
});

// Logged-in Ledger user disconnects a linked app (revokes its access immediately).
router.delete('/links/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await revokeLink(req.user!.userId, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[INTEGRATION] link revoke failed:', (err as Error).message);
    res.status(500).json({ error: 'Could not disconnect app' });
  }
});

// Consuming app redeems the code for a durable link token.
router.post('/link/redeem', requireAppKey, async (req: IntegrationRequest, res: Response) => {
  const code = String(req.body?.code ?? '').trim();
  if (!code) { res.status(400).json({ error: 'Missing code' }); return; }
  try {
    const result = await redeemPairingCode(code, req.integration!.appId);
    res.json(result);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// Live financial summary for the linked user.
router.get('/summary', authenticateIntegration, async (req: IntegrationRequest, res: Response) => {
  try {
    const summary = await buildFinancialSummary(req.integration!.userId!);
    // Record the read so Connected Apps can show "last synced" / flag a stale link.
    // Fire-and-forget — a failed stamp must never fail the read.
    const token = String(req.headers['x-link-token'] ?? '').trim();
    if (token) void touchLinkByToken(token).catch(() => { /* health-stamp only */ });
    res.json(summary);
  } catch (err) {
    console.error('[INTEGRATION] summary failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to build financial summary' });
  }
});

export default router;
