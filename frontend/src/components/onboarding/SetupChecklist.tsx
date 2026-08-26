/**
 * "Finish setting up" — the non-blocking checklist a new user sees on the
 * Overview after first-run onboarding. Each row deep-links into the REAL
 * screen for that area (the same routes the nav uses); done-ness is derived
 * from the data the user actually has, never from a parallel onboarding
 * record. Armed by `onboarding.guidance` like the page hints, dismissible
 * for good, and it retires itself once everything is done.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { loadOnboarding, patchOnboarding } from '../../services/onboarding';
import { documentsApi } from '../../services/api';

interface ChecklistItem {
  key: string;
  label: string;
  blurb: string;
  to: string;
  done: boolean;
}

/** One fetch per app session — documents are server-truth, not in the store. */
let docsCountCache: number | null = null;

export default function SetupChecklist() {
  const navigate = useNavigate();
  const { goals, investments, superFunds, properties, loans, insurancePolicies } = useStore();
  const [armed, setArmed] = useState(false);
  const [docsCount, setDocsCount] = useState<number | null>(docsCountCache);

  useEffect(() => {
    let cancelled = false;
    loadOnboarding().then(ob => {
      if (cancelled) return;
      setArmed(ob.guidance === true && ob.checklistDismissed !== true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!armed || docsCountCache !== null) return;
    let cancelled = false;
    documentsApi.getAll()
      .then(docs => { docsCountCache = docs.length; if (!cancelled) setDocsCount(docs.length); })
      .catch(() => { /* sleeping backend — row just shows without a tick */ });
    return () => { cancelled = true; };
  }, [armed]);

  const items: ChecklistItem[] = useMemo(() => [
    { key: 'goal', label: 'Set a savings goal', blurb: 'Something to aim at — Ledger tracks whether you\'re on pace.',
      to: '/?add=goal', done: goals.length > 0 },
    { key: 'investments', label: 'Add your investments', blurb: 'Shares, ETFs or crypto you hold.',
      to: '/investments?add=investment', done: investments.length > 0 },
    { key: 'super', label: 'Add your super', blurb: 'Your fund balance counts toward net worth.',
      to: '/investments?add=super', done: superFunds.length > 0 },
    { key: 'property', label: 'Property & loans', blurb: 'A home, mortgage or other debt.',
      to: '/investments?tab=Property', done: properties.length > 0 || loans.length > 0 },
    { key: 'insurance', label: 'Add insurance policies', blurb: 'Renewals and premium changes get watched for you.',
      to: '/insurance', done: insurancePolicies.length > 0 },
    { key: 'documents', label: 'Store a document', blurb: 'Statements and paperwork, kept in a private vault.',
      to: '/documents', done: (docsCount ?? 0) > 0 },
  ], [goals.length, investments.length, superFunds.length, properties.length, loans.length, insurancePolicies.length, docsCount]);

  const doneCount = items.filter(i => i.done).length;
  if (!armed || doneCount === items.length) return null;

  const hide = () => { setArmed(false); void patchOnboarding({ checklistDismissed: true }); };

  return (
    <div className="card p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold">Finish setting up</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            All optional — add areas as they become relevant. {doneCount} of {items.length} done.
          </p>
        </div>
        <button onClick={hide} className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 shrink-0">
          Hide
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-1.5">
        {items.map(item => (
          <button
            key={item.key}
            onClick={() => !item.done && navigate(item.to)}
            disabled={item.done}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-left transition-colors ${
              item.done
                ? 'opacity-60 cursor-default'
                : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
          >
            <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 border ${
              item.done
                ? 'bg-[#22c55e] border-[#22c55e]'
                : 'border-zinc-300 dark:border-zinc-700'
            }`}>
              {item.done && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              )}
            </span>
            <span className="min-w-0">
              <span className={`block text-sm font-medium ${item.done ? 'line-through' : ''}`}>{item.label}</span>
              {!item.done && (
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">{item.blurb}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
