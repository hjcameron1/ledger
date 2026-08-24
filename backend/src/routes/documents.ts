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
 * tested): a document follows the record it is linked to, and a document its
 * owner has shared to households is seen by those households' members — one
 * row, in as many households as it was put in, never a copy. Rename, re-file,
 * share and delete are owner-only, always.
 */
import { Router, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { loadScope, reconcileRecordHouseholds, refuseShare } from '../services/householdScope';
import { householdsOfLinks } from '../services/linkedVisibility';
import {
  DOCUMENTS_BUCKET, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, TABLE_OF_LINK,
  isAcceptedMime, storagePathFor, pickDocumentFields, documentVisibilityFilter,
  canSeeDocument, linkTargetRefusal, sanitizeFilename, pickHouseholdIds,
  DocumentMetadata, LinkedType,
} from '../services/documentVault';
import {
  sanitiseExtraction, isExtractableType, isExtractableMime, EXTRACTABLE_TYPES,
  FACT_FIELDS, FactSpec, parseMoney, parseRate, parseDateValue,
} from '../services/documentFacts';
import { extractDocumentFacts } from '../services/claudeService';

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

/**
 * Which households each document belongs to, on its way out to the client.
 *
 * TWO sources, merged into one list because to a reader they are one fact —
 * "which shared pictures does this paperwork appear in":
 *
 *   its OWN shares    `record_households` rows of type 'document' — what the
 *                     owner explicitly put it into.
 *   its LINK's        the households of the record it is filed against. A
 *                     statement on an account shared with "Home" belongs in
 *                     Home's view for exactly as long as the account does, so
 *                     un-sharing the account removes its paperwork with no
 *                     write against this table at all.
 *
 * One batched read for the whole page either way, and both fail soft: no ids
 * reads as "personal", which is the same safe fallback every other sharing
 * lookup takes.
 */
async function withHouseholds<T extends { id: string; linked_type?: string | null; linked_id?: string | null }>(
  rows: T[],
): Promise<(T & { household_ids: string[]; shared_household_ids: string[] })[]> {
  if (!rows.length) return [];

  const fromLinks = await householdsOfLinks(rows);

  const explicit = new Map<string, string[]>();
  const { data, error } = await supabase
    .from('record_households')
    .select('record_id, household_id')
    .eq('record_type', 'document')
    .in('record_id', rows.map(r => r.id));
  if (error) console.warn('[documents] household lookup failed:', error.message);
  for (const row of data ?? []) {
    const id = row.record_id as string;
    explicit.set(id, [...(explicit.get(id) ?? []), row.household_id as string]);
  }

  // Both lists go out, and they answer different questions. `household_ids` is
  // WHERE THIS APPEARS — what a household view filters on. `shared_household_ids`
  // is WHAT ITS OWNER PUT IT IN — what the sharing control may toggle, because
  // un-ticking a household a document only reaches through its link would be a
  // button that silently does nothing.
  return rows.map(r => {
    const own = explicit.get(r.id) ?? [];
    return {
      ...r,
      shared_household_ids: own,
      household_ids: [...new Set([...own, ...(fromLinks.get(r.id) ?? [])])],
    };
  });
}

/** One document's turn of the same. */
async function withHouseholdsOne<T extends { id: string; linked_type?: string | null; linked_id?: string | null }>(
  row: T,
): Promise<T & { household_ids: string[]; shared_household_ids: string[] }> {
  return (await withHouseholds([row]))[0];
}

/**
 * Put a document into exactly the households the request asked for.
 *
 * OWNER-ONLY, checked by the caller: sharing somebody else's paperwork would be
 * publishing data that was never yours. It writes nothing but the join — a
 * share can never rename a document, move its bytes or change whose it is — and
 * it is the same `reconcileRecordHouseholds` every other shareable row uses, so
 * a document cannot end up in a household twice however many times it is shared.
 */
async function applyDocumentShare(
  documentId: string, ownerUserId: string, desired: string[] | null,
  scope: Awaited<ReturnType<typeof loadScope>>,
): Promise<{ status: number; error: string } | null> {
  if (desired === null) return null;
  const refusal = await reconcileRecordHouseholds('document', documentId, ownerUserId, desired, scope);
  // The join's record_type is a CHECK, and 'document' joins it in a migration.
  // Until that has run, every share fails the same way — worth saying, because
  // "could not share that" alone would send somebody hunting for a bug.
  if (refusal?.status === 500) {
    return {
      status: 500,
      error: 'Could not share that — if document sharing was just deployed, run database/2026-document-sharing.sql in Supabase.',
    };
  }
  return refusal;
}

// ── GET /api/documents ───────────────────────────────────────────────────────
// Everything the caller may see: their own, plus documents shared to a household
// they are in, plus documents filed to a household they are in or to a record
// shared with them. Each carries the households it appears in, so the client can
// narrow to the one being looked at. Metadata only — never bytes.
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
  res.json(await withHouseholds((data ?? []) as { id: string; linked_type?: string | null }[]));
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

  // Filing straight into a household: the same share the edit screen makes,
  // asked for at upload time, and refused by the same rule. Checked BEFORE any
  // bytes are stored, so a household the caller may not share into cannot leave
  // a half-made document behind.
  const households = pickHouseholdIds(req.body ?? {});
  for (const householdId of households ?? []) {
    const refusal = refuseShare(householdId, scope);
    if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  }

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
    const shareRefusal = await applyDocumentShare(documentId, req.user!.userId, households, scope);
    if (shareRefusal) {
      res.status(shareRefusal.status).json({ error: shareRefusal.error, created });
      return;
    }
    created.push(await withHouseholdsOne(data as { id: string; linked_type?: string | null }));
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

  // Sharing rides along with the edit but is written separately: it is a row in
  // the join table, never a column on the document, so re-filing and re-sharing
  // can never overwrite one another.
  const shareRefusal = await applyDocumentShare(
    req.params.id, scope.userId, pickHouseholdIds(req.body ?? {}), scope,
  );
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  // An edit may be sharing alone, with no field to write — a bare update with
  // an empty patch is not worth a round trip.
  if (!Object.keys(fields).length) {
    const { data: current } = await supabase
      .from('documents').select('*').eq('id', req.params.id).maybeSingle();
    res.json(await withHouseholdsOne(current as { id: string; linked_type?: string | null }));
    return;
  }

  const { data, error: updateError } = await supabase
    .from('documents')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (updateError) { res.status(500).json({ error: updateError.message }); return; }
  res.json(await withHouseholdsOne(data as { id: string; linked_type?: string | null }));
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

  // The join has no foreign key to follow (one table across many entities never
  // can), so the shares are ended here. Left behind they would be invisible —
  // and would silently re-admit a household if the id were ever reused.
  const { error: shareError } = await supabase.from('record_households')
    .delete().eq('record_type', 'document').eq('record_id', req.params.id);
  if (shareError) console.warn('[documents] share cleanup failed:', shareError.message);

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 8.3 — what the documents SAY
// ═══════════════════════════════════════════════════════════════════════════
//
// The vault stores files; these three routes read one, report what was found,
// and let the person whose paperwork it is confirm or correct it. Nothing here
// invents a second permission system: a fact belongs to its document, and the
// document already decides who may see it (services/documentVault.ts). Reads
// follow the document; writes are owner-only, exactly like a rename.

const EXTRACTION_MODEL = 'claude-sonnet-4-5';

const FACTS_MIGRATION_HINT =
  'Document reading is not set up yet — run database/2026-document-facts.sql in Supabase.';

/**
 * Record what happened the last time this document was read.
 *
 * Swallows the "column does not exist" case on purpose: the facts table can be
 * in place before the ALTERs are, and a note about an extraction is not worth
 * failing the extraction over.
 */
async function noteExtraction(
  documentId: string, status: string, error: string | null,
): Promise<void> {
  const { error: err } = await supabase.from('documents').update({
    extraction_status: status,
    extraction_at: new Date().toISOString(),
    extraction_error: error,
  }).eq('id', documentId);
  if (err) console.warn('[documents] could not record extraction status:', err.message);
}

// ── GET /api/documents/facts ─────────────────────────────────────────────────
// Every fact read out of every document the caller may see. One call, because
// Ask Ledger needs the whole picture before it can answer a question about any
// of it — and because a per-document call would be a per-document permission
// check, which is a second chance to get the permission wrong.
//
// On a document that is only SHARED with the caller, confirmed facts alone are
// sent. A reading nobody has vouched for is a conversation between the owner
// and their own paperwork — it never leaves the server for anyone else, so
// nothing a viewer's Ask can build on is anything less than confirmed.
//
// One path segment, so it can never be read as the ':id' of '/:id/file'.
router.get('/facts', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const filter = documentVisibilityFilter(scope);
  let docQuery = supabase.from('documents').select('id, user_id');
  docQuery = filter ? docQuery.or(filter) : docQuery.eq('user_id', scope.userId);
  const { data: docs, error: docError } = await docQuery;
  if (docError) {
    if (isMissingTable(docError)) { res.json([]); return; }
    res.status(500).json({ error: docError.message });
    return;
  }

  const rows = (docs ?? []) as { id: string; user_id: string }[];
  const ids = rows.map(d => d.id);
  if (!ids.length) { res.json([]); return; }
  const owned = new Set(rows.filter(d => d.user_id === scope.userId).map(d => d.id));

  const { data, error } = await supabase
    .from('document_facts').select('*').in('document_id', ids)
    .order('created_at', { ascending: true });
  if (error) {
    // Before the migration this is an empty result, not a broken vault — the
    // same fail-soft the document list itself does.
    if (isMissingTable(error)) { res.json([]); return; }
    res.status(500).json({ error: error.message });
    return;
  }
  const visible = (data ?? []).filter(f => {
    const fact = f as { document_id: string; status: string };
    return owned.has(fact.document_id) || fact.status === 'confirmed';
  });
  res.json(visible);
});

// ── POST /api/documents/:id/extract ──────────────────────────────────────────
// Read one document and store what it says. OWNER-ONLY: reading somebody's
// mortgage contract out loud is not the same act as being allowed to look at
// it, and the facts are written under the owner's name.
router.post('/:id/extract', async (req: AuthRequest, res: Response) => {
  const { data: doc, error } = await supabase
    .from('documents').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !doc) { res.status(404).json({ error: 'Not found' }); return; }

  const scope = await loadScope(req.user!.userId);
  if (doc.user_id !== scope.userId) {
    res.status(canSeeDocument(doc, scope) ? 403 : 404).json({
      error: canSeeDocument(doc, scope)
        ? 'Only the person this belongs to can have it read.'
        : 'Not found',
    });
    return;
  }

  // What Ledger will and will not try to read. Said plainly, because "nothing
  // found" and "never looked at" are answers a user must be able to tell apart.
  if (!isExtractableType(doc.document_type)) {
    await noteExtraction(doc.id, 'unsupported', null);
    res.status(400).json({
      error: `Ledger reads ${EXTRACTABLE_TYPES.join(', ')} documents. This one is filed as ${doc.document_type}.`,
    });
    return;
  }
  if (!isExtractableMime(doc.mime_type)) {
    await noteExtraction(doc.id, 'unsupported', null);
    res.status(400).json({
      error: `Ledger can read PDFs and images. This one is a ${doc.mime_type || 'file of unknown type'}.`,
    });
    return;
  }
  if (!process.env.CLAUDE_API_KEY) {
    res.status(503).json({ error: 'Document reading is unavailable — CLAUDE_API_KEY is not configured.' });
    return;
  }

  const file = await supabase.storage.from(DOCUMENTS_BUCKET).download(doc.storage_path);
  if (file.error || !file.data) {
    res.status(500).json({ error: `Could not read the stored file: ${file.error?.message ?? 'empty'}` });
    return;
  }
  const base64 = Buffer.from(await file.data.arrayBuffer()).toString('base64');

  let raw: unknown;
  try {
    raw = await extractDocumentFacts(
      base64,
      doc.mime_type as 'application/pdf',
      doc.document_type,
      FACT_FIELDS[doc.document_type as keyof typeof FACT_FIELDS] as unknown as FactSpec[],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[documents] extraction failed:', message);
    await noteExtraction(doc.id, 'failed', message.slice(0, 300));
    res.status(502).json({ error: `Could not read that document: ${message}` });
    return;
  }

  // THE GATE. Everything the model proposed is checked against the field list
  // for this kind of document, against its own quote, and against what kind of
  // value the field holds. What survives is what the document says.
  const { facts, discarded } = sanitiseExtraction(doc.document_type, raw);
  if (discarded.length) console.warn('[documents] discarded proposals:', discarded);

  // A verdict a person has already given outranks a re-read. Confirmed and
  // rejected rows stand; only the readings nobody has looked at are replaced.
  const { data: existing, error: readError } = await supabase
    .from('document_facts').select('field, status').eq('document_id', doc.id);
  if (readError && isMissingTable(readError)) {
    res.status(500).json({ error: FACTS_MIGRATION_HINT });
    return;
  }
  const settled = new Set(
    (existing ?? [])
      .filter(f => (f as { status: string }).status !== 'unconfirmed')
      .map(f => (f as { field: string }).field),
  );

  const { error: deleteError } = await supabase
    .from('document_facts').delete().eq('document_id', doc.id).eq('status', 'unconfirmed');
  if (deleteError) {
    const message = isMissingTable(deleteError) ? FACTS_MIGRATION_HINT : deleteError.message;
    res.status(500).json({ error: message });
    return;
  }

  const rows = facts.filter(f => !settled.has(f.field)).map(f => ({
    id: randomUUID(),
    document_id: doc.id,
    user_id: scope.userId,
    field: f.field,
    value_kind: f.kind,
    value_text: f.valueText,
    value_number: f.valueNumber,
    value_date: f.valueDate,
    quote: f.quote,
    page: f.page,
    confidence: f.confidence,
    source: 'model',
    model: EXTRACTION_MODEL,
    status: 'unconfirmed',
    extracted_at: new Date().toISOString(),
  }));

  if (rows.length) {
    const { error: insertError } = await supabase.from('document_facts').insert(rows);
    if (insertError) {
      const message = isMissingTable(insertError) ? FACTS_MIGRATION_HINT : insertError.message;
      await noteExtraction(doc.id, 'failed', message.slice(0, 300));
      res.status(500).json({ error: message });
      return;
    }
  }

  // "Read it, and it said nothing I could use" is a real outcome, and a
  // different one from "not read yet". Both are recorded, neither is guessed.
  await noteExtraction(doc.id, facts.length ? 'read' : 'nothing-found', null);

  const { data: stored } = await supabase
    .from('document_facts').select('*').eq('document_id', doc.id)
    .order('created_at', { ascending: true });

  res.json({
    facts: stored ?? [],
    discarded,
    status: facts.length ? 'read' : 'nothing-found',
    kept: rows.length,
    settled: [...settled],
  });
});

// ── PATCH /api/documents/facts/:factId ───────────────────────────────────────
// The user's verdict on one reading: confirm it, reject it, or correct the
// value. OWNER-ONLY, told apart the same way extraction is: someone who can
// SEE the document is told plainly the verdict is not theirs to give, and
// someone who cannot is told nothing exists. A corrected value is stored as
// the user's, not the model's — the quote stays as the provenance of where
// the reading came from, and stops standing as support for a value the user
// typed.
router.patch('/facts/:factId', async (req: AuthRequest, res: Response) => {
  const { data: fact, error } = await supabase
    .from('document_facts').select('*').eq('id', req.params.factId).maybeSingle();
  if (error) {
    if (isMissingTable(error)) { res.status(500).json({ error: FACTS_MIGRATION_HINT }); return; }
    res.status(500).json({ error: error.message });
    return;
  }
  if (!fact) { res.status(404).json({ error: 'Not found' }); return; }

  const scope = await loadScope(req.user!.userId);
  if (fact.user_id !== scope.userId) {
    const { data: doc } = await supabase
      .from('documents').select('*').eq('id', fact.document_id).maybeSingle();
    const seen = doc ? canSeeDocument(doc, scope) : false;
    res.status(seen ? 403 : 404).json({
      error: seen
        ? 'Only the person this belongs to can confirm or correct a reading.'
        : 'Not found',
    });
    return;
  }

  const body = (req.body ?? {}) as { status?: unknown; value?: unknown };
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.value === 'string' && body.value.trim()) {
    const value = body.value.trim().slice(0, 200);
    const kind = fact.value_kind as 'money' | 'date' | 'rate' | 'text';
    const number = kind === 'money' ? parseMoney(value) : kind === 'rate' ? parseRate(value) : null;
    const date = kind === 'date' ? parseDateValue(value) : null;
    if ((kind === 'money' || kind === 'rate') && number == null) {
      res.status(400).json({ error: `"${value}" is not an amount.` });
      return;
    }
    if (kind === 'date' && !date) {
      res.status(400).json({ error: `"${value}" is not a date Ledger can read — try 2027-03-03.` });
      return;
    }
    update.value_text = kind === 'date' ? date : value;
    update.value_number = number;
    update.value_date = date;
    // The person whose paperwork this is has said what it says. That is the
    // most reliable source this table will ever hold.
    update.source = 'user';
    update.confidence = 1;
    update.status = 'confirmed';
    update.confirmed_at = new Date().toISOString();
  }

  if (body.status === 'confirmed' || body.status === 'rejected' || body.status === 'unconfirmed') {
    update.status = body.status;
    update.confirmed_at = body.status === 'unconfirmed' ? null : new Date().toISOString();
  }

  if (Object.keys(update).length === 1) {
    res.status(400).json({ error: 'Nothing to change — send a status or a value.' });
    return;
  }

  const { data, error: updateError } = await supabase
    .from('document_facts').update(update).eq('id', req.params.factId).select().single();
  if (updateError) { res.status(500).json({ error: updateError.message }); return; }
  res.json(data);
});

export default router;
