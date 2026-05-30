import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parseFinancialDocument, parsePortfolioText } from '../services/claudeService';
import {
  extractPdfText, isGarbledText, countDateLines,
  parseBankStatementText, parseCreditCardStatementText, parseSubscriptionStatementText,
} from '../services/pdfParser';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Log every request that arrives at this router (before multer runs)
router.use((req, _res, next) => {
  console.log(`[upload] router hit — ${req.method} ${req.path}`);
  next();
});

router.post('/parse', upload.single('file'), async (req: Request, res: Response) => {
  console.log('[upload] handler hit — starting parse');
  console.log('[upload] CLAUDE_API_KEY set:', !!process.env.CLAUDE_API_KEY);
  console.log('[upload] key prefix:', process.env.CLAUDE_API_KEY?.slice(0, 25) + '...');

  if (!req.file) {
    console.log('[upload] ERROR: no file in request');
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const { document_type } = req.body;
  if (!document_type) {
    console.log('[upload] ERROR: document_type missing');
    res.status(400).json({ error: 'document_type required' });
    return;
  }

  console.log(`[upload] file="${req.file.originalname}" mime="${req.file.mimetype}" size=${req.file.size}B doc_type="${document_type}"`);

  // ── CSV / plain-text files → send as text, not base64 document ─────────────
  const isCsv =
    req.file.mimetype.includes('csv') ||
    (req.file.mimetype === 'text/plain' && req.file.originalname.toLowerCase().endsWith('.csv')) ||
    req.file.originalname.toLowerCase().endsWith('.csv');

  if (isCsv) {
    const csvText = req.file.buffer.toString('utf-8');
    console.log(`[upload] CSV detected (${csvText.length} chars) → parsePortfolioText`);
    try {
      const t0 = Date.now();
      const result = await parsePortfolioText(csvText);
      console.log(`[upload] ✓ CSV parsed in ${Date.now() - t0}ms, keys:`, Object.keys(result));
      res.json({ parsed: result, filename: req.file.originalname });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[upload] ✗ CSV parse error:', msg);
      res.status(500).json({ error: 'Portfolio CSV parsing failed', detail: msg });
    }
    return;
  }

  // ── PDF / image → try local parse first, fall back to Claude ──────────────
  const validMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validMimes.includes(req.file.mimetype)) {
    console.log(`[upload] ERROR: unsupported mime type "${req.file.mimetype}"`);
    res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}. Use PDF, image, or CSV.` });
    return;
  }

  const isPdf = req.file.mimetype === 'application/pdf';
  console.log(`[upload] isPdf=${isPdf}`);

  // ── ALWAYS try pdf-parse text extraction for PDFs ──────────────────────────
  // Only call Claude if fewer than 5 date lines found (scanned/image-only PDF).
  if (isPdf) {
    const localTypes = ['bank_statement', 'credit_card_statement', 'credit_card', 'subscription_statement'];
    console.log(`[upload] attempting pdf-parse extraction...`);
    try {
      const t0 = Date.now();
      const text = await extractPdfText(req.file.buffer);
      const elapsed = Date.now() - t0;
      const dateLineCount = countDateLines(text);
      console.log(`[upload] pdf-parse extracted ${text.length} chars, ${dateLineCount} date lines (${elapsed}ms)`);
      console.log('[upload] extracted text sample:', text.slice(0, 500));
      console.log('[upload] RAW TEXT:', JSON.stringify(text));

      if (dateLineCount < 5) {
        console.log(`[upload] using PAID Claude path — reason: only ${dateLineCount} date lines found (scanned/image PDF)`);
      } else if (localTypes.includes(document_type)) {
        console.log(`[upload] using FREE pdf-parse path — ${dateLineCount} date lines, doc_type="${document_type}"`);
        let result: Record<string, unknown> | null = null;

        if (document_type === 'bank_statement') {
          result = parseBankStatementText(text) as unknown as Record<string, unknown>;
        } else if (document_type === 'credit_card_statement' || document_type === 'credit_card') {
          result = parseCreditCardStatementText(text) as unknown as Record<string, unknown>;
        } else if (document_type === 'subscription_statement') {
          result = parseSubscriptionStatementText(text) as unknown as Record<string, unknown>;
        }

        if (result) {
          console.log(`[upload] ✓ FREE parse success in ${Date.now() - t0}ms, keys:`, Object.keys(result));
          res.json({ parsed: result, filename: req.file.originalname, source: 'local' });
          return;
        }
        // Regex parser returned null (format not recognised) — fall through to Claude
        console.log(`[upload] using PAID Claude path — reason: local regex parser returned null for doc_type="${document_type}"`);
      } else {
        // Readable PDF but no local parser for this doc type (portfolio, payslip, etc.)
        console.log(`[upload] using PAID Claude path — reason: no local parser for doc_type="${document_type}" (${dateLineCount} date lines found)`);
      }
    } catch (localErr) {
      const errMsg = localErr instanceof Error ? localErr.message : String(localErr);
      console.warn(`[upload] pdf-parse threw an error — falling back to Claude: ${errMsg}`);
      console.log(`[upload] using PAID Claude path — reason: pdf-parse exception`);
    }
  } else {
    console.log(`[upload] using PAID Claude path — reason: file is an image, not a PDF`);
  }

  // ── Fall back to Claude API (scanned images, investment portfolios, payslips, etc.) ──
  const base64 = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype as 'application/pdf' | 'image/jpeg' | 'image/png';

  try {
    console.log('[upload] calling Claude API — this call costs money');
    const t0 = Date.now();
    const result = await parseFinancialDocument(base64, mediaType, document_type);
    console.log(`[upload] ✓ Claude API success in ${Date.now() - t0}ms, top-level keys:`, Object.keys(result));
    res.json({ parsed: result, filename: req.file.originalname, source: 'claude' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.error('[upload] ✗ Claude API error:', msg);
    if (stack) console.error('[upload] stack:', stack);
    res.status(500).json({ error: 'Document parsing failed', detail: msg });
  }
});

export default router;
