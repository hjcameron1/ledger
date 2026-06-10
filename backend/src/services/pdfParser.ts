/**
 * PDF Parser — extracts text with pdfjs-dist, then sends to Gemini 1.5 Flash
 * to extract structured financial data.  Falls back to Claude if
 * GEMINI_API_KEY is not set.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface ParsedTransaction {
  date: string;          // YYYY-MM-DD
  merchant: string;
  amount: number;        // negative = debit/expense, positive = credit/income
  type: 'debit' | 'credit';
  category?: string;
}

export interface ParsedBankStatement {
  name: string | null;
  institution: string | null;
  account_type: string;
  balance: number | null;
  bsb: string | null;
  account_number: string | null;
  currency: string;
  transactions: ParsedTransaction[];
}

export interface ParsedCardStatement {
  institution: string | null;
  card_name: string | null;
  statement_period: string | null;
  closing_balance: number | null;
  credit_limit: number | null;
  minimum_payment: number | null;
  due_date: string | null;
  transactions: ParsedTransaction[];
}

export interface ParsedSubscriptionStatement {
  subscriptions: Array<{
    name: string;
    amount: number;
    frequency: string;
    next_charge_date: string | null;
    category: string;
  }>;
}

// ─── Text extraction ──────────────────────────────────────────────────────────

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(buffer);
    const doc = await pdfjsLib.getDocument({
      data,
      useWorkerFetch: false,
      useSystemFonts: true,
    }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text += content.items.map((item: any) => ('str' in item ? item.str : '')).join(' ') + '\n';
    }
    console.log('[pdfParser] extracted', text.length, 'chars from', doc.numPages, 'pages');
    return text;
  } catch (err) {
    console.warn('[pdfParser] extractPdfText error:', err);
    return '';
  }
}

/** Returns true if the text looks like a scanned/image PDF with no readable content. */
export function isGarbledText(text: string): boolean {
  return text.trim().length < 200;
}

// ─── Gemini parsing ───────────────────────────────────────────────────────────

function buildGeminiPrompt(text: string, documentType: string): string {
  const isBankOrCard = ['bank_statement', 'credit_card_statement', 'credit_card'].includes(documentType);
  const isCard       = ['credit_card_statement', 'credit_card'].includes(documentType);
  const isSub        = documentType === 'subscription_statement';
  const isSuper      = ['super_statement', 'super', 'superannuation'].includes(documentType);
  const isPortfolio  = ['investment_portfolio', 'portfolio', 'investment'].includes(documentType);
  const isPayslip    = ['payslip', 'pay_slip', 'payslip_statement'].includes(documentType);

  if (isPayslip) {
    return `You are a financial document parser specialising in AUSTRALIAN PAYSLIPS / pay advices from any employer or payroll system (Xero, MYOB, ADP, KeyPay/Employment Hero, Reckon, QuickBooks, etc.). All amounts are AUD.

Extract the pay details. Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "employer": "the employing company / business name, or null",
  "abn": "the employer ABN as shown (digits, spaces ok), or null",
  "employee_name": "the employee's name, or null",
  "employment_type": "full_time | part_time | casual | contractor",
  "pay_period_start": "YYYY-MM-DD or null",
  "pay_period_end": "YYYY-MM-DD or null",
  "payment_date": "YYYY-MM-DD or null",
  "pay_frequency": "weekly | fortnightly | monthly",
  "gross_pay": 0,
  "net_pay": 0,
  "tax_withheld": 0,
  "super_amount": 0,
  "super_rate": null,
  "ytd_gross": null,
  "ytd_tax": null,
  "ytd_super": null,
  "leave_balance": null,
  "sick_leave_balance": null,
  "hourly_rate": null,
  "allowances": [{ "name": "Travel allowance", "amount": 0 }],
  "deductions": [{ "name": "Union fees", "amount": 0 }]
}

Rules:
- gross_pay / net_pay / tax_withheld are for THIS pay period (plain numbers, no $ or commas). tax_withheld = PAYG / income tax / tax withheld for the period.
- super_amount = the EMPLOYER super contribution (SG / superannuation guarantee) for this period.
- super_rate = the super contribution percentage if printed (e.g. 11.5), otherwise null.
- employment_type: infer from wording. "Casual" → casual; "Permanent part-time"/"part time" → part_time; "Permanent full-time"/"full time"/salary → full_time; "Contractor"/"ABN"/"contract" → contractor. Default to full_time if a regular salaried payslip with no hint.
- pay_frequency: infer from the period length or stated frequency. ~7 days → weekly; ~14 days → fortnightly; ~1 month → monthly.
- ytd_* are the year-to-date totals if shown (gross, tax, super), else null.
- leave_balance = available annual/holiday leave balance (hours or days as shown); sick_leave_balance = available personal/sick leave balance. Plain numbers or null.
- hourly_rate = the base hourly rate if shown (for casual/hourly workers), else null.
- allowances / deductions: each itemised line as { name, amount }. Empty array [] if none. amount is a plain positive number.
- Use null only where genuinely absent. Keep all strings ASCII-safe, no quotes/apostrophes.

DOCUMENT TEXT:
${text}`;
  }

  if (isSuper) {
    return `You are a financial document parser specialising in AUSTRALIAN SUPERANNUATION statements (AustralianSuper, Hostplus, REST, Aware Super, UniSuper, HESTA, Cbus, Australian Retirement Trust, ART, Sunsuper, MLC, AMP, Colonial First State, etc.).

Extract the member's super details from the document text. All amounts are AUD.

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "fund_name": "the super fund's name, e.g. AustralianSuper, or null",
  "member_number": "the member/account number as shown, or null",
  "balance": 123456.78,
  "investment_option": "the investment option / strategy name, e.g. High Growth, Balanced, Indexed Diversified, or null",
  "employer_contributions": 0,
  "personal_contributions": 0,
  "insurance_details": "a short human-readable summary of any insurance cover (Death/Life, TPD, Income Protection) with cover amounts and premiums if shown, e.g. 'Death $250,000; TPD $250,000; Income Protection $4,500/mo. Premiums $12.50/wk' — or null if none present",
  "fees": 0
}

Rules:
- balance is the member's CURRENT/closing account balance (Total / Closing balance / Account balance). Plain number, no $ or commas.
- member_number: the member number, membership number, account number, or client number printed on the statement.
- investment_option: the named investment option or strategy. If the balance is split across multiple options, list the primary/largest, or join them with " / ".
- employer_contributions: total EMPLOYER / SG / concessional employer contributions for the statement period (plain number, 0 if not shown).
- personal_contributions: total MEMBER / personal / voluntary / after-tax contributions for the period (plain number, 0 if not shown). Map "member contributions" here.
- insurance_details: summarise cover types and amounts as a single string. If no insurance is mentioned, set to null.
- fees: the TOTAL fees and costs deducted for the period (administration + investment + other fees combined) as a plain positive number. 0 if not shown.
- Numbers must be plain numbers (no $, no commas, no text). Use null only for the string fields when genuinely absent.

DOCUMENT TEXT:
${text}`;
  }

  if (isPortfolio) {
    return `You are a financial document parser specialising in BROKER ACTIVITY STATEMENTS and portfolio holdings reports (CommSec, SelfWealth, Stake, Interactive Brokers, CMC Markets, Sharesight, etc.).

Your job: determine the investor's CURRENT HOLDINGS from the document and return them as JSON.

The document may be one of two kinds:
1. A HOLDINGS SNAPSHOT — a table that already lists each stock with quantity, price and market value. Use those numbers directly.
2. An ACTIVITY / TRANSACTION STATEMENT — a chronological list of BUY and SELL trades (and possibly dividends). In this case you MUST aggregate the trades per ticker into a net current holding:
   - shares_owned = total bought − total sold (ignore tickers whose net is 0 — they were fully sold).
   - cost_basis  = net amount paid for the shares still held, in that holding's NATIVE currency, INCLUDING brokerage/fees where shown. If you cannot precisely attribute cost to remaining shares, use (remaining shares × average buy price).

CURRENCY IS THE MOST IMPORTANT FIELD. Australian investors commonly hold BOTH AUD (ASX) and USD (US-listed) stocks in the same statement. Determine each holding's native currency carefully:
- ASX / Australian-listed stocks (e.g. BHP, CBA, VAS, CSL, WES, NAB, TLS) → "AUD", market "ASX".
- US-listed stocks (NYSE / NASDAQ — e.g. AAPL, MSFT, TSLA, VOO, NVDA, SPY) → "USD", market "NASDAQ" or "NYSE".
- Use explicit signals in the document: currency columns/labels ("USD", "AUD", "US$", "A$"), exchange names, settlement currency, or a "Currency" field. Do NOT assume everything is AUD — infer USD for clearly US-listed tickers even if the symbol is unlabelled.
- crypto → its quote currency (usually "USD"); precious metals → "USD".

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "portfolio_name": "broker / account name or null",
  "holdings": [
    {
      "ticker": "AAPL",
      "name": "Apple Inc.",
      "market": "NASDAQ",
      "asset_type": "stock",
      "currency": "USD",
      "shares_owned": 12.5,
      "cost_basis": 2150.00,
      "current_price": null,
      "current_value": null
    }
  ]
}

This document may instead be a list of PHYSICAL / ALTERNATIVE assets — bonds, art, wine,
jewellery, watches. If so, extract each as a holding too: set ticker to "", market to the
matching label (Bonds|Art|Wine|Jewellery), shares_owned to the quantity (default 1),
cost_basis to the purchase price, current_value to the latest/valuation value, and add a
"details" object with the extra fields:
- bond:      { maturity_date, expected_maturity_value, purchase_date }
- art:       { artist, collection, year, medium, purchase_date, last_valuation_date }
- wine:      { producer, region, vintage, varietal, bottle_size, purchase_date }  (shares_owned = bottles)
- jewellery: { jewellery_type, brand, model, reference, materials:[{material,value}], purchase_date, last_valuation_date }

Rules:
- asset_type is one of: stock | etf | crypto | precious_metal | managed_fund | bond | art | wine | jewellery | other.
- currency is the 3-letter ISO code of the holding's NATIVE currency ("AUD" or "USD"), NOT the investor's home currency.
- shares_owned and cost_basis are in that holding's native currency. Plain numbers only (no $, no commas).
- cost_basis is the total amount paid for the shares still held, NOT the per-share price.
- Set current_price and current_value to null unless the document explicitly states a current/market value — they will be fetched live later.
- Include every distinct ticker that has a positive remaining quantity. Do not invent holdings that aren't in the document.

DOCUMENT TEXT:
${text}`;
  }

  if (isSub) {
    return `You are a financial document parser. Extract subscription data from the text below.

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "subscriptions": [
    {
      "name": "Service name",
      "amount": 9.99,
      "frequency": "monthly",
      "next_charge_date": "YYYY-MM-DD or null",
      "category": "Entertainment|Software|Telecommunications|Fitness|News|Other"
    }
  ]
}

DOCUMENT TEXT:
${text}`;
  }

  if (isCard) {
    return `You are a financial document parser. Extract all data from this credit card statement.

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "institution": "bank name or null",
  "card_name": "card product name or null",
  "statement_period": "e.g. 1 Mar 2026 - 31 Mar 2026 or null",
  "closing_balance": 1234.56,
  "credit_limit": 5000.00,
  "minimum_payment": 25.00,
  "due_date": "YYYY-MM-DD or null",
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "merchant": "Merchant or description",
      "amount": -45.00,
      "type": "debit",
      "category": "Groceries|Dining|Transport|Fuel|Entertainment|Fitness|Health|Rent|Utilities|Insurance|Shopping|Income|Transfer|Other"
    }
  ]
}

Rules:
- amount is NEGATIVE for purchases/debits (money spent), POSITIVE for payments/credits (money received)
- type is "debit" when amount < 0, "credit" when amount > 0
- Include ALL transactions listed — do not skip any
- Dates must be YYYY-MM-DD format
- Numbers must be plain numbers (no $ or commas)

DOCUMENT TEXT:
${text}`;
  }

  if (isBankOrCard) {
    return `You are a financial document parser. Extract all data from this bank statement.

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "accounts": [
    {
      "name": "account PRODUCT name printed on the statement (e.g. Smart Access, Everyday, Complete Access) — NEVER the account holder's personal name",
      "holder_name": "account holder's personal name or null",
      "institution": "bank name or null",
      "account_type": "Everyday|Savings|Offset|Term Deposit",
      "balance": 1234.56,
      "bsb": "012-345 or null",
      "account_number": "123456789 or null",
      "currency": "AUD",
      "transactions": [
        {
          "date": "YYYY-MM-DD",
          "merchant": "Description or merchant name",
          "amount": -45.00,
          "type": "debit",
          "category": "Groceries|Dining|Transport|Fuel|Entertainment|Fitness|Health|Rent|Utilities|Insurance|Shopping|Income|Transfer|Other"
        }
      ]
    }
  ]
}

Rules:
- amount is NEGATIVE for withdrawals/debits (money going out), POSITIVE for deposits/credits (money coming in)
- type is "debit" when amount < 0, "credit" when amount > 0
- Include ALL transactions listed — do not skip any
- Dates must be YYYY-MM-DD format
- Numbers must be plain numbers (no $ or commas)
- balance is the account's CURRENT / closing / available balance. ALWAYS extract it exactly as shown, even when it is small (e.g. 0.05, 0.50), exactly zero (0), or negative (an overdrawn account, e.g. -12.34). NEVER return null for balance when any closing/available/current balance figure is present on the statement — a value under $1 is still a real balance, not "no balance". Only use null if the statement genuinely shows no balance at all.

DOCUMENT TEXT:
${text}`;
  }

  // Generic / payslip / portfolio
  return `You are a financial document parser. Extract all structured financial data from the document text below.

Return ONLY valid JSON (no markdown, no explanation). Include all transactions, holdings, income details, or other financial data present.

Document type hint: ${documentType}

DOCUMENT TEXT:
${text}`;
}

/** Strip markdown code fences and extract the JSON object/array. */
function extractJson(raw: string): unknown {
  // Remove ```json ... ``` or ``` ... ``` fences
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Find first { or [
  const start = s.search(/[{[]/);
  if (start > 0) s = s.slice(start);
  return JSON.parse(s);
}

/**
 * Collapse the whitespace noise that pdfjs leaves behind (it joins every text
 * fragment with a space, producing long runs of spaces and blank lines). This
 * can cut the token count 20–40% with no loss of meaning, which keeps more
 * statements under Groq's per-minute token budget before we fall back to Claude.
 */
function compressWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')      // collapse runs of spaces/tabs
    .replace(/ *\n */g, '\n')      // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')   // cap consecutive blank lines
    .trim();
}

/** Rough token estimate (~4 chars/token for English + numbers). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export async function parseWithGemini(
  text: string,
  documentType: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const Groq = (await import('groq-sdk')).default;
  const groq = new Groq({ apiKey });

  const cleanText = compressWhitespace(text);
  const prompt = buildGeminiPrompt(cleanText, documentType);

  // Groq counts input tokens + reserved max_tokens together against the
  // per-minute TPM limit (12000 on the free tier). Reserving a flat 8000 for
  // output blew small/medium statements past the cap even when their actual
  // JSON output is tiny. Size the output reservation to what's plausibly needed
  // (scales with input) and leave a safety buffer under the TPM ceiling.
  const TPM_LIMIT = 12000;
  const SAFETY_BUFFER = 600;                      // prompt overhead + headroom
  const inputTokens = estimateTokens(prompt);
  const room = TPM_LIMIT - inputTokens - SAFETY_BUFFER;
  // Need at least ~1500 output tokens to hold a non-trivial statement's JSON.
  // If the input alone leaves less than that, even a minimal request would 413,
  // so skip Groq and fall straight to Claude instead of a guaranteed-fail call.
  const MIN_OUTPUT = 1500;
  if (room < MIN_OUTPUT) {
    throw new Error(
      `Input too large for Groq TPM budget (~${inputTokens} input tokens, need ${MIN_OUTPUT} output) — using Claude`,
    );
  }
  // Output JSON is usually a fraction of the input; cap at 8000, floor at 1500.
  const maxTokens = Math.max(MIN_OUTPUT, Math.min(8000, room));
  console.log(`[pdfParser] sending ~${inputTokens} input tokens to Groq (doc_type="${documentType}", max_tokens=${maxTokens})`);

  const t0 = Date.now();
  let completion;
  try {
    completion = await groq.chat.completions.create({
      // 70B handles large statements (40+ transactions) far more reliably than
      // 8b-instant, which truncated/mangled big JSON and silently fell back to Claude.
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      // JSON mode guarantees parseable output (no markdown fences / prose).
      // Prompt already instructs "Return ONLY a JSON object", which JSON mode requires.
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
    });
  } catch (error: unknown) {
    const e = error as { status?: number; message?: string; error?: unknown };
    if (e.status === 429) {
      console.log('[groq] 429 error details:', JSON.stringify(e.error || e.message));
    }
    throw error;
  }
  const raw = completion.choices[0]?.message?.content ?? '';
  console.log(`[pdfParser] Groq responded in ${Date.now() - t0}ms (${raw.length} chars)`);

  const parsed = extractJson(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Groq returned non-object JSON');
  }
  return parsed as Record<string, unknown>;
}

// ─── Public parsers (thin wrappers — kept for upload.ts compatibility) ─────────

export async function parseBankStatementText(
  text: string,
): Promise<{ accounts: ParsedBankStatement[] } | null> {
  try {
    const result = await parseWithGemini(text, 'bank_statement');
    console.log('[pdfParser] Gemini bank parse keys:', Object.keys(result));
    const typed = result as unknown as { accounts: ParsedBankStatement[] };

    // Enforce account-name priority: product/type > institution+type > last4 > account_type.
    // NEVER use the account holder's personal name.
    const accounts = Array.isArray(typed?.accounts) ? typed.accounts : [];
    for (const acc of accounts) {
      const raw = acc as unknown as Record<string, unknown>;
      const holder = String(raw.holder_name ?? '').trim();
      let accountName = String(acc.name ?? '').trim();

      // If the LLM put the holder's name in `name`, discard it.
      const looksLikeHolder =
        accountName &&
        holder &&
        accountName.toLowerCase() === holder.toLowerCase();
      const looksLikePerson =
        accountName &&
        !/\d/.test(accountName) &&
        accountName === accountName.toUpperCase() &&
        accountName.split(/\s+/).length >= 2;

      if (!accountName || looksLikeHolder || looksLikePerson) {
        const inst = String(acc.institution ?? '').trim();
        const at = String(acc.account_type ?? '').trim();
        const num = String(acc.account_number ?? '').replace(/\s/g, '');
        const last4 = num.length >= 4 ? `Account ${num.slice(-4)}` : '';
        accountName =
          (inst && at ? `${inst} ${at}` : at) || last4 || at || 'Account';
      }

      console.log('[parser] setting account name to:', accountName);
      acc.name = accountName;
      delete raw.holder_name;
    }

    return typed;
  } catch (err) {
    console.error('[pdfParser] Gemini bank parse error:', err);
    return null;
  }
}

export async function parseCreditCardStatementText(
  text: string,
): Promise<ParsedCardStatement | null> {
  try {
    const result = await parseWithGemini(text, 'credit_card_statement');
    console.log('[pdfParser] Gemini card parse keys:', Object.keys(result));
    return result as unknown as ParsedCardStatement;
  } catch (err) {
    console.error('[pdfParser] Gemini card parse error:', err);
    return null;
  }
}

export async function parseSubscriptionStatementText(
  text: string,
): Promise<ParsedSubscriptionStatement | null> {
  try {
    const result = await parseWithGemini(text, 'subscription_statement');
    console.log('[pdfParser] Gemini subscription parse keys:', Object.keys(result));
    return result as unknown as ParsedSubscriptionStatement;
  } catch (err) {
    console.error('[pdfParser] Gemini subscription parse error:', err);
    return null;
  }
}
