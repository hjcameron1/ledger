import crypto from 'crypto';
import { supabase } from '../utils/supabase';

// ── Ecosystem pairing: one-time code → durable link token ─────────────────────
//
//   generatePairingCode(userId) — a logged-in Ledger user mints a single-use code.
//   redeemPairingCode(code, appId) — a consuming app exchanges it for a token.
//
// Codes are short and human-typeable; tokens are long opaque secrets.

/** Mint a single-use pairing code shaped LEDG-XXXX-XXXX (crockford-ish, no ambiguous chars).
 *  Codes do not expire by time — they stay valid until redeemed (single-use). */
export async function generatePairingCode(userId: string): Promise<{ code: string; expires_at: null }> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const block = () => Array.from({ length: 4 }, () =>
    alphabet[crypto.randomInt(alphabet.length)]).join('');
  const code = `LEDG-${block()}-${block()}`;

  // Only one pairing code should be outstanding at a time — drop any prior
  // unredeemed codes so old codes stop working and the Connected Apps list shows
  // a single "waiting to connect" entry rather than a pile of stale ones.
  await supabase.from('integration_links')
    .delete()
    .eq('user_id', userId)
    .eq('status', 'pending');

  const { error } = await supabase.from('integration_links').insert({
    user_id: userId,
    code,
    status: 'pending',
    expires_at: null,
  });
  if (error) throw new Error(error.message);
  return { code, expires_at: null };
}

/** A non-secret view of one ecosystem link, for Settings → Connected Apps. */
export interface ConnectedAppLink {
  id: string;
  app_id: string | null;   // which app redeemed it ('passistant', …); null while pending
  status: string;          // 'pending' | 'active' | 'disconnected'
  created_at: string | null;
  redeemed_at: string | null;
  last_seen_at: string | null;
  disconnected_at: string | null; // set when the app severed the link from its end
}

/** The user's ecosystem links (active connections + any code still waiting to be
 *  redeemed), most recent first. Never returns the token or the raw code. */
export async function listLinks(userId: string): Promise<ConnectedAppLink[]> {
  const query = (cols: string) => supabase
    .from('integration_links')
    .select(cols)
    .eq('user_id', userId)
    .neq('status', 'revoked')
    .order('created_at', { ascending: false });

  let { data, error } = await query('id, app_id, status, created_at, redeemed_at, last_seen_at, disconnected_at');
  // Tolerate newer columns not existing yet (deployed before the migration ran) —
  // fall back through last_seen_at, then to the original columns, so the list still loads.
  if (error && /disconnected_at/.test(error.message)) {
    ({ data, error } = await query('id, app_id, status, created_at, redeemed_at, last_seen_at'));
  }
  if (error && /last_seen_at/.test(error.message)) {
    ({ data, error } = await query('id, app_id, status, created_at, redeemed_at'));
  }
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(r => ({
    id: String(r.id),
    app_id: (r.app_id as string | null) ?? null,
    status: String(r.status),
    created_at: (r.created_at as string | null) ?? null,
    redeemed_at: (r.redeemed_at as string | null) ?? null,
    last_seen_at: (r.last_seen_at as string | null) ?? null,
    disconnected_at: (r.disconnected_at as string | null) ?? null,
  }));
}

/** Disconnect a link the user owns: clear its secrets and mark it 'revoked' so the
 *  other app loses access immediately. The row is kept as an audit trail. */
export async function revokeLink(userId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from('integration_links')
    .update({ status: 'revoked', token: null, code: null })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

/** The consuming app (e.g. PAssistant) severs the link from ITS end. Marks the link
 *  'disconnected' and clears the token so it loses access immediately, but keeps the row
 *  VISIBLE (distinct from a user-side 'revoked') so Connected Apps can show WHY sync
 *  stopped until the user dismisses it. Returns true if a live link was disconnected. */
export async function disconnectLinkByToken(token: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('integration_links')
    .update({ status: 'disconnected', disconnected_at: new Date().toISOString(), token: null })
    .eq('token', token)
    .eq('status', 'active')
    .select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Best-effort "last read" stamp so Connected Apps can show sync health. Fired
 *  (not awaited) on each summary read; a failure must never break the read. */
export async function touchLinkByToken(token: string): Promise<void> {
  const { error } = await supabase
    .from('integration_links')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('token', token)
    .eq('status', 'active');
  if (error) throw new Error(error.message);
}

/** Redeem a pending code → durable token. Single-use; expired/used codes are rejected. */
export async function redeemPairingCode(code: string, appId: string): Promise<{ token: string }> {
  const clean = code.trim().toUpperCase();
  const { data: row, error } = await supabase
    .from('integration_links')
    .select('id, status, expires_at')
    .eq('code', clean)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || row.status !== 'pending') {
    throw Object.assign(new Error('Invalid or already-used code'), { status: 400 });
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error('Code has expired'), { status: 400 });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const { error: upErr } = await supabase
    .from('integration_links')
    .update({ token, app_id: appId, status: 'active', code: null, redeemed_at: new Date().toISOString() })
    .eq('id', row.id);
  if (upErr) throw new Error(upErr.message);
  return { token };
}
