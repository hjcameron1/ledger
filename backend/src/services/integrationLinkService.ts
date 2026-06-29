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

  const { error } = await supabase.from('integration_links').insert({
    user_id: userId,
    code,
    status: 'pending',
    expires_at: null,
  });
  if (error) throw new Error(error.message);
  return { code, expires_at: null };
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
