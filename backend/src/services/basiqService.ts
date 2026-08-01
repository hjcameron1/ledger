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

// Thrown when Basiq reports that the stored Basiq user no longer exists — e.g.
// the user was deleted at Basiq (manually or because the customer revoked data
// sharing). This is NOT a recoverable consent problem: the whole basiqUserId is
// dead and must be cleared locally, with the user reconnecting from scratch
// (which mints a brand-new Basiq user). Distinct from BasiqConsentExpiredError.
export class BasiqUserNotFoundError extends Error {
  constructor(message = 'Basiq user does not exist') {
    super(message);
    this.name = 'BasiqUserNotFoundError';
  }
}

// Inspects a failed Basiq response and throws BasiqUserNotFoundError when the
// status/body indicate the Basiq user itself is gone (HTTP 404 +
// code:"resource-not-found" / "requested user does not exist"). Must run BEFORE
// the consent check, since a deleted user needs a full reconnect, not a re-consent.
function throwIfUserDeleted(status: number, body: string): void {
  if (status !== 404) return;
  const lower = body.toLowerCase();
  if (
    lower.includes('resource-not-found') ||
    lower.includes('user does not exist') ||
    lower.includes('requested user does not exist')
  ) {
    throw new BasiqUserNotFoundError(`Basiq user not found (${status}): ${body}`);
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
  connection?: string;   // Basiq connection id this account belongs to
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

export interface BasiqBusinessDetails {
  businessName: string;
  businessIdNo: string;            // ABN/ACN digits
  businessIdNoType?: 'ABN' | 'ACN';
  businessAddress: {
    addressLine1: string;
    suburb: string;
    state: string;
    postcode: string;
    countryCode?: string;
  };
}

export async function createBasiqUser(
  email: string,
  mobile?: string,
  business?: BasiqBusinessDetails,
): Promise<BasiqUser> {
  const token = await getAccessToken();
  const body: Record<string, unknown> = { email };
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

// Delete the Basiq-side user, removing their open-banking connection data held
// at Basiq. Used on account deletion so the user's information doesn't linger
// with the third party. Treats 404 as success (already gone / never created).
export async function deleteBasiqUser(basiqUserId: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/users/${basiqUserId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Basiq-Version': '3.0',
    },
  });

  if (!res.ok && res.status !== 404) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Delete Basiq user ${res.status}: ${txt}`);
  }
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
    throwIfUserDeleted(res.status, txt);
    throwIfConsentExpired(res.status, txt);
    throw new Error(`Get accounts ${res.status}: ${txt}`);
  }

  // Basiq returns the accounts collection under `data` (an array), NOT `accounts`.
  const data = (await res.json()) as { data?: BasiqAccount[] };
  const accounts = data.data ?? [];
  console.log(`[basiq] GET /users/${basiqUserId}/accounts → HTTP ${res.status}, response.data.length = ${accounts.length}`);
  return accounts;
}

// ─── Connection job diagnostics ────────────────────────────────────────────────

export interface BasiqJobStep {
  title: string;                       // e.g. "retrieve-accounts", "retrieve-transactions"
  status: string;                      // pending | in-progress | success | failed
  result?: unknown;                    // on failure, holds { code, detail, ... }
}

export interface BasiqJobSummary {
  jobId: string;
  created?: string;
  updated?: string;
  steps: BasiqJobStep[];
}

// Fetches the most recent connection job for a Basiq user and returns its steps.
// Used to explain an empty accounts array — the `retrieve-accounts` step's status
// and error reveal whether the connection actually pulled accounts. Best-effort:
// throws only on a hard transport failure; callers should try/catch.
export async function getLatestJobSummary(basiqUserId: string): Promise<BasiqJobSummary | null> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/users/${basiqUserId}/jobs`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Basiq-Version': '3.0',
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Get jobs ${res.status}: ${txt}`);
  }

  const body = (await res.json()) as {
    data?: Array<{ id: string; created?: string; updated?: string; steps?: BasiqJobStep[] }>;
  };
  const jobs = body.data ?? [];
  if (jobs.length === 0) return null;

  // Newest last-updated (fall back to created) job.
  const latest = [...jobs].sort((a, b) =>
    (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''),
  )[0];

  return {
    jobId: latest.id,
    created: latest.created,
    updated: latest.updated,
    steps: latest.steps ?? [],
  };
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
      throwIfUserDeleted(res.status, txt);
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
    // Verified Basiq institution IDs
    'AU00000': 'Hooli (Sandbox)',
    'AU00601': 'ANZ',
    'AU04301': 'CommBank',
    'AU01001': 'NAB',
    'AU14201': 'Westpac',
    'AU20680': 'Up',
    'AU01201': 'Amex',
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
