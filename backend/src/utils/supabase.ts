import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Lazy client — created on first use so dotenv (loaded by index.ts) has already run
let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key || url.includes('placeholder') || key === 'placeholder-key') {
      console.warn('Supabase credentials not configured — running in demo mode');
    }
    _supabase = createClient(
      url || 'https://placeholder.supabase.co',
      key || 'placeholder-key',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return _supabase;
}

// Convenience re-export so existing `import { supabase }` calls keep working
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Upsert that tolerates schema drift. This app's migrations are applied by hand in
 * Supabase, so the code sometimes writes a column that hasn't been added to the
 * table yet — PostgREST then fails the WHOLE write with PGRST204 ("Could not find
 * the 'X' column ... in the schema cache") and the user just sees "Save failed".
 *
 * Here we detect that specific error, drop the offending column(s), and retry, so
 * every other field still saves. Dropped columns are logged loudly (and returned)
 * so the drift is visible and can be fixed with the proper migration — it degrades
 * gracefully instead of losing the entire save. Any other error is returned as-is.
 */
export async function upsertTolerant(
  table: string,
  row: Record<string, unknown>,
  opts: { onConflict?: string } = {},
): Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null; dropped: string[] }> {
  const payload = { ...row };
  const dropped: string[] = [];

  // Cap retries at the number of columns so a persistent error can't loop forever.
  for (let attempt = 0; attempt <= Object.keys(row).length; attempt++) {
    const q = getSupabase().from(table).upsert(payload, opts).select().single();
    const { data, error } = await q;
    if (!error) return { data, error: null, dropped };

    const missing = error.code === 'PGRST204'
      ? error.message.match(/Could not find the '([^']+)' column/)?.[1]
      : undefined;
    if (!missing || !(missing in payload)) {
      return { data: null, error, dropped };
    }
    delete payload[missing];
    dropped.push(missing);
    console.warn(`[schema-drift] ${table}: column '${missing}' missing — dropped from write and retrying. Add it with a migration.`);
  }
  return { data: null, error: { message: 'upsertTolerant: exhausted retries' }, dropped };
}
