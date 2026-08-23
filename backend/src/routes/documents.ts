/**
 * Phase 8.1 — the financial document vault.
 *
 * Statements, payslips, tax paperwork, loan and property documents, insurance
 * policies. The FILES live in a private Supabase Storage bucket and only ever
 * move through here — authenticated, checked, streamed — so no public URL to a
 * document exists anywhere. The METADATA lives in the `documents` table
 * (database/2026-document-vault.sql).
 *
 * Who sees what is decided entirely by services/documentVault.ts (pure,
 * tested): a document follows the record it is linked to. Rename, re-file and
 * delete are owner-only, always.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { loadScope } from '../services/householdScope';
import {
  DOCUMENTS_BUCKET, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, TABLE_OF_LINK,
  isAcceptedMime, storagePathFor, pickDocumentFields, documentVisibilityFilter,
  canSeeDocument, linkTargetRefusal, sanitizeFilename,
  DocumentMetadata, LinkedType,
} from '../services/documentVault';

const router = Router();
router.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_UPLOAD },
});

/** True when Postgres is telling us the migration hasn't run yet. */
const isMissingTable = (err: { code?: string; message?: string } | null): boolean =>
  !!err && (err.code === '42P01' || err.code === 'PGRST205'
    || /relation .* does not exist|could not find the table/i.test(err.message ?? ''));

const MIGRATION_HINT =
  'Document vault not set up yet — run database/2026-document-vault.sql in Supabase.';

/**
 * The bucket is created lazily on first use rather than by the migration:
 * storage buckets are made through the API, not SQL, and the service-role key
 * this backend already holds is allowed to. Private — file access is only ever
 * through these routes.
 */
let bucketReady = false;
async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const { error } = await supabase.storage.createBucket(DOCUMENTS_BUCKET, {
    public: false,
    fileSizeLimit: MAX_FILE_BYTES,
  });
  // "already exists" is the steady state, not a failure.
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`storage bucket unavailable: ${error.message}`);
  }
  bucketReady = true;
}

/**
 * Validate a requested link before it is written: the target must exist and be
 * visible to the caller. One row read for record links; none for households
 * (answered from scope) or tax years (the caller's own by construction).
 */
async function refuseLink(
  fields: DocumentMetadata, scope: Awaited<ReturnType<typeof loadScope>>,
): Promise<{ status: number; error: string } | null> {
  if (!fields.linked_type || !fields.linked_id) return null;
  const type = fields.linked_type as LinkedType;

  let targetOwnerId: string | null = null;
  const table = TABLE_OF_LINK[type];
  if (table) {
    const { data } = await supabase
      .from(table).select('user_id').eq('id', fields.linked_id).maybeSingle();
    targetOwnerId = (data as { user_id?: string } | null)?.user_id ?? null;
  }
  return linkTargetRefusal(type, fields.linked_id, targetOwnerId, scope);
}

// ── GET /api/documents ───────────────────────────────────────────────────────
// Everything the caller may see: their own, plus documents filed to a household
// they are in or to a record shared with them. Metadata only — never bytes.
router.get('/', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const filter = documentVisibilityFilter(scope);
  let query = supabase.from('documents').select('*');
  query = filter ? query.or(filter) : query.eq('user_id', scope.userId);
  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    // Fail soft before the migration: an empty vault, not a broken app.
    if (isMissingTable(error)) {
      console.warn('[documents] table missing — run 2026-document-vault.sql');
      res.json([]);
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data ?? []);
});

// ── POST /api/documents ──────────────────────────────────────────────────────
// Multipart upload of one or more files sharing one set of metadata (a batch of
// payslips is one filing act). Each file becomes its own document row so it can
// be renamed, re-filed and deleted on its own afterwards.
router.post('/', upload.array('files', MAX_FILES_PER_UPLOAD), async (req: AuthRequest, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) { res.status(400).json({ error: 'No files uploaded.' }); return; }

  for (const f of files) {
    if (!isAcceptedMime(f.mimetype)) {
      res.status(400).json({
        error: `'${f.originalname}' is a ${f.mimetype || 'unknown'} file — use PDF, image, CSV, text, Word or Excel.`,
      });
      return;
    }
  }

  const { fields, refusal } = pickDocumentFields(req.body ?? {});
  if (refusal) { res.status(400).json({ error: refusal.error }); return; }

  const scope = await loadScope(req.user!.userId);
  const linkRefusal = await refuseLink(fields, scope);
  if (linkRefusal) { res.status(linkRefusal.status).json({ error: linkRefusal.error }); return; }

  try {
    await ensureBucket();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const created: unknown[] = [];
  for (const file of files) {
    const documentId = randomUUID();
    const path = storagePathFor(req.user!.userId, documentId, file.originalname);

    const uploaded = await supabase.storage.from(DOCUMENTS_BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploaded.error) {
      res.status(500).json({
        error: `Could not store '${file.originalname}': ${uploaded.error.message}`,
        created,
      });
      return;
    }

    const row = {
      id: documentId,
      user_id: req.user!.userId,
      // A caller-chosen name only makes sense for a single file; a batch keeps
      // each file's own name so ten payslips don't all become "October".
      name: files.length === 1 && fields.name ? fields.name : sanitizeFilename(file.originalname),
      original_filename: file.originalname.slice(0, 300),
      storage_path: path,
      mime_type: file.mimetype,
      size_bytes: file.size,
      document_type: fields.document_type ?? 'other',
      document_date: fields.document_date ?? null,
      provider: fields.provider ?? null,
      notes: fields.notes ?? null,
      linked_type: fields.linked_type ?? null,
      linked_id: fields.linked_id ?? null,
    };

    const { data, error } = await supabase.from('documents').insert(row).select().single();
    if (error) {
      // Never leave an orphaned object behind a failed row: the file without
      // its metadata is unreachable and undeletable from the UI.
      await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
      const message = isMissingTable(error) ? MIGRATION_HINT : error.message;
      res.status(500).json({ error: message, created });
      return;
    }
    created.push(data);
  }

  res.status(201).json({ documents: created });
});

// ── GET /api/documents/:id/file ──────────────────────────────────────────────
// The bytes, for preview (inline) or download (?download=1 → attachment).
// Same visibility rule as the list, checked against the one fetched row.
router.get('/:id/file', async (req: AuthRequest, res: Response) => {
  const { data: doc, error } = await supabase
    .from('documents').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !doc) { res.status(404).json({ error: 'Not found' }); return; }

  const scope = await loadScope(req.user!.userId);
  if (!canSeeDocument(doc, scope)) { res.status(404).json({ error: 'Not found' }); return; }

  const file = await supabase.storage.from(DOCUMENTS_BUCKET).download(doc.storage_path);
  if (file.error || !file.data) {
    res.status(500).json({ error: `Could not read the stored file: ${file.error?.message ?? 'empty'}` });
    return;
  }

  const buffer = Buffer.from(await file.data.arrayBuffer());
  const disposition = req.query.download ? 'attachment' : 'inline';
  const filename = encodeURIComponent(doc.original_filename || doc.name || 'document');
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${filename}`);
  res.send(buffer);
});

// ── PATCH /api/documents/:id ─────────────────────────────────────────────────
// Rename / re-file / re-link. OWNER-ONLY: a household member may look at the
// mortgage contract, not rename it. 404 (not 403) for rows the caller can't
// see, so ids can't be probed.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const { data: doc, error } = await supabase
    .from('documents').select('id, user_id, linked_type, linked_id')
    .eq('id', req.params.id).maybeSingle();
  if (error || !doc) { res.status(404).json({ error: 'Not found' }); return; }

  const scope = await loadScope(req.user!.userId);
  if (doc.user_id !== scope.userId) {
    if (canSeeDocument(doc, scope)) {
      res.status(403).json({ error: 'Only the person this belongs to can change it.' });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
    return;
  }

  const { fields, refusal } = pickDocumentFields(req.body ?? {});
  if (refusal) { res.status(400).json({ error: refusal.error }); return; }
  const linkRefusal = await refuseLink(fields, scope);
  if (linkRefusal) { res.status(linkRefusal.status).json({ error: linkRefusal.error }); return; }

  const { data, error: updateError } = await supabase
    .from('documents')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (updateError) { res.status(500).json({ error: updateError.message }); return; }
  res.json(data);
});

// ── DELETE /api/documents/:id ────────────────────────────────────────────────
// Owner-only, like every delete in this app. The stored object goes first —
// a metadata row without its file is a broken promise, but a file without its
// row is unreachable forever.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const { data: doc, error } = await supabase
    .from('documents').select('id, user_id, linked_type, linked_id, storage_path')
    .eq('id', req.params.id).maybeSingle();
  if (error || !doc) { res.status(404).json({ error: 'Not found' }); return; }

  const scope = await loadScope(req.user!.userId);
  if (doc.user_id !== scope.userId) {
    if (canSeeDocument(doc, scope)) {
      res.status(403).json({ error: 'Only the person this belongs to can delete it.' });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
    return;
  }

  const removed = await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path]);
  // A missing object is fine (already gone); any other storage failure aborts so
  // the row keeps pointing at a file that still exists.
  if (removed.error && !/not.?found/i.test(removed.error.message)) {
    res.status(500).json({ error: `Could not remove the stored file: ${removed.error.message}` });
    return;
  }

  const { error: deleteError } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (deleteError) { res.status(500).json({ error: deleteError.message }); return; }
  res.json({ success: true });
});

export default router;
