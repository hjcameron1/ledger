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
