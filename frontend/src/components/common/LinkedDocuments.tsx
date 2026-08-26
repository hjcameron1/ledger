/**
 * The paperwork filed against ONE record — the other end of the vault's link.
 *
 * A document already names what it belongs to (`linked_type` + `linked_id`),
 * which until now could only be read from the Documents page: you could file a
 * statement against an account and then never see it from the account. This
 * reads the SAME single link from the other side, so the relationship is
 * two-way without anything being stored twice or kept in step.
 *
 * Permissions need no thought here. The list this filters is what the server
 * was willing to send this user (routes/documents.ts decides that, once), so a
 * document nobody shared with them is not in it to be found — and the bytes
 * still only ever move through the authenticated endpoint, so no URL to a
 * document exists outside this tab.
 *
 * Insurance policies point AT their document rather than being pointed at, so
 * `documentIds` is the other way in.
 */
import { useCallback, useEffect, useState } from 'react';
import { documentsDS } from '../../services/dataService';
import { documentsApi } from '../../services/api';
import { formatDate } from '../../utils/format';
import { formatBytes, kindLabel, canPreview } from '../../utils/documents';
import type { LedgerDocument, DocumentLinkType } from '../../types';

interface Props {
  /** What the documents are filed against. */
  linkedType?: DocumentLinkType;
  linkedId?: string | null;
  /** …or the documents this record points at, by id (insurance). */
  documentIds?: (string | null | undefined)[];
  title?: string;
  /** What to say when nothing is filed here. Given, the section says it; left
   *  out, the section is simply absent — which is right in a LIST of records,
   *  where a line of "no documents" on every card is noise, and wrong in a
   *  record's own detail, where silence would read as "not loaded". */
  emptyText?: string;
  className?: string;
}

export default function LinkedDocuments({
  linkedType, linkedId, documentIds, title = 'Documents', emptyText, className = '',
}: Props) {
  const [docs, setDocs] = useState<LedgerDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(() => {
    setDocs(documentIds
      ? documentsDS.byIds(documentIds)
      : linkedType ? documentsDS.forRecord(linkedType, linkedId) : []);
  }, [linkedType, linkedId, documentIds?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    void documentsDS.ensure().then(() => {
      if (!alive) return;
      resolve();
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [resolve]);

  /** The bytes, as a blob — an object URL that lives in this tab and nowhere
   *  else. Opening is best-effort: a blocked popup becomes a download rather
   *  than nothing happening. */
  const withFile = async (doc: LedgerDocument, use: (url: string) => boolean) => {
    setBusy(doc.id);
    setError(null);
    try {
      const blob = await documentsApi.getFileBlob(doc.id);
      const url = URL.createObjectURL(blob);
      const ok = use(url);
      if (!ok) {
        const a = document.createElement('a');
        a.href = url;
        a.download = doc.original_filename || doc.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      // Give the browser a beat before revoking, or some cancel the open.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError(`Could not open ${doc.name}.`);
    } finally {
      setBusy(null);
    }
  };

  const open = (doc: LedgerDocument) => withFile(doc, url => !!window.open(url, '_blank'));
  const download = (doc: LedgerDocument) => withFile(doc, () => false);

  // Nothing filed here yet — said out loud only once the vault has actually
  // been looked at, because "none" and "not loaded" are different answers.
  if (!loaded) return null;
  if (!docs.length) {
    return emptyText
      ? <div className={`text-xs text-zinc-500 dark:text-zinc-400 ${className}`}>{emptyText}</div>
      : null;
  }

  return (
    <div className={`rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 ${className}`}>
      <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 mb-2">
        {title} <span className="font-normal text-zinc-500 dark:text-zinc-400">({docs.length})</span>
      </p>
      <div className="space-y-1.5">
        {docs.map(doc => (
          <div key={doc.id} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{doc.name}</p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                {[
                  kindLabel(doc.document_type),
                  doc.document_date ? formatDate(doc.document_date) : null,
                  formatBytes(doc.size_bytes),
                ].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {canPreview(doc.mime_type) && (
                <button
                  type="button"
                  disabled={busy === doc.id}
                  onClick={() => void open(doc)}
                  className="text-[11px] text-brand hover:underline disabled:opacity-50"
                >
                  Open
                </button>
              )}
              <button
                type="button"
                disabled={busy === doc.id}
                onClick={() => void download(doc)}
                className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-brand hover:underline disabled:opacity-50"
              >
                Download
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}
