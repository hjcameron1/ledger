/**
 * The timezone list two screens share.
 *
 * Settings → Profile sets the account's timezone; the Telegram screen shows the
 * briefing's send time against one. They must offer the same list, so it lives
 * here rather than being copied into both — a second copy is how the two drift
 * into disagreeing about what a zone is called.
 *
 * The runtime's full IANA list when it has one, with a curated fallback for
 * older browsers.
 */
export const TIMEZONES: string[] = (() => {
  try {
    const v = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (v) return v('timeZone');
  } catch { /* fall through */ }
  return [
    'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide',
    'Australia/Perth', 'Pacific/Auckland', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo',
    'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'UTC',
  ];
})();
