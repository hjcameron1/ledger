import Anthropic from '@anthropic-ai/sdk';

// Lazy client — created on first use so dotenv has already run by then
let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const key = process.env.CLAUDE_API_KEY;
    if (!key) throw new Error('CLAUDE_API_KEY is not set in environment');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

/**
 * Robustly parse JSON out of Claude's raw text response.
 * Handles: markdown code fences, trailing commas, unescaped control
 * characters, and truncated responses.
 */
function extractJSON(raw: string): Record<string, unknown> {
  // 1. Strip markdown code fences if present
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  // 2. Find the outermost { … } block
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.warn('[claudeService] No JSON object found in response');
    return {};
  }
  text = text.slice(start, end + 1);

  // 3. First attempt — parse as-is
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    console.warn('[claudeService] Initial JSON.parse failed, attempting sanitisation:', (firstErr as Error).message);
  }

  // 4. Sanitise common issues from financial document text:
  //    a. Remove ASCII control characters (tabs are ok, keep \t \n \r)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  //    b. Remove trailing commas before ] or }  (e.g. [1,2,3,] )
  text = text.replace(/,\s*([}\]])/g, '$1');

  //    c. Replace literal newlines / tabs inside string values with a space
  //       (matches content between quotes that spans lines)
  text = text.replace(/"([^"\\]*)"/g, (_match, inner: string) =>
    '"' + inner.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\') + '"'
  );

  // 5. Second attempt after sanitisation
  try {
    return JSON.parse(text);
  } catch (secondErr) {
    console.warn('[claudeService] Sanitised JSON.parse also failed:', (secondErr as Error).message);
  }

  // 6. Last resort — truncate to last valid closing brace
  //    Walk backwards looking for a position where it parses
  for (let i = text.length - 1; i > 0; i--) {
    if (text[i] === '}') {
      try {
        return JSON.parse(text.slice(0, i + 1));
      } catch {
        // keep scanning back
      }
    }
  }

  console.error('[claudeService] Could not extract any valid JSON from Claude response');
  return {};
}

// ─── Portfolio import prompt (shared between PDF + CSV paths) ─────────────────

const PORTFOLIO_PROMPT = `You are parsing a broker portfolio holdings export. Extract ALL investment holdings.
Return a single JSON object (no markdown, no code fences):
{
  "portfolio_name": "string or null",
  "total_value": number or null,
  "holdings": [
    {
      "ticker": "string",
      "name": "string",
      "market": "ASX|NYSE|NASDAQ|LSE|Crypto|Other",
      "asset_type": "stock|etf|managed_fund|crypto|precious_metal|other",
      "shares_owned": number,
      "cost_basis": number,
      "current_value": number or null,
      "current_price": number or null
    }
  ]
}
Adaptive column name mapping (match whatever headers are present):
- shares_owned  → Quantity / Qty / Units / Holdings / Shares / No. of Units / # Shares
- cost_basis    → Total Cost / Book Cost / Cost Base / Cost Basis / Book Value / Cost Value / Purchase Cost / Cost Price x Units
  IMPORTANT: cost_basis MUST be the TOTAL amount paid. If only per-unit avg cost is given, multiply by shares_owned.
- current_value → Market Value / Value / Current Value / Est. Value / Portfolio Value
- current_price → Price / Last Price / Market Price / Current Price / Last Sale / Current

Common broker formats handled:
- CommSec: "Security, Description, Market, Units Held, Market Price, Market Value, Cost Price, Cost Value..."
- SelfWealth: "Code, Company Name, Shares, Average Price, Total Cost, Current Price, Market Value..."
- Stake: "Symbol, Name, Shares, Average Buy Price, Total Cost, Current Price, Total Market Value..."
- Interactive Brokers: activity statement open positions section
- CMC Markets: portfolio export

Rules:
- ASX tickers with no suffix → append .AX (e.g. CBA → CBA.AX). Set market = "ASX"
- US stocks/ETFs: no suffix. market = NYSE or NASDAQ based on exchange column
- Crypto: standard symbols (BTC, ETH, SOL). market = "Crypto"
- All monetary values: plain numbers only — no $, £, commas, or % signs
- String values: ASCII only — no special characters, apostrophes, or embedded quote marks
- Include EVERY holding — do not truncate, summarise, or skip any rows
- If cost_basis is unavailable, set to 0
- If current_value is unavailable, set to null`;

/** Parse a CSV text (or any plain-text portfolio export) with Claude. */
export async function parsePortfolioText(text: string): Promise<Record<string, unknown>> {
  // Trim to avoid exceeding token limits on very large exports
  const trimmed = text.slice(0, 60_000);
  const response = await client().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `${PORTFOLIO_PROMPT}\n\nHere is the portfolio data to parse:\n\n${trimmed}\n\nReturn ONLY the JSON object — no markdown, no explanation, no code fences.`,
    }],
  });
  const rawText = response.content[0].type === 'text' ? response.content[0].text : '{}';
  console.log('[claudeService] parsePortfolioText raw length:', rawText.length);
  const result = extractJSON(rawText);
  console.log('[claudeService] parsePortfolioText keys:', Object.keys(result));
  return result;
}

export async function parseFinancialDocument(
  base64Content: string,
  mediaType: 'application/pdf' | 'image/jpeg' | 'image/png',
  documentType: 'bank_statement' | 'payslip' | 'super_statement' | 'credit_card' | 'investment' | 'investment_portfolio'
): Promise<Record<string, unknown>> {

  // Prompts instruct Claude to keep string values ASCII-safe and avoid
  // special characters that would break JSON parsing.
  const prompts: Record<string, string> = {
    bank_statement: `Extract bank account details from this document.
Return a single JSON object with this exact shape:
{
  "accounts": [{
    "name": "string",
    "institution": "string",
    "account_type": "string",
    "balance": number,
    "bsb": "string or null",
    "account_number": "string or null",
    "currency": "AUD",
    "transactions": [{"date":"YYYY-MM-DD","merchant":"string","amount":number,"type":"debit|credit"}]
  }]
}
Rules:
- balance is always a plain number (no $ or commas)
- Closing Balance / Available Balance / Current Balance all map to balance
- Keep merchant names short, ASCII only, no quotes or apostrophes
- Detect institution from branding: ANZ, CommBank, Westpac, NAB, Macquarie, ING, Up, Bendigo, St George, Suncorp, etc.
- Limit to the 50 most recent transactions if there are more`,

    payslip: `Extract payslip details from this document.
Return a single JSON object:
{
  "employer": "string",
  "employee_name": "string",
  "pay_period": "string",
  "pay_date": "YYYY-MM-DD",
  "gross_pay": number,
  "net_pay": number,
  "tax_withheld": number,
  "super_contribution": number,
  "frequency": "weekly|fortnightly|monthly"
}
All monetary values are plain numbers, no $ or commas.`,

    super_statement: `Extract superannuation details from this document.
Return a single JSON object:
{
  "fund_name": "string",
  "member_number": "string",
  "balance": number,
  "employer_contributions": number,
  "personal_contributions": number,
  "investment_option": "string",
  "period": "string"
}
All monetary values are plain numbers.`,

    credit_card: `Extract credit card statement details from this document.
Return a single JSON object:
{
  "institution": "string",
  "card_name": "string",
  "balance_owing": number,
  "credit_limit": number,
  "minimum_payment": number,
  "due_date": "YYYY-MM-DD",
  "transactions": [{"date":"YYYY-MM-DD","merchant":"string","amount":number}]
}
Keep merchant names ASCII only, no quotes or apostrophes. Limit to 50 most recent transactions.`,

    investment: `Extract investment and portfolio details from this document.
Return a single JSON object:
{
  "account_name": "string",
  "total_value": number,
  "holdings": [{"ticker":"string","name":"string","shares":number,"value":number,"cost_basis":number}]
}
All monetary values are plain numbers.`,

    investment_portfolio: PORTFOLIO_PROMPT,
  };

  // PDFs use 'document' block type; images use 'image' block type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fileBlock: any =
    mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Content } }
      : { type: 'image',    source: { type: 'base64', media_type: mediaType, data: base64Content } };

  const response = await client().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        fileBlock,
        { type: 'text', text: prompts[documentType] + '\n\nReturn ONLY the JSON object — no markdown, no explanation, no code fences.' },
      ],
    }],
  });

  const rawText = response.content[0].type === 'text' ? response.content[0].text : '{}';
  console.log('[claudeService] raw response length:', rawText.length, 'chars');

  const result = extractJSON(rawText);
  console.log('[claudeService] parsed top-level keys:', Object.keys(result));
  return result;
}

export async function telegramAIResponse(
  userMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  userContext: Record<string, unknown>
): Promise<string> {
  const systemPrompt = `You are the Ledger financial assistant for ${userContext.name ?? 'the user'}.

RESPONSE STYLE — follow these rules exactly:
- 1–3 sentences max for simple questions. No padding, no filler.
- Never open with "Great question!", "Of course!", "Sure!", "Absolutely!" or any similar preamble. Start with the answer.
- No bullet points or formatted lists in casual conversation. Plain prose only.
- Use structured formatting (bullets, tables) ONLY when presenting actual financial data — holdings lists, comparisons, transaction breakdowns.
- Use the user's first name occasionally, not in every message.
- Tone: direct, smart, and relaxed — like a trusted executive assistant, not a customer-service chatbot.
- If you need clarification, ask one concise question. Don't explain why you're asking.
- Always confirm before making any changes to data.

Their display currency is ${userContext.currency ?? 'AUD'}.

Current financial summary:
${JSON.stringify(userContext.summary ?? {}, null, 2)}`;

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const response = await client().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  return response.content[0].type === 'text' ? response.content[0].text : 'How can I help you?';
}
