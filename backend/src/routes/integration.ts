import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { authenticateIntegration, requireAppKey, IntegrationRequest } from '../middleware/integrationAuth';
import { buildFinancialSummary } from '../services/integrationSummary';
import { generatePairingCode, redeemPairingCode } from '../services/integrationLinkService';

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
    res.json(summary);
  } catch (err) {
    console.error('[INTEGRATION] summary failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to build financial summary' });
  }
});

export default router;
