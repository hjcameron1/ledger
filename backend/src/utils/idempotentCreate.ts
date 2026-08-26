/**
 * Replay-safe record creation (create idempotency).
 *
 * The client's enqueue-first sync queue parks every create BEFORE sending it,
 * and replays it after a reload without knowing whether the original request
 * committed before the response was lost. Without idempotency, that replay
 * inserts a twin. The fix: the client sends `client_id` — the row's uuid as the
 * CLIENT minted it — and the server treats (user_id, client_id) as "this exact
 * create", returning the existing row instead of inserting again.
 *
 * Every table covered needs a migration:
 *   alter table <t> add column if not exists client_id uuid;
 *   create unique index if not exists <t>_user_client_uidx
 *     on <t> (user_id, client_id) where client_id is not null;
 *
 * Degrades gracefully while the column is missing: the pre-check select errors,
 * so the create proceeds as a plain insert (no idempotency, never a failure).
 */
import { supabase } from './supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The client-minted idempotency key riding on a create request, if valid. */
export function clientIdOf(body: unknown): string | null {
  const raw = (body as { client_id?: unknown } | null | undefined)?.client_id;
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
}

/**
 * Call before inserting. Strips any client_id that leaked into `fields` via a
 * body spread (it must never reach a table whose column isn't migrated), then:
 * returns the EXISTING row when this create already committed (the request is
 * a replay — respond 200 with it, run no side effects again), or null to
 * proceed with the insert — with client_id stamped into `fields` when the
 * table has the column.
 */
export async function beginIdempotentCreate(
  table: string,
  userId: string,
  body: unknown,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  delete fields.client_id;
  const clientId = clientIdOf(body);
  if (!clientId) return null;

  const { data: existing, error } = await supabase
    .from(table).select('*')
    .eq('user_id', userId).eq('client_id', clientId)
    .maybeSingle();
  if (error) return null; // column not migrated yet — plain create
  if (existing) return existing as Record<string, unknown>;
  fields.client_id = clientId;
  return null;
}

/**
 * Call when the insert errored. A 23505 unique violation with a client_id in
 * play means a concurrent replay of the same create won the race — the row
 * exists, so fetch and return it (respond 200). Returns null when the error
 * was anything else (fall through to the normal error response: if the 23505
 * came from a different unique constraint, this select finds nothing).
 */
export async function recoverIdempotentRace(
  table: string,
  userId: string,
  body: unknown,
  error: { code?: string } | null | undefined,
): Promise<Record<string, unknown> | null> {
  const clientId = clientIdOf(body);
  if (!clientId || error?.code !== '23505') return null;
  const { data: existing } = await supabase
    .from(table).select('*')
    .eq('user_id', userId).eq('client_id', clientId)
    .maybeSingle();
  return (existing as Record<string, unknown> | null) ?? null;
}
