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

export function formatPercent(value: number, decimals = 2): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function formatShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short',
  });
}

export function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.round((date.getTime() - now.getTime()) / 86400000);

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
    day: 'numeric', month: 'short',
  });
}

export function classifyChange(value: number): 'positive' | 'negative' | 'neutral' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'neutral';
}

export function colorForChange(value: number, invert = false): string {
  if (invert) {
    return value > 0 ? 'text-[#ef4444]' : value < 0 ? 'text-[#22c55e]' : 'text-[#6b6b6b]';
  }
  return value > 0 ? 'text-[#22c55e]' : value < 0 ? 'text-[#ef4444]' : 'text-[#6b6b6b]';
}

export function bgForChange(value: number): string {
  if (value > 0) return 'bg-[#22c55e]/10 text-[#22c55e]';
  if (value < 0) return 'bg-[#ef4444]/10 text-[#ef4444]';
  return 'bg-[#6b6b6b]/10 text-[#6b6b6b]';
}

export function daysUntil(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - now.getTime()) / 86400000);
}

export function getCurrentFinancialYear(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12
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
