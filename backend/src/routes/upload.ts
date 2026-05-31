import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parseFinancialDocument, parsePortfolioText } from '../services/claudeService';
import { extractPdfText, isGarbledText, parseWithGemini } from '../services/pdfParser';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Log every request that arrives at this router (before multer runs)
router.use((req, _res, next) => {
  console.log(`[upload] router hit — ${req.method} ${req.path}`);
  next();
});

router.post('/parse', upload.single('file'), async (req: Request, res: Response) => {
  console.log('[upload] handler hit — starting parse');
  console.log('[upload] GEMINI_API_KEY set:', !!process.env.GEMINI_API_KEY);
  console.log('[upload] CLAUDE_API_KEY set:', !!process.env.CLAUDE_API_KEY);

  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const { document_type } = req.body;
  if (!document_type) {
    res.status(400).json({ error: 'document_type required' });
    return;
  }

  console.log(`[upload] file="${req.file.originalname}" mime="${req.file.mimetype}" size=${req.file.size}B doc_type="${document_type}"`);

  // ── CSV / plain-text files → existing portfolio parser ───────────────────
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
      console.log(`[upload] ✓ CSV parsed in ${Date.now() - t0}ms`);
      res.json({ parsed: result, filename: req.file.originalname });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[upload] ✗ CSV parse error:', msg);
      res.status(500).json({ error: 'Portfolio CSV parsing failed', detail: msg });
    }
    return;
  }

  // ── Validate mime ─────────────────────────────────────────────────────────
  const validMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validMimes.includes(req.file.mimetype)) {
    res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}. Use PDF, image, or CSV.` });
    return;
  }

  const isPdf = req.file.mimetype === 'application/pdf';

  // ── PDF: extract text → Gemini (free) → Claude fallback ──────────────────
  if (isPdf) {
    let extractedText = '';
    try {
      extractedText = await extractPdfText(req.file.buffer);
    } catch (extractErr) {
      console.warn('[upload] pdfjs extraction failed:', extractErr);
    }

    const readable = !isGarbledText(extractedText);
    const hasGemini = !!process.env.GEMINI_API_KEY;

    if (readable && hasGemini) {
      // ── FREE path: Gemini ───────────────────────────────────────────────
      console.log(`[upload] using FREE Gemini path — ${extractedText.length} chars extracted`);
      try {
        const t0 = Date.now();
        const result = await parseWithGemini(extractedText, document_type);
        console.log(`[upload] ✓ Gemini parse success in ${Date.now() - t0}ms, keys:`, Object.keys(result));
        res.json({ parsed: result, filename: req.file.originalname, source: 'gemini' });
        return;
      } catch (geminiErr) {
        const msg = geminiErr instanceof Error ? geminiErr.message : String(geminiErr);
        console.warn(`[upload] Gemini parse failed (${msg}) — falling back to Claude`);
      }
    } else if (readable && !hasGemini) {
      console.log('[upload] GEMINI_API_KEY not set — using Claude for readable PDF');
    } else {
      console.log('[upload] scanned/image PDF — using Claude for OCR');
    }
  } else {
    console.log('[upload] image file — using Claude');
  }

  // ── PAID fallback: Claude API ─────────────────────────────────────────────
  const base64    = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype as 'application/pdf' | 'image/jpeg' | 'image/png';

  try {
    console.log('[upload] calling Claude API — this call costs money');
    const t0 = Date.now();
    const result = await parseFinancialDocument(base64, mediaType, document_type);
    console.log(`[upload] ✓ Claude API success in ${Date.now() - t0}ms, keys:`, Object.keys(result));
    res.json({ parsed: result, filename: req.file.originalname, source: 'claude' });
  } catch (err) {
    const msg   = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.error('[upload] ✗ Claude API error:', msg);
    if (stack) console.error('[upload] stack:', stack);
    res.status(500).json({ error: 'Document parsing failed', detail: msg });
  }
});

export default router;
