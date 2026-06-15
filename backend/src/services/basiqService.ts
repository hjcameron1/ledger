/**
 * Basiq Open Banking service (API v3)
 * Handles authentication, user management, account & transaction fetching.
 */

const BASE = process.env.BASIQ_BASE_URL ?? 'https://au-api.basiq.io';

// Thrown when Basiq rejects a request because the user's bank consent is no
// longer valid (expired, revoked, or otherwise unauthorised). Lets routes map
// it to a clear, recoverable 401 instead of a generic 500.
export class BasiqConsentExpiredError extends Error {
  constructor(message = 'Basiq consent expired or revoked') {
    super(message);
    this.name = 'BasiqConsentExpiredError';
  }
}

// Inspects a failed Basiq response and throws BasiqConsentExpiredError when the
// status/body indicates an invalid or expired consent, so callers can recover.
function throwIfConsentExpired(status: number, body: string): void {
  // 403 = forbidden (revoked consent); 401 = unauthorised. Basiq also surfaces
  // consent problems via error codes in the body even on other 4xx statuses.
  const lower = body.toLowerCase();
  const consentSignals =
    lower.includes('consent') ||
    lower.includes('access-denied') ||
    lower.includes('invalid-authorization') ||
    lower.includes('unauthorized');
  if (status === 401 || status === 403 || (status >= 400 && status < 500 && consentSignals)) {
    throw new BasiqConsentExpiredError(`Basiq consent invalid (${status}): ${body}`);
  }
}

// ─── Token cache ─────────────────────────────────────────────────────────────

let _tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const apiKey = process.env.BASIQ_API_KEY;
  if (!apiKey) throw new Error('BASIQ_API_KEY is not set');

  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Basiq-Version': '3.0',
    },
    body: 'scope=SERVER_ACCESS',
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Basiq /token ${res.status}: ${txt}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _tokenCache.token;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BasiqUser {
  id: string;
  email: string;
}

export interface BasiqAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  availableFunds?: string;
  accountNo?: string;
  bsb?: string;
  status: string;
  class?: { type: string; product?: string };
  institution: string;
}

export interface BasiqTransaction {
  id: string;
  account: string;   // Basiq account ID
  amount: string;    // e.g. "-12.50"
  currency: string;
  postDate: string;  // "YYYY-MM-DD"
  description: string;
  type: 'debit' | 'credit' | string;
  enrich?: {
    merchant?: { businessName?: string };
    category?: { anzsic?: { division?: string; title?: string } };
  };
}

// ─── User ────────────────────────────────────────────────────────────────────

export async function createBasiqUser(email: string, mobile?: string): Promise<BasiqUser> {
  const token = await getAccessToken();
  const body: Record<string, string> = { email };
  if (mobile) body.mobile = mobile;

  const res = await fetch(`${BASE}/users`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Basiq-Version': '3.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Create Basiq user ${res.status}: ${txt}`);
  }

  return res.json() as Promise<BasiqUser>;
}

// ─── Auth link ───────────────────────────────────────────────────────────────

export async function getAuthLink(basiqUserId: string, mobile?: string): Promise<string> {
  const token = await getAccessToken();

  const body: Record<string, string> = {};
  if (mobile) body.mobile = mobile;

  const res = await fetch(`${BASE}/users/${basiqUserId}/auth_link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Basiq-Version': '3.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Get auth link ${res.status}: ${txt}`);
  }

  const data = (await res.json()) as { links: { public: string } };
  return data.links.public;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function getBasiqAccounts(basiqUserId: string): Promise<BasiqAccount[]> {
  const token = await getAccessToken();

  const res = await fetch(`${BASE}/users/${basiqUserId}/accounts`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Basiq-Version': '3.0',
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throwIfConsentExpired(res.status, txt);
    throw new Error(`Get accounts ${res.status}: ${txt}`);
  }

  const data = (await res.json()) as { data?: BasiqAccount[] };
  return data.data ?? [];
}

// ─── Transactions ─────────────────────────────────────────────────────────────

// Hard ceiling on transactions accumulated across all pages, to avoid runaway
// API calls for users with very long histories.
const MAX_TRANSACTIONS = 2000;

export async function getBasiqTransactions(
  basiqUserId: string,
  accountId?: string,
  limit = 500,
): Promise<BasiqTransaction[]> {
  const token = await getAccessToken();

  const params = new URLSearchParams({ limit: String(limit) });
  if (accountId) params.set('filter', `account.id.eq('${accountId}')`);

  // First page is built from our params; subsequent pages follow Basiq's
  // absolute links.next URL until it's absent or we hit the safety cap.
  let url: string | null = `${BASE}/users/${basiqUserId}/transactions?${params}`;
  const all: BasiqTransaction[] = [];

  while (url && all.length < MAX_TRANSACTIONS) {
    const res: Response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Basiq-Version': '3.0',
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throwIfConsentExpired(res.status, txt);
      throw new Error(`Get transactions ${res.status}: ${txt}`);
    }

    const data = (await res.json()) as {
      data?: BasiqTransaction[];
      links?: { next?: string };
    };
    if (data.data?.length) all.push(...data.data);

    url = data.links?.next ?? null;
  }

  return all.slice(0, MAX_TRANSACTIONS);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maps Basiq institution code to display name */
export function institutionName(code: string): string {
  const MAP: Record<string, string> = {
    'AU00000': 'ANZ',
    'AU00001': 'CommBank',
    'AU00002': 'Westpac',
    'AU00003': 'NAB',
    'AU00004': 'St George',
    'AU00005': 'Bank of Melbourne',
    'AU00006': 'BankSA',
    'AU00101': 'Macquarie',
    'AU00301': 'ING',
    'AU00501': 'Bendigo Bank',
    'AU00601': 'Bank of Queensland',
    'AU00701': 'Suncorp',
    'AU01001': 'Up',
    'AU01101': 'UBank',
  };
  // Basiq sometimes uses full names like "au-ANZ" or codes
  if (MAP[code]) return MAP[code];
  // strip "au-" prefix and normalise
  return code.replace(/^au-/i, '').replace(/^AU/i, '').replace(/-/g, ' ').trim() || code;
}

/** Maps Basiq account class type to our account_type enum */
export function mapAccountType(classType?: string): string {
  const MAP: Record<string, string> = {
    transaction: 'Everyday',
    savings: 'Savings',
    'term-deposit': 'Term Deposit',
    mortgage: 'Mortgage',
    investment: 'Investment',
    super: 'Super',
    foreign: 'Foreign Currency',
  };
  return MAP[classType ?? ''] ?? 'Everyday';
}
