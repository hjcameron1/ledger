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

export async function parseWithGemini(
  text: string,
  documentType: string,
): Promise<Record<string, unknown>> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const Groq = (await import('groq-sdk')).default;
  const groq = new Groq({ apiKey });

  const prompt = buildGeminiPrompt(text, documentType);
  console.log(`[pdfParser] sending ${text.length} chars to Groq (doc_type="${documentType}")`);

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
      // Headroom so long statements aren't truncated mid-JSON.
      max_tokens: 8000,
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
