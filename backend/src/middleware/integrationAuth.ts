import { Request, Response, NextFunction } from 'express';
import { supabase } from '../utils/supabase';

// ── Ledger Integration API auth ───────────────────────────────────────────────
//
// Machine-to-machine front door for OTHER apps in the ecosystem (PAssistant, and
// later JobEasy / Travel / Fitness / mobile / desktop / widgets). Separate from the
// user-facing JWT `authenticate` middleware. Two layers:
//
//   • App identity   — a per-app shared secret in `INTEGRATION_KEYS`, format
//                       "passistant:<secret>,jobeasy:<secret>". Proves "this is app
//                       X's backend". Never a single global key.  → requireAppKey
//
//   • User identity   — a durable LINK TOKEN (X-Link-Token header) issued when the
//                       user pairs the apps with a one-time code. Resolves to a
//                       Ledger user via integration_links. This is the ONLY way to
//                       identify the user. → authenticateIntegration
//
// SECURITY: there is deliberately no email fallback. Resolving the target user by
// X-User-Email let any app holding the integration key read ANY Ledger account's
// finances just by sending that person's email — a cross-account data leak, since
// the app key proves "this is app X", not "app X's user owns this Ledger account".
// Only a link token proves the calling user actually paired THIS Ledger account, so
// a token is now mandatory. Unpaired setups must pair (one-time code) to get one.
//
// READ-ONLY by construction — no route mounted behind it writes finance data.

export interface IntegrationRequest extends Request {
  integration?: { appId: string; userId?: string; email?: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  params: Record<string, string>;
}

/** Parse "app1:secret1,app2:secret2" → Map<secret, appId>. Cached per process. */
let _keyMap: Map<string, string> | null = null;
function keyMap(): Map<string, string> {
  if (_keyMap) return _keyMap;
  const raw = process.env.INTEGRATION_KEYS ?? '';
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    const appId = trimmed.slice(0, idx).trim();
    const secret = trimmed.slice(idx + 1).trim();
    if (appId && secret) map.set(secret, appId);
  }
  _keyMap = map;
  return map;
}

/** Validate the per-app Bearer key only. Sets req.integration.appId. */
export function requireAppKey(req: IntegrationRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing integration credentials' });
    return;
  }
  const secret = authHeader.slice('Bearer '.length).trim();
  const appId = keyMap().get(secret);
  if (!appId) {
    res.status(401).json({ error: 'Invalid integration key' });
    return;
  }
  req.integration = { appId };
  next();
}

/** App key + resolve the target Ledger user by LINK TOKEN ONLY (no email fallback). */
export async function authenticateIntegration(
  req: IntegrationRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // First enforce the app key (synchronous; calls next internally only on success).
  let appOk = false;
  requireAppKey(req, res, () => { appOk = true; });
  if (!appOk) return; // requireAppKey already sent the response

  const token = String(req.headers['x-link-token'] ?? '').trim();
  if (!token) {
    // No email fallback by design — see the security note at the top of this file.
    res.status(401).json({ error: 'Missing X-Link-Token — pair this app with Ledger to get one' });
    return;
  }

  const { data: link, error } = await supabase
    .from('integration_links')
    .select('user_id, status')
    .eq('token', token)
    .maybeSingle();
  if (error) { res.status(500).json({ error: 'Link lookup failed' }); return; }
  if (!link || link.status !== 'active') {
    res.status(401).json({ error: 'Invalid or revoked link token' });
    return;
  }
  req.integration!.userId = String(link.user_id);
  next();
}
