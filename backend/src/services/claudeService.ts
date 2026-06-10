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

const PORTFOLIO_PROMPT = `You are parsing a holdings list. It may be a broker export (stocks/ETFs/crypto)
OR a list of physical/alternative assets: bonds, art, wine, jewellery, watches, precious metals.
Extract ALL holdings of every kind.
Return a single JSON object (no markdown, no code fences):
{
  "portfolio_name": "string or null",
  "total_value": number or null,
  "holdings": [
    {
      "ticker": "string (market assets only; empty for collectibles)",
      "name": "string",
      "market": "ASX|NYSE|NASDAQ|LSE|Crypto|Bonds|Art|Wine|Jewellery|Other",
      "asset_type": "stock|etf|managed_fund|crypto|precious_metal|bond|art|wine|jewellery|other",
      "shares_owned": number,
      "cost_basis": number,
      "current_value": number or null,
      "current_price": number or null,
      "details": { }
    }
  ]
}
Collectible asset types — set ticker to "", market to the matching label, shares_owned to the
quantity (default 1), cost_basis to the purchase price, current_value to the latest/valuation value,
and put the extra fields in "details":
- bond:      details = { maturity_date, expected_maturity_value, purchase_date }
- art:       details = { artist, collection, year, medium, purchase_date, last_valuation_date }
- wine:      details = { producer, region, vintage, varietal, bottle_size, purchase_date }; shares_owned = bottles
- jewellery: details = { jewellery_type, brand, model, reference, materials:[{material,value}], purchase_date, last_valuation_date }
Omit unknown detail fields. For market assets, "details" may be an empty object {}.
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
  documentType: 'bank_statement' | 'payslip' | 'super_statement' | 'credit_card' | 'credit_card_statement' | 'investment' | 'investment_portfolio' | 'subscription_statement'
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
- ALWAYS extract the balance even when it is small (e.g. 0.05, 0.50), exactly zero (0), or negative (overdrawn, e.g. -12.34). A value under $1 is still a real balance — never return null/omit it when any balance figure is shown
- "name" MUST follow this priority order — NEVER use the account holder's personal name:
  1. Account product name printed on the statement (e.g. "Smart Access", "Everyday Account", "Complete Access", "Streamline", "Orange Everyday", "Spend Account")
  2. Institution + account type (e.g. "CommBank Smart Access", "ANZ Savings")
  3. "Account XXXX" using the last 4 digits of the account number (e.g. "Account 6222")
  — If none of the above can be determined, set name to the account_type string only.
- "account_type" is the generic category: "transaction", "savings", "offset", etc.
- Keep merchant names short, ASCII only, no quotes or apostrophes
- Detect institution from branding: ANZ, CommBank, Westpac, NAB, Macquarie, ING, Up, Bendigo, St George, Suncorp, etc.
- Limit to the 50 most recent transactions if there are more`,

    payslip: `Extract payslip / pay advice details from this Australian document (any payroll system: Xero, MYOB, KeyPay/Employment Hero, ADP, Reckon, etc.). All amounts are AUD.
Return a single JSON object:
{
  "employer": "string or null",
  "abn": "string or null",
  "employee_name": "string or null",
  "employment_type": "full_time|part_time|casual|contractor",
  "pay_period_start": "YYYY-MM-DD or null",
  "pay_period_end": "YYYY-MM-DD or null",
  "payment_date": "YYYY-MM-DD or null",
  "pay_frequency": "weekly|fortnightly|monthly",
  "gross_pay": number,
  "net_pay": number,
  "tax_withheld": number,
  "super_amount": number,
  "super_rate": number or null,
  "ytd_gross": number or null,
  "ytd_tax": number or null,
  "ytd_super": number or null,
  "leave_balance": number or null,
  "sick_leave_balance": number or null,
  "hourly_rate": number or null,
  "allowances": [{"name":"string","amount":number}],
  "deductions": [{"name":"string","amount":number}]
}
Rules:
- gross_pay/net_pay/tax_withheld are for THIS pay period; tax_withheld = PAYG/income tax withheld.
- super_amount = the EMPLOYER super (SG) contribution for the period; super_rate = the super percentage if printed (e.g. 11.5) else null.
- employment_type: casual->casual, permanent part-time->part_time, full-time/salary->full_time, contractor/ABN contract->contractor; default full_time.
- pay_frequency: infer from period length (~7d weekly, ~14d fortnightly, ~1mo monthly).
- ytd_* are year-to-date totals if shown else null. leave_balance/sick_leave_balance are available balances else null. hourly_rate if shown else null.
- allowances/deductions: itemised {name, amount} lines; empty array if none.
- All monetary values are plain numbers, no $ or commas. Keep strings ASCII-safe, no quotes or apostrophes.`,

    super_statement: `Extract superannuation details from this Australian super statement (AustralianSuper, Hostplus, REST, Aware Super, UniSuper, HESTA, Cbus, Australian Retirement Trust, MLC, AMP, Colonial First State, etc.). All amounts are AUD.
Return a single JSON object:
{
  "fund_name": "string or null",
  "member_number": "string or null",
  "balance": number,
  "investment_option": "string or null",
  "employer_contributions": number,
  "personal_contributions": number,
  "insurance_details": "short summary of any Death/TPD/Income Protection cover with amounts and premiums, or null",
  "fees": number
}
Rules:
- balance is the current/closing account balance (plain number, no $ or commas)
- member_number is the member/membership/account/client number printed on the statement
- investment_option is the named option/strategy (e.g. High Growth, Balanced); join multiple with " / "
- employer_contributions = total employer/SG contributions for the period (0 if absent)
- personal_contributions = total member/personal/voluntary contributions for the period (0 if absent)
- insurance_details = a single human-readable string summarising cover types, amounts and premiums; null if no insurance present
- fees = total fees and costs deducted for the period (admin + investment + other combined); 0 if not shown
- All monetary values are plain numbers. Keep strings ASCII-safe, no quotes or apostrophes.`,

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

    credit_card_statement: `Extract credit card statement details from this document.
Return a single JSON object:
{
  "institution": "string",
  "card_name": "string",
  "statement_period": "string",
  "closing_balance": number,
  "credit_limit": number,
  "minimum_payment": number,
  "due_date": "YYYY-MM-DD",
  "transactions": [{"date":"YYYY-MM-DD","merchant":"string","amount":number,"category":"string"}]
}
Rules:
- closing_balance is the statement closing balance / amount owing (plain positive number, no $ or commas)
- credit_limit is the total credit limit (plain number)
- minimum_payment is the minimum amount due (plain number)
- All amounts are plain positive numbers
- Detect institution from branding: ANZ, CommBank, Westpac, NAB, Amex, Citibank, etc.
- Keep merchant names short, ASCII only, no apostrophes or special characters
- Infer category from merchant name: Groceries, Dining, Transport, Entertainment, Health, Travel, Shopping, Utilities, Other
- Limit to the 50 most recent transactions`,

    subscription_statement: `Extract all recurring subscriptions and charges from this document (could be a bank/credit card statement, email receipt summary, or subscription management export).
Return a single JSON object:
{
  "subscriptions": [
    {
      "name": "string",
      "amount": number,
      "frequency": "weekly|fortnightly|monthly|quarterly|annually",
      "next_charge_date": "YYYY-MM-DD or null",
      "category": "Entertainment|Software|Fitness|News|Telecommunications|Other"
    }
  ]
}
Rules:
- name should be the service/product name (e.g. Netflix, Spotify, Adobe Creative Cloud)
- amount is the charge amount as a plain positive number, no $ or commas
- frequency: infer from charge descriptions or billing intervals shown in the document
- category: map to the closest option from the allowed list
- Include ONLY recurring/subscription charges, not one-off purchases
- If next_charge_date cannot be determined, set to null`,

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

// A tool the Telegram assistant can call to actually mutate the user's data.
// telegramService supplies the executor (it owns the userId + supabase client).
export interface TelegramTool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: any; // Anthropic tool definition
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (input: any) => Promise<string>; // returns a short human-readable result
}

export interface TelegramContext {
  name?: string;
  currency?: string;
  /** Human-readable current date/time in the user's timezone, e.g. "Tuesday, 9 June 2026, 2:14 PM". */
  now?: string;
  /** IANA timezone, e.g. "Australia/Sydney". */
  timezone?: string;
  /** Compact reference of tables/columns the data tools can read & write. */
  schema?: string;
  summary?: unknown;
  tools?: TelegramTool[];
}

export async function telegramAIResponse(
  userMessage: string,
  conversationHistory: { role: 'user' | 'assistant'; content: string }[],
  userContext: TelegramContext
): Promise<string> {
  const now = userContext.now ?? new Date().toString();
  const tz = userContext.timezone ?? 'Australia/Sydney';

  const systemPrompt = `You are the Ledger financial assistant for ${userContext.name ?? 'the user'}.

CURRENT DATE & TIME: ${now} (timezone: ${tz}).
- This is the REAL current date and time — trust it completely over any assumption about what year it is.
- When the user gives a date without a year (e.g. "the 7th of July"), assume the NEXT such date that is today or in the future, using the year from the current date above.
- Greet appropriately for the time of day shown above (morning / afternoon / evening) — do NOT default to "Good morning".

RESPONSE STYLE — follow these rules exactly:
- 1–3 sentences max for simple questions. No padding, no filler.
- Never open with "Great question!", "Of course!", "Sure!", "Absolutely!" or any similar preamble. Start with the answer.
- No bullet points or formatted lists in casual conversation. Plain prose only.
- Use structured formatting (bullets, tables) ONLY when presenting actual financial data — holdings lists, comparisons, transaction breakdowns.
- Use the user's first name occasionally, not in every message.
- Tone: direct, smart, and relaxed — like a trusted executive assistant, not a customer-service chatbot.
- If you need clarification, ask one concise question. Don't explain why you're asking.

MAKING CHANGES — you can do anything a human could do in the app:
- You have generic data tools (query_data, create_record, update_record, delete_record) over the tables below. Use them to add, edit, view, or remove the user's accounts, cards, transactions, investments, super, income, bills/reminders, goals, budgets, and subscriptions.
- When the user clearly asks you to do something, CALL THE TOOL — never just claim you did it. Only confirm success AFTER the tool reports it; if a tool returns an Error, tell the user plainly it did not save.
- To edit or delete a specific record, first query_data to find its id, then update_record / delete_record by that id.
- ALWAYS confirm with the user before deleting anything, and before any change involving a large amount or that you're not certain about.
- If a required field is genuinely missing, ask one short question first.
- Dates must be absolute YYYY-MM-DD; derive the year from the current date above.

DATA SCHEMA (tables you can read/write — all rows are automatically scoped to this user):
${userContext.schema ?? '(no tables available)'}

Their display currency is ${userContext.currency ?? 'AUD'}.

Current financial summary:
${JSON.stringify(userContext.summary ?? {}, null, 2)}`;

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const tools = userContext.tools ?? [];
  const toolSpecs = tools.map(t => t.spec);
  const toolByName = new Map(tools.map(t => [t.spec.name as string, t]));

  // Agentic loop: let Claude call tools until it produces a final text answer.
  // Capped so a misbehaving model can never loop forever.
  for (let turn = 0; turn < 5; turn++) {
    const response = await client().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      ...(toolSpecs.length ? { tools: toolSpecs } : {}),
    });

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const tool = toolByName.get(block.name);
        let resultText: string;
        if (!tool) {
          resultText = `Error: unknown tool "${block.name}".`;
        } else {
          try {
            resultText = await tool.run(block.input);
          } catch (err) {
            resultText = `Error: ${(err as Error).message ?? 'tool failed'}`;
          }
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue; // let Claude read the result and respond
    }

    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock && textBlock.type === 'text' ? textBlock.text : 'How can I help you?';
  }

  return "I tried to do that but ran into a loop — could you rephrase?";
}
