/**
 * Fail fast on missing production secrets.
 *
 * Every fallback like `process.env.JWT_SECRET ?? 'dev-secret'` is a silent
 * catastrophe in production: the app boots looking healthy and signs every
 * session with a publicly-known string. The rule here: in production a missing
 * required secret refuses to start (a crashed deploy is visible; a quietly
 * insecure one is not); in development it warns and carries on.
 */

const REQUIRED_IN_PRODUCTION = ['JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Call once at startup, after dotenv has loaded. */
export function assertRequiredEnv(): void {
  const missing = REQUIRED_IN_PRODUCTION.filter((k) => {
    const v = process.env[k];
    return !v || v.includes('placeholder');
  });
  if (missing.length === 0) return;
  const msg = `missing required environment variables: ${missing.join(', ')}`;
  if (isProduction()) {
    console.error(`[env] FATAL: ${msg} — refusing to start.`);
    process.exit(1);
  }
  console.warn(`[env] ${msg} — continuing because NODE_ENV is not 'production'.`);
}

/** The one place the JWT signing secret comes from. Never falls back in production. */
export function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (isProduction()) throw new Error('JWT_SECRET is not set');
  return 'dev-secret';
}
