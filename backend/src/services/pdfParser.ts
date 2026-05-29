/**
 * Local PDF parser — extracts text with pdfjs-dist and uses regex/pattern
 * matching to pull structured data out of Australian bank and credit card
 * statements.  No AI required for text-based PDFs.
 *
 * Falls back to Claude for scanned/image-only PDFs (text length < 100 chars).
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

/** Returns true if the text looks like a scanned/image PDF with no readable transactions. */
export function isGarbledText(text: string): boolean {
  return text.trim().length < 200;
}

/** Count lines that start with (or contain) a date pattern — DD Mon YYYY or DD/MM/YYYY. */
export function countDateLines(text: string): number {
  const dateRe = /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/i;
  return text.split('\n').filter(line => dateRe.test(line)).length;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function detectInstitution(text: string): string | null {
  const upper = text.toUpperCase();
  const institutions: [string, string][] = [
    ['COMMONWEALTH BANK', 'CommBank'],
    ['COMMBANK', 'CommBank'],
    ['NETBANK', 'CommBank'],
    ['ANZ', 'ANZ'],
    ['WESTPAC', 'Westpac'],
    ['ST.GEORGE', 'St George'],
    ['ST GEORGE', 'St George'],
    ['BANK OF MELBOURNE', 'Bank of Melbourne'],
    ['BANKWEST', 'BankWest'],
    ['NATIONAL AUSTRALIA BANK', 'NAB'],
    ['\bNAB\b', 'NAB'],
    ['MACQUARIE', 'Macquarie'],
    ['ING DIRECT', 'ING'],
    ['\bING\b', 'ING'],
    ['BENDIGO', 'Bendigo Bank'],
    ['SUNCORP', 'Suncorp'],
    ['BANK OF QUEENSLAND', 'BOQ'],
    ['\bBOQ\b', 'BOQ'],
    ['AMERICAN EXPRESS', 'Amex'],
    ['AMEX', 'Amex'],
    ['CITIBANK', 'Citibank'],
    ['CITI ', 'Citibank'],
    ['HSBC', 'HSBC'],
    ['UP BANK', 'Up'],
    ['\bUP\b', 'Up'],
    ['UBANK', 'UBank'],
    ['86 400', '86 400'],
    ['ATHENA', 'Athena'],
    ['GREAT SOUTHERN BANK', 'Great Southern Bank'],
    ['TEACHERS MUTUAL', 'Teachers Mutual'],
    ['POLICE BANK', 'Police Bank'],
    ['BEYOND BANK', 'Beyond Bank'],
  ];
  for (const [pattern, name] of institutions) {
    if (new RegExp(pattern).test(upper)) return name;
  }
  return null;
}

/**
 * Parse a monetary string like "$1,234.56" or "1234.56" or "1,234.56-" to a number.
 * Returns null if it can't be parsed.
 */
function parseMoney(s: string): number | null {
  if (!s) return null;
  const clean = s.replace(/[$,\s]/g, '').replace(/CR$/i, '').trim();
  const negative = clean.endsWith('-') || /\bDR\b/i.test(s);
  const n = parseFloat(clean.replace(/-$/, ''));
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : Math.abs(n);
}

/**
 * Parse a date string into YYYY-MM-DD. Handles:
 *   DD/MM/YYYY, DD/MM/YY, DD MMM YYYY, DD MMM YY, YYYY-MM-DD
 */
function parseDate(s: string): string | null {
  s = s.trim();
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  // DD/MM/YYYY or DD/MM/YY
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  // DD MMM YYYY or DD MMM YY
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
  if (m) {
    const mon = months[m[2].toLowerCase()];
    if (!mon) return null;
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${mon}-${m[1].padStart(2, '0')}`;
  }

  // YYYY-MM-DD already
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;

  return null;
}

/** Auto-categorise a merchant name */
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

// ─── CommBank-specific parser ─────────────────────────────────────────────────
//
// CommBank PDF text layout (machine-readable statements):
//   DD Mon YYYY [Description] [-$X.XX | $X.XX] [$X.XX balance]
//
// Sometimes the date is on its own line, description on the next, amounts on the line after.

function parseCommBankStatement(text: string): { accounts: ParsedBankStatement[] } | null {
  const transactions: ParsedTransaction[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Regex: DD Mon YYYY at start of a string (with optional leading whitespace)
  const dateStartRe = /^(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\b/i;
  // Signed money: -$1,234.56 or $1,234.56 or -1,234.56 or 1,234.56
  const moneyRe = /(-?\$?[\d,]+\.\d{2})/g;

  const skipRe = /^(date|description|debit|credit|balance|transaction|opening|closing|total|brought forward|carried forward|page|bsb|account|statement|period)/i;

  let i = 0;
  while (i < lines.length) {
    const dateMatch = lines[i].match(dateStartRe);
    if (!dateMatch) { i++; continue; }

    const dateStr = parseDate(dateMatch[1]);
    if (!dateStr) { i++; continue; }

    // What follows the date on the same line?
    const sameLine = lines[i].slice(dateMatch[0].length).trim();

    let merchant = '';
    let amountsRaw = '';

    // Try to find money values on the same line or on subsequent lines
    const sameLineMoneys = sameLine.match(moneyRe);

    if (sameLineMoneys && sameLineMoneys.length >= 1) {
      // Everything before first money value is the description
      const firstMoneyIdx = sameLine.search(/-?\$?[\d,]+\.\d{2}/);
      merchant   = sameLine.slice(0, firstMoneyIdx).trim();
      amountsRaw = sameLine.slice(firstMoneyIdx);
    } else if (sameLine.length > 2 && !sameLine.match(/^\$?[\d,]+\.\d{2}/)) {
      // Same line has description but no amounts → look ahead for amounts
      merchant = sameLine;
      if (i + 1 < lines.length && lines[i + 1].match(moneyRe)) {
        amountsRaw = lines[i + 1];
        i++;
      }
    } else {
      // Date only on this line → description on next line, amounts after that
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (skipRe.test(nextLine) || dateStartRe.test(nextLine)) { i++; continue; }
        if (nextLine.match(moneyRe)) {
          // The next line is actually amounts — no description
          amountsRaw = nextLine;
          i++;
        } else {
          merchant = nextLine;
          i++;
          if (i + 1 < lines.length && lines[i + 1].match(moneyRe)) {
            amountsRaw = lines[i + 1];
            i++;
          }
        }
      }
    }

    if (!merchant || !amountsRaw) { i++; continue; }
    if (skipRe.test(merchant)) { i++; continue; }

    // Parse all money values from amountsRaw
    const amounts: number[] = [];
    let mm: RegExpExecArray | null;
    moneyRe.lastIndex = 0;
    while ((mm = moneyRe.exec(amountsRaw)) !== null) {
      const v = parseMoney(mm[1]);
      if (v !== null) amounts.push(v);
    }
    if (amounts.length === 0) { i++; continue; }

    // First amount is transaction amount; last is running balance (if 2+ amounts present)
    const txAmt = amounts[0];

    // Determine debit vs credit:
    //  • explicit negative sign → debit
    //  • known income keywords → credit
    //  • otherwise → debit (most transactions are expenses)
    const hasExplicitMinus = /^-/.test(amountsRaw.trim()) || amountsRaw.includes('-$');
    const isIncome = /salary|payroll|employer|direct\s*credit|interest\s*credit|deposit|refund/i.test(merchant);
    const type: 'debit' | 'credit' = hasExplicitMinus ? 'debit' : isIncome ? 'credit' : 'debit';

    transactions.push({
      date: dateStr,
      merchant: merchant.replace(/\s{2,}/g, ' ').slice(0, 80),
      amount: type === 'debit' ? -Math.abs(txAmt) : Math.abs(txAmt),
      type,
      category: autoCategory(merchant),
    });

    i++;
  }

  if (transactions.length === 0) return null;

  // Extract metadata
  const bsbMatch  = text.match(/BSB[:\s#]+(\d{3}[-\s]?\d{3})/i);
  const bsb       = bsbMatch ? bsbMatch[1].replace(/[\s]/g, '') : null;
  const accMatch  = text.match(/(?:account\s+(?:number|no\.?))[:\s]+(\d[\d\s]{5,14}\d)/i);
  const accountNumber = accMatch ? accMatch[1].replace(/\s/g, '') : null;

  let balance: number | null = null;
  const closingM  = text.match(/closing\s+balance[:\s]+\$?([\d,]+\.\d{2})/i);
  const availM    = text.match(/available\s+balance[:\s]+\$?([\d,]+\.\d{2})/i);
  if (closingM) balance = parseMoney(closingM[1]);
  else if (availM) balance = parseMoney(availM[1]);
  // Fallback: last amount in the last transaction is the running balance
  if (balance === null && transactions.length > 0) {
    const lastLine = text.split('\n').reverse().find(l => /\$?[\d,]+\.\d{2}/.test(l));
    if (lastLine) {
      const lastAmounts = [...lastLine.matchAll(/\$?([\d,]+\.\d{2})/g)].map(m => parseMoney(m[1])).filter((n): n is number => n !== null);
      if (lastAmounts.length > 0) balance = lastAmounts[lastAmounts.length - 1];
    }
  }

  const nameMatch = text.match(/(?:account\s+name)[:\s]+([A-Za-z0-9 &'-]+?)(?:\n|BSB|Account\s+Number)/i);
  const accountName = nameMatch ? nameMatch[1].trim() : null;

  return {
    accounts: [{
      name:           accountName,
      institution:    'CommBank',
      account_type:   /savings/i.test(text) ? 'Savings' : 'Everyday',
      balance,
      bsb,
      account_number: accountNumber,
      currency:       'AUD',
      transactions,
    }],
  };
}

// ─── Bank statement parser ────────────────────────────────────────────────────

export function parseBankStatementText(text: string): { accounts: ParsedBankStatement[] } | null {
  const institution = detectInstitution(text);

  // Try institution-specific parser first for better accuracy
  if (institution === 'CommBank') {
    const result = parseCommBankStatement(text);
    if (result && result.accounts[0].transactions.length > 0) {
      console.log(`[pdfParser] CommBank-specific parser extracted ${result.accounts[0].transactions.length} transactions`);
      return result;
    }
    console.log('[pdfParser] CommBank-specific parser found no transactions — falling through to generic parser');
  }

  // BSB: 6-digit groups like 062-001 or 062001
  const bsbMatch = text.match(/\b(\d{3}[-\s]?\d{3})\b/);
  const bsb = bsbMatch ? bsbMatch[1].replace(/\s/g, '') : null;

  // Account number: look for "Account Number" label then digits, or standalone 8-10 digit run
  let accountNumber: string | null = null;
  const accLabelMatch = text.match(/(?:account\s+(?:number|no\.?|#)\s*:?\s*)(\d[\d\s-]{5,14}\d)/i);
  if (accLabelMatch) {
    accountNumber = accLabelMatch[1].replace(/[\s-]/g, '');
  } else {
    const standaloneMatch = text.match(/\b(\d{8,10})\b/);
    if (standaloneMatch) accountNumber = standaloneMatch[1];
  }

  // Balance: look for closing/available/current balance label
  let balance: number | null = null;
  const balancePatterns = [
    /closing\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /available\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /current\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /balance[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const pattern of balancePatterns) {
    const m = text.match(pattern);
    if (m) { balance = parseMoney(m[1]); break; }
  }

  // Account type
  let accountType = 'Everyday';
  if (/savings/i.test(text)) accountType = 'Savings';
  else if (/offset/i.test(text)) accountType = 'Offset';
  else if (/transaction/i.test(text)) accountType = 'Transaction';
  else if (/term\s+deposit/i.test(text)) accountType = 'Term Deposit';

  // Account name: try label patterns
  let accountName: string | null = null;
  const nameLabelMatch = text.match(/(?:account\s+name|product\s+name)[:\s]+([A-Za-z0-9 &]+?)(?:\n|BSB|Account)/i);
  if (nameLabelMatch) accountName = nameLabelMatch[1].trim();

  // ── Transaction parsing ──
  // Look for lines with: date, description, amount, optional balance
  // Pattern: date  description  [debit]  [credit]  [balance]
  const transactions: ParsedTransaction[] = [];

  // Split into lines and look for transaction-like rows
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Date patterns for matching
  const dateRe = /^(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/;
  // Money pattern: currency amount possibly with debit/credit indicator
  const moneyRe = /\$?([\d,]+\.\d{2})\s*(CR|DR)?/i;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;

    const dateMatch = line.match(dateRe);
    if (!dateMatch) continue;
    const dateStr = parseDate(dateMatch[1]);
    if (!dateStr) continue;

    // Remove the date from start, what remains is description + amounts
    const rest = line.slice(dateMatch[0].length).trim();

    // Find all money amounts in this line
    const amounts: { value: number; pos: number }[] = [];
    const globalMoneyRe = /\$?([\d,]+\.\d{2})\s*(CR|DR)?/gi;
    let mm;
    while ((mm = globalMoneyRe.exec(rest)) !== null) {
      const val = parseMoney(mm[0]);
      if (val !== null) amounts.push({ value: val, pos: mm.index });
    }

    if (amounts.length === 0) continue;

    // Description is everything before the first amount
    const firstAmountPos = amounts[0].pos;
    let merchant = rest.slice(0, firstAmountPos).trim();
    // Clean up merchant: remove leading/trailing punctuation, collapse spaces
    merchant = merchant.replace(/[|·•\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!merchant || merchant.length < 2) continue;
    // Skip lines that are just totals/summaries
    if (/^(total|balance|opening|closing|brought forward|carried forward|sub.?total)/i.test(merchant)) continue;

    // Determine if debit or credit
    // Banks usually have separate debit and credit columns; with two amounts
    // the first is the transaction amount, second is running balance.
    // With one amount: check for CR suffix or negative sign.
    let amount: number;
    let type: 'debit' | 'credit';

    if (amounts.length >= 2) {
      // First amount is the transaction, second is running balance
      // Determine direction: if line contains "CR" near first amount it's credit
      const crNearFirst = /CR/i.test(rest.slice(0, amounts[0].pos + 15));
      type = crNearFirst ? 'credit' : 'debit';
      amount = amounts[0].value;
    } else {
      const rawAmt = rest.match(/\$?([\d,]+\.\d{2})\s*(CR|DR)?/i);
      const cr = rawAmt?.[2]?.toUpperCase() === 'CR';
      type = cr ? 'credit' : 'debit';
      amount = amounts[0].value;
    }

    // Some statements mark debits as negative in the extracted text
    if (amounts[0].value < 0) { type = 'debit'; amount = Math.abs(amounts[0].value); }

    // Also catch salary/employer deposits as credit
    if (/salary|payroll|employer|direct credit|interest credit/i.test(merchant)) type = 'credit';

    transactions.push({
      date: dateStr,
      merchant: merchant.slice(0, 80),
      amount: type === 'debit' ? -amount : amount,
      type,
      category: autoCategory(merchant),
    });
  }

  return {
    accounts: [{
      name: accountName,
      institution,
      account_type: accountType,
      balance,
      bsb,
      account_number: accountNumber,
      currency: 'AUD',
      transactions: transactions.slice(0, 50),
    }],
  };
}

// ─── Credit card statement parser ────────────────────────────────────────────

export function parseCreditCardStatementText(text: string): ParsedCardStatement | null {
  const institution = detectInstitution(text);

  // Card name: look for product name labels
  let cardName: string | null = null;
  const cardNamePatterns = [
    /(?:card\s+name|product\s+name|account\s+name)[:\s]+([A-Za-z0-9 &]+?)(?:\n|Card Number|Account)/i,
    /((?:ANZ|CommBank|Westpac|NAB|Amex|Citibank|Macquarie)[^\n]{3,40}(?:card|rewards|platinum|black|gold|visa|mastercard))/i,
  ];
  for (const p of cardNamePatterns) {
    const m = text.match(p);
    if (m) { cardName = m[1].trim(); break; }
  }
  if (!cardName && institution) cardName = institution + ' Credit Card';

  // Closing/outstanding balance
  let closingBalance: number | null = null;
  const balancePatterns = [
    /(?:closing|statement|outstanding|new)\s+balance[:\s]+\$?([\d,]+\.\d{2})/i,
    /amount\s+(?:due|owing)[:\s]+\$?([\d,]+\.\d{2})/i,
    /total\s+amount\s+due[:\s]+\$?([\d,]+\.\d{2})/i,
    /balance\s+(?:due|owing)[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const p of balancePatterns) {
    const m = text.match(p);
    if (m) { closingBalance = parseMoney(m[1]); break; }
  }

  // Credit limit
  let creditLimit: number | null = null;
  const limitPatterns = [
    /credit\s+(?:limit|line)[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
    /(?:approved|total)\s+credit[:\s]+\$?([\d,]+(?:\.\d{2})?)/i,
  ];
  for (const p of limitPatterns) {
    const m = text.match(p);
    if (m) { creditLimit = parseMoney(m[1]); break; }
  }

  // Minimum payment
  let minimumPayment: number | null = null;
  const minPatterns = [
    /minimum\s+(?:payment|amount\s+due)[:\s]+\$?([\d,]+\.\d{2})/i,
    /min(?:imum)?\s+due[:\s]+\$?([\d,]+\.\d{2})/i,
    /pay\s+at\s+least[:\s]+\$?([\d,]+\.\d{2})/i,
  ];
  for (const p of minPatterns) {
    const m = text.match(p);
    if (m) { minimumPayment = parseMoney(m[1]); break; }
  }

  // Due date
  let dueDate: string | null = null;
  const dueDatePatterns = [
    /(?:payment\s+)?due\s+(?:date|by)[:\s]+(\d{1,2}[\/ ]\d{1,2}[\/ ]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i,
    /pay\s+by[:\s]+(\d{1,2}[\/ ]\d{1,2}[\/ ]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})/i,
  ];
  for (const p of dueDatePatterns) {
    const m = text.match(p);
    if (m) { dueDate = parseDate(m[1]); if (dueDate) break; }
  }

  // Statement period
  let statementPeriod: string | null = null;
  const periodMatch = text.match(/statement\s+period[:\s]+([^\n]{5,40})/i);
  if (periodMatch) statementPeriod = periodMatch[1].trim();

  // ── Transactions ──
  const transactions: ParsedTransaction[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const dateRe = /^(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateMatch = line.match(dateRe);
    if (!dateMatch) continue;
    const dateStr = parseDate(dateMatch[1]);
    if (!dateStr) continue;

    const rest = line.slice(dateMatch[0].length).trim();
    const moneyRe = /\$?([\d,]+\.\d{2})\s*(CR)?/gi;
    const amounts: { value: number; isCr: boolean; pos: number }[] = [];
    let mm;
    while ((mm = moneyRe.exec(rest)) !== null) {
      const val = parseMoney(mm[1]);
      if (val !== null) amounts.push({ value: val, isCr: !!mm[2], pos: mm.index });
    }
    if (amounts.length === 0) continue;

    const firstAmountPos = amounts[0].pos;
    let merchant = rest.slice(0, firstAmountPos).trim()
      .replace(/[|·•\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!merchant || merchant.length < 2) continue;
    if (/^(total|balance|opening|closing|payment|credit|interest|fee|charge)/i.test(merchant)) {
      // Keep fee/interest lines as they're legitimate transactions
      if (/^(total|balance|opening|closing)/i.test(merchant)) continue;
    }

    const amount = amounts[0].value;
    // Credit card: payments back to card are CR (reduce balance), purchases are debits
    const type = amounts[0].isCr ? 'credit' : 'debit';

    transactions.push({
      date: dateStr,
      merchant: merchant.slice(0, 80),
      amount: type === 'debit' ? -amount : amount,
      type,
      category: autoCategory(merchant),
    });
  }

  return {
    institution,
    card_name: cardName,
    statement_period: statementPeriod,
    closing_balance: closingBalance,
    credit_limit: creditLimit,
    minimum_payment: minimumPayment,
    due_date: dueDate,
    transactions: transactions.slice(0, 50),
  };
}

// ─── Subscription statement parser ───────────────────────────────────────────

const KNOWN_SUBSCRIPTIONS: Array<{ pattern: RegExp; name: string; category: string }> = [
  { pattern: /netflix/i, name: 'Netflix', category: 'Entertainment' },
  { pattern: /spotify/i, name: 'Spotify', category: 'Entertainment' },
  { pattern: /apple\s*(one|tv|music|icloud|\+)/i, name: 'Apple', category: 'Entertainment' },
  { pattern: /disney\+|disney plus/i, name: 'Disney+', category: 'Entertainment' },
  { pattern: /stan\b/i, name: 'Stan', category: 'Entertainment' },
  { pattern: /binge\b/i, name: 'Binge', category: 'Entertainment' },
  { pattern: /kayo/i, name: 'Kayo Sports', category: 'Entertainment' },
  { pattern: /youtube\s*premium/i, name: 'YouTube Premium', category: 'Entertainment' },
  { pattern: /amazon\s*prime/i, name: 'Amazon Prime', category: 'Entertainment' },
  { pattern: /paramount\+/i, name: 'Paramount+', category: 'Entertainment' },
  { pattern: /adobe/i, name: 'Adobe', category: 'Software' },
  { pattern: /microsoft\s*(365|office)/i, name: 'Microsoft 365', category: 'Software' },
  { pattern: /google\s*(one|workspace|drive)/i, name: 'Google One', category: 'Software' },
  { pattern: /dropbox/i, name: 'Dropbox', category: 'Software' },
  { pattern: /github/i, name: 'GitHub', category: 'Software' },
  { pattern: /openai|chatgpt/i, name: 'ChatGPT', category: 'Software' },
  { pattern: /notion/i, name: 'Notion', category: 'Software' },
  { pattern: /slack/i, name: 'Slack', category: 'Software' },
  { pattern: /telstra/i, name: 'Telstra', category: 'Telecommunications' },
  { pattern: /optus/i, name: 'Optus', category: 'Telecommunications' },
  { pattern: /vodafone/i, name: 'Vodafone', category: 'Telecommunications' },
  { pattern: /tpg/i, name: 'TPG', category: 'Telecommunications' },
  { pattern: /aussie\s*broadband/i, name: 'Aussie Broadband', category: 'Telecommunications' },
  { pattern: /iinet/i, name: 'iiNet', category: 'Telecommunications' },
  { pattern: /nbn/i, name: 'NBN', category: 'Telecommunications' },
  { pattern: /gym|anytime\s*fitness|f45|crossfit|planet\s*fitness/i, name: 'Gym', category: 'Fitness' },
  { pattern: /the\s*australian|sydney\s*morning|age\s*(digital)?|afr|financial\s*review/i, name: 'News Subscription', category: 'News' },
];

export function parseSubscriptionStatementText(text: string): ParsedSubscriptionStatement {
  const found = new Map<string, { name: string; amount: number; frequency: string; next_charge_date: string | null; category: string }>();

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const dateRe = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/;
  const moneyRe = /\$?([\d,]+\.\d{2})/;

  for (const line of lines) {
    for (const { pattern, name, category } of KNOWN_SUBSCRIPTIONS) {
      if (!pattern.test(line)) continue;
      const amtMatch = line.match(moneyRe);
      const amount = amtMatch ? parseMoney(amtMatch[1]) ?? 0 : 0;
      const dateMatch = line.match(dateRe);
      const date = dateMatch ? parseDate(dateMatch[1]) : null;

      if (!found.has(name) && amount > 0) {
        found.set(name, { name, amount, frequency: 'monthly', next_charge_date: date, category });
      }
    }
  }

  return { subscriptions: Array.from(found.values()) };
}
