export function formatCurrency(
  amount: number,
  currency = 'AUD',
  compact = false
): string {
  const opts: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  };
  if (compact && Math.abs(amount) >= 1_000_000) {
    return `${currency === 'AUD' ? '$' : ''}${(amount / 1_000_000).toFixed(2)}M`;
  }
  if (compact && Math.abs(amount) >= 1_000) {
    return `${currency === 'AUD' ? '$' : ''}${(amount / 1_000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat('en-AU', opts).format(amount);
}

// ── Display timezone ─────────────────────────────────────────────────────────
// A single module-level timezone drives every date/time the app renders, so the
// user's preference (set in Settings) applies everywhere consistently. It only
// affects DISPLAY formatting — never the underlying numeric values used by
// net-worth or investment maths, which operate on amounts, not local dates.
let displayTimeZone: string | undefined; // undefined => fall back to browser zone

export function setDisplayTimeZone(tz?: string | null): void {
  if (!tz) { displayTimeZone = undefined; return; }
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: tz });
    displayTimeZone = tz;
  } catch {
    displayTimeZone = undefined; // ignore invalid zone, keep browser default
  }
}

export function getDisplayTimeZone(): string {
  return displayTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// A date-only string (YYYY-MM-DD, e.g. a bill due date) is a WALL date with no
// instant attached — it must read the same in every timezone. A full ISO
// timestamp is an instant and is converted to the display zone. This split is
// what keeps a "due 15 June" bill from ever showing as the 14th or 16th.

// Days-since-epoch for the calendar date as seen in the given timezone.
function dayNumberInTz(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const y = +(p.find(x => x.type === 'year')?.value ?? '1970');
  const m = +(p.find(x => x.type === 'month')?.value ?? '1');
  const day = +(p.find(x => x.type === 'day')?.value ?? '1');
  return Math.floor(Date.UTC(y, m - 1, day) / 86400000);
}

// Day-number for any date input: literal for wall dates, tz-resolved for instants.
function dayNumberOf(input: string, tz: string): number {
  if (DATE_ONLY.test(input)) {
    const [y, m, d] = input.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }
  return dayNumberInTz(new Date(input), tz);
}

export function formatPercent(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatDate(dateStr: string): string {
  // Wall date → render literally in UTC so it never shifts; instant → display zone.
  const isWall = DATE_ONLY.test(dateStr);
  const d = isWall ? new Date(`${dateStr}T00:00:00Z`) : new Date(dateStr);
  return d.toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: isWall ? 'UTC' : getDisplayTimeZone(),
  });
}

export function formatRelativeDate(dateStr: string): string {
  const tz = getDisplayTimeZone();
  const diffDays = dayNumberOf(dateStr, tz) - dayNumberInTz(new Date(), tz);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 0 && diffDays <= 7) return `In ${diffDays} days`;
  if (diffDays < 0 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;
  return formatDate(dateStr);
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    day: 'numeric', month: 'short', timeZone: getDisplayTimeZone(),
  });
}

export function colorForChange(value: number, invert = false): string {
  if (invert) {
    return value > 0 ? 'text-[#ef4444]' : value < 0 ? 'text-[#22c55e]' : 'text-[#6b6b6b]';
  }
  return value > 0 ? 'text-[#22c55e]' : value < 0 ? 'text-[#ef4444]' : 'text-[#6b6b6b]';
}

export function daysUntil(dateStr: string): number {
  const tz = getDisplayTimeZone();
  return dayNumberOf(dateStr, tz) - dayNumberInTz(new Date(), tz);
}

export function getCurrentFinancialYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
  if (month >= 7) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

// Australian financial year that a given date falls in, as "YYYY-YYYY"
// (matching getCurrentFinancialYear). FY runs 1 July → 30 June.
export function financialYearOf(dateStr: string): string {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  if (month >= 7) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

export function autoCategory(merchant: string): string {
  const m = merchant.toLowerCase();
  const rules: [string[], string][] = [
    [['woolworths', 'coles', 'aldi', 'iga', 'costco', 'harris farm'], 'Groceries'],
    [["mcdonald's", 'mcdonalds', 'kfc', 'uber eats', 'doordash', 'menulog', 'deliveroo', 'hungry jacks'], 'Dining'],
    [['netflix', 'stan', 'disney+', 'binge', 'kayo', 'foxtel'], 'Entertainment'],
    [['spotify', 'apple music', 'youtube premium'], 'Entertainment'],
    [['shell', 'bp', 'ampol', 'caltex', '7-eleven', 'united petroleum'], 'Fuel'],
    [['chemist warehouse', 'priceline', 'terry white', 'blooms'], 'Health'],
    [['jb hi-fi', 'jbhifi', 'apple store', 'harvey norman', 'officeworks'], 'Electronics'],
    [['qantas', 'virgin australia', 'jetstar', 'airbnb'], 'Travel'],
    [['uber', 'didi', 'ola', 'gocatch', 'opal', 'myki'], 'Transport'],
    [['fitness first', 'f45', 'anytime fitness', 'goodlife', 'ymca'], 'Fitness'],
    [['nrma', 'racv', 'allianz', 'aami', 'nib', 'medibank'], 'Insurance'],
    [['agl', 'origin energy', 'energy australia', 'sydney water'], 'Utilities'],
    [['telstra', 'optus', 'vodafone'], 'Telecommunications'],
    [['rent', 'lease', 'real estate'], 'Rent'],
  ];

  for (const [keywords, category] of rules) {
    if (keywords.some(k => m.includes(k))) return category;
  }
  return 'Uncategorised';
}
