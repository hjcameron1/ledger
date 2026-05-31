/**
 * Local PDF parser — extracts text with pdfjs-dist and uses a universal
 * date-anchored regex approach to parse transactions from any bank or credit
 * card statement.  No AI required for text-based PDFs (>= 3 date matches).
 *
 * Falls back to Claude only for scanned / image-only PDFs (< 3 date matches).
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
    // Dynamic import required — pdfjs-dist v5 is ESM-only (.mjs)
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
    return text;
  } catch {
    return '';
  }
}

/** Returns true if the text looks like a scanned/image PDF with no readable content. */
export function isGarbledText(text: string): boolean {
  return text.trim().length < 200;
}

/** Count how many date occurrences (DD Mon YYYY) appear in the extracted text. */
export function countDateLines(text: string): number {
  const matches = text.match(/\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/gi);
  return matches ? matches.length : 0;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Detect bank/institution name from statement text. */
function detectInstitution(text: string): string | null {
  const upper = text.toUpperCase();
  const institutions: [string, string][] = [
    ['COMMONWEALTH BANK', 'CommBank'],
    ['COMMBANK',          'CommBank'],
    ['NETBANK',           'CommBank'],
    ['ANZ',               'ANZ'],
    ['WESTPAC',           'Westpac'],
    ['ST.GEORGE',         'St George'],
    ['ST GEORGE',         'St George'],
    ['BANK OF MELBOURNE', 'Bank of Melbourne'],
    ['BANKWEST',          'BankWest'],
    ['NATIONAL AUSTRALIA BANK', 'NAB'],
    ['\bNAB\b',           'NAB'],
    ['MACQUARIE',         'Macquarie'],
    ['ING DIRECT',        'ING'],
    ['\bING\b',           'ING'],
    ['BENDIGO',           'Bendigo Bank'],
    ['SUNCORP',           'Suncorp'],
    ['BANK OF QUEENSLAND','BOQ'],
    ['\bBOQ\b',           'BOQ'],
    ['AMERICAN EXPRESS',  'Amex'],
    ['AMEX',              'Amex'],
    ['CITIBANK',          'Citibank'],
    ['CITI ',             'Citibank'],
    ['HSBC',              'HSBC'],
    ['UP BANK',           'Up'],
    ['UBANK',             'UBank'],
    ['86 400',            '86 400'],
    ['GREAT SOUTHERN BANK','Great Southern Bank'],
  ];
  for (const [pattern, name] of institutions) {
    if (new RegExp(pattern).test(upper)) return name;
  }
  return null;
}

/**
 * Parse a monetary string like "$1,234.56", "-$1,234.56", "1,234.56 CR" to a number.
 * Returns null if unparseable.
 */
function parseMoney(s: string): number | null {
  if (!s) return null;
  const negative = s.trim().startsWith('-') || /\bDR\b/i.test(s);
  const clean = s.replace(/[$,\s]/g, '').replace(/\b(CR|DR)\b/gi, '').replace(/^-/, '').trim();
  const n = parseFloat(clean);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : Math.abs(n);
}

/**
 * Parse a date string into YYYY-MM-DD. Handles:
 *   DD/MM/YYYY, DD/MM/YY, DD MMM YYYY, DD MMM YY, YYYY-MM-DD, Mon DD YYYY, Mon DD, YYYY
 */
function parseDate(s: string): string | null {
  s = s.trim();
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY (also DD/MM/YY)
  let m = s.match(/^(\d{1,2})[/\-.\\](\d{1,2})[/\-.\\](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  // DD MMM YYYY or DD MMM YY  (e.g. 30 Mar 2026)
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (m) {
    const mon = months[m[2].toLowerCase()];
    if (!mon) return null;
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${mon}-${m[1].padStart(2, '0')}`;
  }

  // MMM DD, YYYY or MMM DD YYYY  (e.g. Mar 30, 2026)
  m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = months[m[1].toLowerCase()];
    if (!mon) return null;
    return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }

  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;

  return null;
}

/** Auto-categorise a merchant name. */
function autoCategory(merchant: string): string {
  const m = merchant.toLowerCase();
  if (/woolworths|coles|aldi|iga|harris farm|fruit|butcher|bakery|deli/.test(m)) return 'Groceries';
  if (/mcdonald|kfc|hungry|grill|burger|pizza|sushi|noodle|cafe|coffee|restaurant|dining|kebab|thai|chinese|indian|italian/.test(m)) return 'Dining';
  if (/uber|lyft|taxi|bus|train|metro|opal|tram|ferry|parking|toll|e-way|linkt/.test(m)) return 'Transport';
  if (/shell|bp|caltex|ampol|7-eleven|fuel|petrol|service station/.test(m)) return 'Fuel';
  if (/netflix|spotify|stan|disney|hulu|binge|foxtel|kayo|youtube|prime video/.test(m)) return 'Entertainment';
  if (/gym|fitness|yoga|pilates|sport|swim|tennis|golf/.test(m)) return 'Fitness';
  if (/hospital|pharmacy|chemist|doctor|dental|medical|health|medicare|pathology/.test(m)) return 'Health';
  if (/rent|property|strata|agent|real estate/.test(m)) return 'Rent';
  if (/electricity|gas|water|council|rates|nbn|internet|telstra|optus|vodafone|tpg|aussie/.test(m)) return 'Utilities';
  if (/insurance|nrma|racv|rac |allianz|medibank|bupa|ahm/.test(m)) return 'Insurance';
  if (/apple|jb hi-fi|harvey|kogan|amazon|ebay|officeworks|big w|target|kmart/.test(m)) return 'Shopping';
  if (/salary|payroll|employer|deposit|income/.test(m)) return 'Income';
  if (/transfer|trf|eft|bpay|payment/.test(m)) return 'Transfer';
  return 'Other';
}

/** Strip noise from a description: card suffixes, value-date riders, extra whitespace. */
function cleanDescription(s: string): string {
  return s
    .replace(/\s+Card\s+[xX*\d]{2,}\d{4}/g, '')          // Card xx4598
    .replace(/\s+Value\s+Date:?\s+\S+\s+\S+\s+\S+/gi, '') // Value Date: 30 Mar 2026
    .replace(/\s+Ref(?:erence)?[:\s]+[\w/]+/gi, '')        // Ref: 123456
    .replace(/[|·•\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Universal transaction parser ─────────────────────────────────────────────
//
// Strategy:
//   1. Find every date occurrence in the full text (pdfjs joins items with
//      spaces, so dates and amounts are on the same "line" in most cases).
//   2. For each date, scan the text window up to the next date (capped at
//      300 chars) for the first dollar amount.
//   3. Everything between the date and that amount is the description.
//   4. An optional second amount is treated as the running balance.
//   5. Debit/credit is determined by: explicit minus sign > CR/DR keyword >
//      income keyword heuristic > default debit.

// All four date formats in one alternation — group 1 always captures the date.
const ALL_DATE_RE =
  /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{2}[\/\-]\d{2})\b/gi;

// Dollar amount: optional minus, optional $, digits/commas, decimal point, 2 digits
const AMOUNT_RE = /(-?\$?[\d,]+\.\d{2})/g;

// Rows to skip (totals, headers, balance labels)
const SKIP_DESC_RE = /^(opening|closing|balance|total|brought\s+forward|carried\s+forward|statement|period|page\s+\d|bsb|account\s+name|account\s+number|interest\s+rate|credit\s+limit|minimum\s+payment|amount\s+due)/i;

function parseUniversalTransactions(text: string): ParsedTransaction[] {
  // ── Pass 1: collect all date positions ──────────────────────────────────
  type DateHit = { index: number; end: number; dateStr: string };
  const dateHits: DateHit[] = [];

  ALL_DATE_RE.lastIndex = 0;
  let dm: RegExpExecArray | null;
  while ((dm = ALL_DATE_RE.exec(text)) !== null) {
    const parsed = parseDate(dm[1]);
    if (parsed) dateHits.push({ index: dm.index, end: dm.index + dm[0].length, dateStr: parsed });
  }

  if (dateHits.length === 0) return [];

  // ── Pass 2: for each date, extract description + amount ─────────────────
  const transactions: ParsedTransaction[] = [];

  for (let i = 0; i < dateHits.length; i++) {
    const { end: dateEnd, dateStr } = dateHits[i];

    // Window: up to next date start or 300 chars, whichever is less
    const nextDateIdx = i + 1 < dateHits.length ? dateHits[i + 1].index : text.length;
    const windowEnd   = Math.min(nextDateIdx, dateEnd + 300);
    const window      = text.slice(dateEnd, windowEnd);

    // Find all amounts in this window
    AMOUNT_RE.lastIndex = 0;
    const amounts: Array<{ value: number; index: number; raw: string }> = [];
    let am: RegExpExecArray | null;
    while ((am = AMOUNT_RE.exec(window)) !== null) {
      const v = parseMoney(am[1]);
      if (v !== null) amounts.push({ value: v, index: am.index, raw: am[1] });
    }
    if (amounts.length === 0) continue;

    // Description = everything before the first amount, cleaned up
    const rawDesc = window.slice(0, amounts[0].index);
    const desc    = cleanDescription(rawDesc);

    if (!desc || desc.length < 2) continue;
    if (SKIP_DESC_RE.test(desc))  continue;

    // ── Determine debit / credit ───────────────────────────────────────────
    const firstRaw = amounts[0].raw;
    const firstVal = amounts[0].value;

    // 1. Explicit negative sign on the amount
    const hasNegative = firstRaw.trim().startsWith('-');

    // 2. CR / DR keyword immediately after the amount (within 10 chars)
    const afterAmt = window.slice(amounts[0].index + firstRaw.length, amounts[0].index + firstRaw.length + 10);
    const hasCR    = /\bCR\b/i.test(afterAmt);
    const hasDR    = /\bDR\b/i.test(afterAmt);

    // 3. Balance direction (if two amounts present and neither is signed)
    let balanceCredit = false;
    if (amounts.length >= 2 && !hasNegative && !hasCR && !hasDR) {
      // If running balance increased by roughly the transaction amount → credit
      balanceCredit = amounts[1].value > amounts[0].value;
    }

    // 4. Description keyword hints
    const isIncomeDesc = /\b(salary|payroll|employer|direct\s*credit|interest\s*credit|refund|reversal)\b/i.test(desc);

    let type: 'debit' | 'credit';
    if (hasNegative || hasDR) {
      type = 'debit';
    } else if (hasCR || isIncomeDesc || balanceCredit) {
      type = 'credit';
    } else {
      type = 'debit'; // safe default — most transactions are expenses
    }

    // Signed amount: debit = negative, credit = positive
    const amount = type === 'debit' ? -Math.abs(firstVal) : Math.abs(firstVal);

    transactions.push({
      date:     dateStr,
      merchant: desc.slice(0, 80),
      amount,
      type,
      category: autoCategory(desc),
    });
  }

  return transactions;
}

// ─── Account metadata helpers ─────────────────────────────────────────────────

function extractBsb(text: string): string | null {
  const m = text.match(/BSB[:\s]+(\d{3}-?\d{3})/i);
  return m ? m[1] : null;
}

function extractAccountNumber(text: string): string | null {
  const m = text.match(/Account\s*(?:number|no)?[.:\s]+([\d\s]{6,14})/i);
  return m ? m[1].replace(/\s/g, '') : null;
}

function extractAccountName(text: string): string | null {
  // "Account name: John Smith" label pattern
  const labelM = text.match(/Account\s+name[:\s]+([A-Za-z0-9 &'-]+?)(?:\n|BSB|Account\s+[Nn]umber)/i);
  if (labelM) return labelM[1].trim();
  // Leading ALL-CAPS name block (common on CommBank statements)
  const capsM = text.match(/^([A-Z][A-Z\s]{3,}[A-Z])\s*\n/m);
  return capsM ? capsM[1].trim() : null;
}

function extractClosingBalance(text: string): number | null {
  // Labelled closing balance
  const patterns = [
    /closing\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /available\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /current\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /(?:new|statement|outstanding)\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /amount\s+(?:due|owing)[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseMoney(m[1]);
  }
  // Fallback: last dollar amount in the document
  const all = [...text.matchAll(/\$[\d,]+\.\d{2}/g)];
  if (all.length > 0) return parseMoney(all[all.length - 1][0]);
  return null;
}

function extractCreditLimit(text: string): number | null {
  const m = text.match(/credit\s+(?:limit|line)[:\s]+\$?([\d,]+(?:\.\d{2})?)/i);
  return m ? parseMoney(m[1]) : null;
}

function extractMinimumPayment(text: string): number | null {
  const m = text.match(/minimum\s+(?:payment|amount\s+due)[:\s]+\$?([\d,]+\.\d{2})/i)
    ?? text.match(/min(?:imum)?\s+due[:\s]+\$?([\d,]+\.\d{2})/i);
  return m ? parseMoney(m[1]) : null;
}

function extractDueDate(text: string): string | null {
  const m = text.match(/(?:payment\s+)?due\s+(?:date|by)[:\s]+(\d{1,2}[\/ ]\d{1,2}[\/ ]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i)
    ?? text.match(/pay\s+by[:\s]+(\d{1,2}[\/ ]\d{1,2}[\/ ]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i);
  return m ? parseDate(m[1]) : null;
}

function extractStatementPeriod(text: string): string | null {
  const m = text.match(/statement\s+period[:\s]+([^\n]{5,40})/i);
  return m ? m[1].trim() : null;
}

// ─── Public parsers ───────────────────────────────────────────────────────────

export function parseBankStatementText(text: string): { accounts: ParsedBankStatement[] } | null {
  const transactions = parseUniversalTransactions(text);
  if (transactions.length === 0) return null;

  console.log(`[pdfParser] universal parser extracted ${transactions.length} transactions`);

  const institution  = detectInstitution(text);
  const bsb          = extractBsb(text);
  const accountNumber = extractAccountNumber(text);
  const accountName  = extractAccountName(text);
  const balance      = extractClosingBalance(text);

  let accountType = 'Everyday';
  if (/savings/i.test(text))        accountType = 'Savings';
  else if (/offset/i.test(text))    accountType = 'Offset';
  else if (/term\s+deposit/i.test(text)) accountType = 'Term Deposit';

  return {
    accounts: [{
      name:           accountName,
      institution,
      account_type:   accountType,
      balance,
      bsb,
      account_number: accountNumber,
      currency:       'AUD',
      transactions,
    }],
  };
}

export function parseCreditCardStatementText(text: string): ParsedCardStatement | null {
  const transactions = parseUniversalTransactions(text);
  if (transactions.length === 0) return null;

  console.log(`[pdfParser] universal parser extracted ${transactions.length} transactions`);

  const institution = detectInstitution(text);

  let cardName: string | null = null;
  const cardNamePatterns = [
    /(?:card\s+name|product\s+name|account\s+name)[:\s]+([A-Za-z0-9 &]+?)(?:\n|Card\s+Number|Account)/i,
    /((?:ANZ|CommBank|Westpac|NAB|Amex|Citibank|Macquarie)[^\n]{3,40}(?:card|rewards|platinum|black|gold|visa|mastercard))/i,
  ];
  for (const p of cardNamePatterns) {
    const m = text.match(p);
    if (m) { cardName = m[1].trim(); break; }
  }
  if (!cardName && institution) cardName = `${institution} Credit Card`;

  return {
    institution,
    card_name:       cardName,
    statement_period: extractStatementPeriod(text),
    closing_balance: extractClosingBalance(text),
    credit_limit:    extractCreditLimit(text),
    minimum_payment: extractMinimumPayment(text),
    due_date:        extractDueDate(text),
    transactions,
  };
}

// ─── Subscription statement parser ───────────────────────────────────────────

const KNOWN_SUBSCRIPTIONS: Array<{ pattern: RegExp; name: string; category: string }> = [
  { pattern: /netflix/i,                    name: 'Netflix',         category: 'Entertainment' },
  { pattern: /spotify/i,                    name: 'Spotify',         category: 'Entertainment' },
  { pattern: /apple\s*(one|tv|music|icloud|\+)/i, name: 'Apple',    category: 'Entertainment' },
  { pattern: /disney\+|disney plus/i,       name: 'Disney+',         category: 'Entertainment' },
  { pattern: /stan\b/i,                     name: 'Stan',            category: 'Entertainment' },
  { pattern: /binge\b/i,                    name: 'Binge',           category: 'Entertainment' },
  { pattern: /kayo/i,                       name: 'Kayo Sports',     category: 'Entertainment' },
  { pattern: /youtube\s*premium/i,          name: 'YouTube Premium', category: 'Entertainment' },
  { pattern: /amazon\s*prime/i,             name: 'Amazon Prime',    category: 'Entertainment' },
  { pattern: /paramount\+/i,               name: 'Paramount+',      category: 'Entertainment' },
  { pattern: /adobe/i,                      name: 'Adobe',           category: 'Software' },
  { pattern: /microsoft\s*(365|office)/i,   name: 'Microsoft 365',   category: 'Software' },
  { pattern: /google\s*(one|workspace|drive)/i, name: 'Google One', category: 'Software' },
  { pattern: /dropbox/i,                    name: 'Dropbox',         category: 'Software' },
  { pattern: /github/i,                     name: 'GitHub',          category: 'Software' },
  { pattern: /openai|chatgpt/i,             name: 'ChatGPT',         category: 'Software' },
  { pattern: /notion/i,                     name: 'Notion',          category: 'Software' },
  { pattern: /slack/i,                      name: 'Slack',           category: 'Software' },
  { pattern: /telstra/i,                    name: 'Telstra',         category: 'Telecommunications' },
  { pattern: /optus/i,                      name: 'Optus',           category: 'Telecommunications' },
  { pattern: /vodafone/i,                   name: 'Vodafone',        category: 'Telecommunications' },
  { pattern: /tpg/i,                        name: 'TPG',             category: 'Telecommunications' },
  { pattern: /aussie\s*broadband/i,         name: 'Aussie Broadband',category: 'Telecommunications' },
  { pattern: /iinet/i,                      name: 'iiNet',           category: 'Telecommunications' },
  { pattern: /nbn/i,                        name: 'NBN',             category: 'Telecommunications' },
  { pattern: /gym|anytime\s*fitness|f45|crossfit|planet\s*fitness/i, name: 'Gym', category: 'Fitness' },
  { pattern: /the\s*australian|sydney\s*morning|age\s*(digital)?|afr|financial\s*review/i, name: 'News Subscription', category: 'News' },
];

export function parseSubscriptionStatementText(text: string): ParsedSubscriptionStatement {
  const found = new Map<string, { name: string; amount: number; frequency: string; next_charge_date: string | null; category: string }>();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const dateRe   = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/;
  const moneyRe  = /\$?([\d,]+\.\d{2})/;

  for (const line of lines) {
    for (const { pattern, name, category } of KNOWN_SUBSCRIPTIONS) {
      if (!pattern.test(line)) continue;
      const amtMatch  = line.match(moneyRe);
      const amount    = amtMatch ? (parseMoney(amtMatch[1]) ?? 0) : 0;
      const dateMatch = line.match(dateRe);
      const date      = dateMatch ? parseDate(dateMatch[1]) : null;
      if (!found.has(name) && amount > 0) {
        found.set(name, { name, amount, frequency: 'monthly', next_charge_date: date, category });
      }
    }
  }

  return { subscriptions: Array.from(found.values()) };
}
