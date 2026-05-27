import { Router, Request, Response } from 'express';
import multer from 'multer';
import { parseFinancialDocument, parsePortfolioText } from '../services/claudeService';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/parse', upload.single('file'), async (req: Request, res: Response) => {
  console.log('\n[upload] ─── POST /api/upload/parse ───');
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

  // ── PDF / image → base64 document to Claude ──────────────────────────────
  const validMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validMimes.includes(req.file.mimetype)) {
    res.status(400).json({ error: `Unsupported file type: ${req.file.mimetype}. Use PDF, image, or CSV.` });
    return;
  }

  const base64 = req.file.buffer.toString('base64');
  const mediaType = req.file.mimetype as 'application/pdf' | 'image/jpeg' | 'image/png';

  try {
    console.log('[upload] → calling Claude API...');
    const t0 = Date.now();
    const result = await parseFinancialDocument(base64, mediaType, document_type);
    console.log(`[upload] ✓ Claude API success in ${Date.now() - t0}ms, top-level keys:`, Object.keys(result));
    res.json({ parsed: result, filename: req.file.originalname });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : '';
    console.error('[upload] ✗ Claude API error:', msg);
    if (stack) console.error('[upload] stack:', stack);
    res.status(500).json({ error: 'Document parsing failed', detail: msg });
  }
});

export default router;
