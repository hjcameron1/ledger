# Connecting an App to Ledger (Ecosystem Integration Guide)

How another app in the ecosystem (PAssistant today; JobEasy, Travel, Fitness,
mobile, widgets, … next) pairs with a user's Ledger account and reads their live
financial summary — using the same flow, the same API, and the same look.

This document is the single reference for onboarding a **new consuming app**. It
describes the exact contract PAssistant already implements, so a new app can copy
it verbatim.

---

## 1. Principles (read these first)

1. **Ledger owns all financial data.** Consuming apps store **no** finance
   records — not a balance, not a transaction. They store only a **link token**
   and fetch a **live, read-only summary** on demand.
2. **Read-only by construction.** Every route behind the integration auth is a
   GET that returns a summary. No consumer can write finance data. Ever.
3. **Per-app identity.** Each app authenticates with its **own** shared secret
   (an "app key"). There is never a single global key.
4. **Per-user consent.** A user explicitly pairs the two apps with a one-time
   **pairing code** they generate in Ledger. The consuming app exchanges that code
   for a durable **link token** scoped to that one user.
5. **Fail soft.** A Ledger outage, a revoked token, or a not-yet-paired user must
   degrade gracefully in the consuming app — never crash it.
6. **One summary contract.** Everyone binds to the same versioned
   `FinancialSummary` shape (`schema_version: "1.0"`). Additive changes only.

---

## 2. The pairing flow at a glance

Three legs, three different authentications:

```
                 ┌─────────────────────────────────────────────────────────┐
                 │  LEDGER  (owner of data + Integration API)               │
                 └─────────────────────────────────────────────────────────┘
   (1) generate code        (2) redeem code            (3) read summary
   user is logged in        app key only               app key + link token
   POST /link/code          POST /link/redeem          GET /summary
        ▲                        ▲                          ▲
        │ JWT (Ledger user)      │ Bearer <app key>         │ Bearer <app key>
        │                        │                          │ X-Link-Token: <token>
        │                        │                          │
   ┌────┴─────┐            ┌─────┴──────────────────────────┴─────┐
   │  Ledger  │            │        CONSUMING APP (e.g. PAssistant) │
   │   web UI │            │  backend proxy + one token column      │
   └──────────┘            └────────────────────────────────────────┘
```

1. **Generate** — In Ledger, the logged-in user opens **Settings → Connected
   Apps** and taps *Generate pairing code*. Ledger returns a short human-typeable
   code shaped `LEDG-XXXX-XXXX` (single use, does not expire until redeemed).
2. **Redeem** — The user pastes that code into the consuming app's *Connect*
   screen. The consuming app's **backend** calls Ledger's `link/redeem` with its
   **app key**, receives a durable **link token**, and stores it against that
   user. The code is now spent.
3. **Read** — Whenever the consuming app needs finance data, its backend calls
   Ledger's `summary` with its **app key + the stored link token**. Ledger
   resolves the token to the Ledger user and returns their live summary. Each read
   stamps `last_seen_at` so Ledger can show sync health.

To **disconnect**, the consuming app deletes its stored token; the user can also
revoke the link from Ledger's Connected Apps screen (which nulls the token
server-side — the consuming app's next read gets a `401` and shows "reconnect").

---

## 3. Prerequisites — provisioning a new app (done on the Ledger side)

Before a new app can integrate, Ledger must know about it. Two one-time steps:

### 3a. Issue the app an app key

App keys live in Ledger's backend env var **`INTEGRATION_KEYS`**, a comma-separated
list of `appId:secret` pairs:

```
INTEGRATION_KEYS=passistant:pa_live_9f3c…,jobeasy:je_live_4d21…
```

- `appId` is the stable identifier stored on each link (`integration_links.app_id`)
  and shown in Ledger's Connected Apps list. Keep it short and lowercase
  (`passistant`, `jobeasy`, `travel`).
- The secret is a long random string. Generate one per app; never reuse.
- Give the secret to that app's backend as **`LEDGER_INTEGRATION_KEY`** (see §5).

Parsing is in [`backend/src/middleware/integrationAuth.ts`](../backend/src/middleware/integrationAuth.ts)
(`keyMap()`), cached per process — a deploy is needed to pick up a new key.

### 3b. Give it a friendly name + icon in Ledger's Connected Apps UI

So the new app shows up named nicely (not as a raw id), add an entry to
`APP_META` in [`frontend/src/pages/Settings.tsx`](../frontend/src/pages/Settings.tsx):

```ts
const APP_META: Record<string, { name: string; icon: string }> = {
  passistant: { name: 'PAssistant', icon: '🤖' },
  jobeasy:    { name: 'JobEasy',    icon: '💼' },   // ← new app
};
```

Unknown ids still render (falling back to the raw id + 🔗), but this is what makes
it look first-class.

---

## 4. API reference (Ledger Integration API v1)

Base path: `${LEDGER_API_URL}/api/integration`. Defined in
[`backend/src/routes/integration.ts`](../backend/src/routes/integration.ts).
Middleware is per-route because the three legs authenticate differently.

### 4a. `POST /link/code` — mint a pairing code  *(provider side; the user does this in Ledger)*

- **Auth:** Ledger user JWT (`authenticate`). A consuming app never calls this.
- **Response `201`:** `{ "code": "LEDG-AB2C-9XYZ", "expires_at": null }`

### 4b. `POST /link/redeem` — exchange code → token  *(consuming app calls this)*

- **Auth:** `Authorization: Bearer <app key>` (`requireAppKey`).
- **Body:** `{ "code": "LEDG-AB2C-9XYZ" }`
- **Response `200`:** `{ "token": "<durable link token>" }`
- **Errors:** `400` invalid/already-used code · `401` bad app key.
- Store the returned token against the current user in **your** database. Treat it
  like a password (opaque secret, never logged, never sent to the browser).

### 4c. `GET /summary` — read the live financial summary  *(consuming app calls this)*

- **Auth:** `Authorization: Bearer <app key>` **and** one of:
  - `X-Link-Token: <token>` — preferred, the paired path; **or**
  - `X-User-Email: <email>` — legacy fallback for setups that never paired.
- **Response `200`:** the `FinancialSummary` object (see §6).
- **Errors:** `401` invalid/revoked token · `404` no Ledger account for that user.
- Only `X-Link-Token` reads stamp `last_seen_at`, so **always prefer the token
  path** — it's what powers Ledger's sync-health display.

### 4d. Provider-side link management (Ledger's own Connected Apps UI)

These are used by Ledger's Settings screen, not by consuming apps, but they define
what a user sees:

- `GET  /links`      → `{ links: [{ id, app_id, status, created_at, redeemed_at, last_seen_at }] }` (JWT)
- `DELETE /links/:id` → revoke a link (nulls the token; the app loses access on its next read) (JWT)

Health shown per link: **Connected** (synced ≤ 3 days), **Connected · awaiting
first sync** (active, never read), **Not syncing** (active but no read in > 3
days — token may have been revoked or the app is idle), **Waiting to connect**
(code minted, not yet redeemed).

### Auth header cheat-sheet

| Leg              | `Authorization`          | Extra header                 | Who calls it        |
|------------------|--------------------------|------------------------------|---------------------|
| generate code    | Ledger user JWT          | —                            | Ledger web UI       |
| redeem code      | `Bearer <app key>`       | —                            | Consuming backend   |
| read summary     | `Bearer <app key>`       | `X-Link-Token: <token>`      | Consuming backend   |

---

## 5. What a new consuming app must build

PAssistant's implementation is the reference. Mirror these four pieces.

### 5a. Config (env)

```
LEDGER_API_URL=https://<ledger-backend-host>      # no trailing slash
LEDGER_INTEGRATION_KEY=<the secret half of your INTEGRATION_KEYS entry>
```

### 5b. Storage — one nullable column on your user

Add a single token column to your user table. No other finance storage.

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS ledger_link_token TEXT;
```

### 5c. Backend — a thin proxy + pairing endpoints

Copy the shape from PAssistant
([`backend/src/routes/finance.ts`](../../passistant/backend/src/routes/finance.ts) +
[`services/financeService.ts`](../../passistant/backend/src/services/financeService.ts)):

- `POST /finance/link` — read the pasted `code`, call Ledger `link/redeem` with
  your app key, save the returned token on the user, return `{ connected: true }`.
- `GET  /finance/link` — `{ connected: !!user.ledger_link_token }` (drives the UI).
- `DELETE /finance/link` — null the token → `{ connected: false }`.
- `GET  /finance/summary` — load the user's token, call Ledger `summary` with
  `Bearer <app key>` + `X-Link-Token`, return the JSON.

Reference client (`financeService.ts`) — note the **fail-soft** returns and the
short **cache (performance only, not storage)**:

```ts
const headers = { Authorization: `Bearer ${LEDGER_INTEGRATION_KEY}` };
if (token) headers['X-Link-Token'] = token; else headers['X-User-Email'] = email;
const { data } = await axios.get(`${LEDGER_API_URL}/api/integration/summary`, { headers, timeout: 8000 });
// 401 → "Ledger link was revoked — reconnect in Settings"
// 404 → "No linked Ledger account for this user"
// network → serve last cached value if we have one ("stale beats blank")
```

Rules that keep the ecosystem consistent:

- **Never** persist any field of the summary. Cache in memory with a short TTL
  (PAssistant uses 10 min) purely so repeated opens don't hammer Ledger.
- **Never** expose the app key or the link token to the browser. All Ledger calls
  are backend-to-backend.
- On `401`, surface a "reconnect" prompt; on network error, prefer the last cached
  summary over a blank screen.

### 5d. Frontend — the Connect screen (the shared look)

Show a *Connect* card when unlinked; the live summary when linked, with a quiet
*Disconnect* control. Keep the copy and the input format identical so every app
feels the same. Reference: PAssistant
[`frontend/src/pages/Finance.tsx`](../../passistant/frontend/src/pages/Finance.tsx).

```tsx
<Card>
  <h3 className="font-semibold mb-1">Connect Ledger</h3>
  <p className="text-sm text-zinc-400 mb-4">
    In Ledger, go to <span className="font-medium">Settings → Connected Apps</span> and generate
    a pairing code, then paste it here. {AppName} stores none of your finance data — it reads a
    live summary from Ledger.
  </p>
  <div className="flex flex-col sm:flex-row gap-2 max-w-md">
    <input
      value={code}
      onChange={(e) => setCode(e.target.value)}
      placeholder="LEDG-XXXX-XXXX"
      className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm tracking-widest uppercase"
    />
    <button onClick={connect} disabled={!code.trim() || saving} className="btn-primary text-sm disabled:opacity-50">
      {saving ? 'Connecting…' : 'Connect'}
    </button>
  </div>
</Card>
```

**Look tokens to keep identical** (both apps use the shared design-kit):

- Container: `<Card>` from the design-kit.
- Primary action: the `btn-primary` class (brand-coloured, same across apps).
- Code input: `tracking-widest uppercase`, placeholder `LEDG-XXXX-XXXX`.
- Muted copy: `text-sm text-zinc-400`; emphasise the path with
  `<span className="font-medium">Settings → Connected Apps</span>`.
- Errors: `text-sm text-red-500 mt-2`.
- Disconnect: a quiet `text-zinc-400 hover:text-red-500` text button, not a
  prominent danger button.

The always-say line — **"{App} stores none of your finance data — it reads a live
summary from Ledger."** — is intentional and should appear in every consumer, so
users get the same trust guarantee everywhere.

---

## 6. The Financial Summary contract (`schema_version: "1.0"`)

The exact JSON returned by `GET /summary`. Money is already FX-converted to the
user's preferred `currency`; values are plain numbers. Source of truth:
[`backend/src/services/integrationSummary.ts`](../backend/src/services/integrationSummary.ts).

```jsonc
{
  "schema_version": "1.0",
  "as_of": "2026-07-14T02:31:00.000Z",   // ISO ts of the underlying net-worth snapshot
  "currency": "AUD",
  "net_worth": 152340.55,
  "cash": 18200.00,
  "bank_accounts":  [ { "id": "…", "name": "Everyday", "balance": 18200, "currency": "AUD" } ],
  "credit_cards":   [ { "id": "…", "name": "Amex", "balance_owing": 1240.5, "currency": "AUD" } ],
  "investments":    { "total": 96000, "holdings": [ { "id": "…", "name": "VAS", "value": 42000 } ] },
  "loans":          [ { "id": "…", "name": "Car loan", "balance": 12000 } ],
  "properties":     [],                  // reserved — Ledger has no property model yet
  "monthly_income":  7200.00,
  "monthly_expenses": 4100.00,
  "savings_rate":     0.4306,            // (income-expenses)/income, 0..1; null if income is 0
  "available": true
}
```

**Binding rules for consumers**

- Treat every field as potentially absent and default gracefully — you may consume
  a newer Ledger that added optional fields, or an older summary.
- Do **not** hard-fail on unknown fields; additive changes stay within `"1.0"`.
- A breaking change bumps to `"2.0"` at a **new path** — the old one keeps working.
- `available: false` (plus an `error` string) is what your own proxy returns when
  Ledger is unreachable / unpaired; the real Ledger summary always has
  `available: true`.

---

## 7. Onboarding checklist for a new app

**On Ledger (provider):**
- [ ] Add `appId:secret` to `INTEGRATION_KEYS`, redeploy backend.
- [ ] Add an `APP_META` entry (name + icon) in Settings.tsx so it shows nicely.

**On the new app (consumer):**
- [ ] Set `LEDGER_API_URL` + `LEDGER_INTEGRATION_KEY`.
- [ ] Add the `ledger_link_token` column to its user table.
- [ ] Implement the four backend endpoints (redeem / status / disconnect / summary
      proxy) with fail-soft + a short in-memory cache.
- [ ] Build the *Connect* card using the shared look (§5d), including the
      "stores none of your finance data" line.
- [ ] Verify: generate a code in Ledger → paste in the new app → summary loads →
      the link shows **Connected** in Ledger's Connected Apps within one read.

---

## 8. Security notes

- App key + link token are **backend-only** secrets. Never ship either to a browser
  or a mobile client; proxy through your backend.
- The link token is user-scoped and revocable from either side; revoking on Ledger
  nulls it server-side so a leaked token stops working immediately.
- The whole surface is read-only — there is no write path a consumer can reach.
- Log booleans about connection state, never the token or key values.

---

*Provider: Ledger Integration API v1. Reference consumer: PAssistant
(`Finance` page + `/api/finance/*`). Questions: start from
[`backend/src/routes/integration.ts`](../backend/src/routes/integration.ts).*
