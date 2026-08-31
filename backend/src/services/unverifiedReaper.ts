// Reap abandoned unverified signups. An account that was never verified can
// never be logged into and owns no data (a JWT is only issued after
// verification), so deleting rows older than the grace window just frees the
// email address and stops orphan rows accumulating. Idempotent + fail-soft:
// once there is nothing old and unverified, it deletes nothing.
export const UNVERIFIED_GRACE_DAYS = 7;

interface MinimalClient {
  from(table: string): any;
}

export async function reapUnverifiedUsers(
  client: MinimalClient,
  graceDays: number = UNVERIFIED_GRACE_DAYS,
  nowMs: number = Date.now(),
): Promise<number> {
  const cutoff = new Date(nowMs - graceDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from('users')
    .delete()
    .eq('email_verified', false)
    .lt('created_at', cutoff)
    .select('id');
  if (error) throw error;
  return data ? data.length : 0;
}
