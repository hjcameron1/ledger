/**
 * Categories — the labels every transaction, budget and rule resolves into.
 *
 * Its own screen rather than a panel inside Settings: choosing the vocabulary
 * your spending is filed under is a job (add one, retire one, re-point what the
 * retired one was holding up), not a preference, and the delete flow here moves
 * real rows between categories. Lifted out of Settings unchanged — same
 * draft-then-Save rule, same "no transaction is ever deleted" guarantee.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { settingsApi } from '../../services/api';
import { customCategoriesDS } from '../../services/dataService';
import { useCategoryUniverse, useAllCategories, useCommittedCategories } from '../../utils/categories';
import { categoryKey, sameCategory } from '../../utils/categoryResolve';
import { isCanonicalCategory } from '../../utils/categoryTaxonomy';
import Card from '../common/Card';
import Button from '../common/Button';
import { Select } from '../common/Input';
import AddCategoryField from '../common/AddCategoryField';
import Modal from '../common/Modal';
import CategoryRules from './CategoryRules';

export default function CategoriesSection() {
  const user = useStore(s => s.user);
  const setSelectedCategories = useStore(s => s.setSelectedCategories);
  // ── Categories ────────────────────────────────────────────────────────────
  // The full menu of choosable categories (built-ins + anything the user made),
  // and what's currently active app-wide.
  const categoryUniverse = useCategoryUniverse();
  const activeCategories = useAllCategories();

  // Categories with a live budget can't be switched off — they stay pickable
  // everywhere for as long as the budget exists (see useAllCategories).
  const committed = useCommittedCategories();
  const committedKeys = useMemo(() => new Set(committed.map(categoryKey)), [committed]);

  // Only a category the USER created can be deleted; built-ins are the shared
  // vocabulary every import and rule resolves into (see categoryUsage).
  const customCategories = useStore(s => s.customCategories);
  const deletableKeys = useMemo(
    () => new Set(customCategories.filter(c => !isCanonicalCategory(c.name)).map(c => categoryKey(c.name))),
    [customCategories],
  );

  // Deletion is confirmed against what the category is actually holding up.
  const [deletingCat, setDeletingCat] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState('');
  const [deleteCatError, setDeleteCatError] = useState<string | null>(null);
  const deletingUsage = useMemo(
    () => (deletingCat ? customCategoriesDS.usage(deletingCat) : null),
    [deletingCat],
  );

  // Working draft of the selection — nothing is committed until "Save" is pressed.
  const [catDraft, setCatDraft] = useState<string[] | null>(null);
  const [catSaved, setCatSaved] = useState(false);

  const confirmDeleteCategory = () => {
    if (!deletingCat) return;
    const result = customCategoriesDS.deleteCategory(deletingCat, { reassignTo: reassignTo || null });
    if (!result.ok) { setDeleteCatError(result.reason); return; }
    setCatDraft(prev => {
      const kept = (prev ?? []).filter(c => !sameCategory(c, deletingCat));
      return reassignTo && !kept.some(c => sameCategory(c, reassignTo)) ? [...kept, reassignTo] : kept;
    });
    setDeletingCat(null);
    setReassignTo('');
    setDeleteCatError(null);
  };

  // Seed the draft from whatever is currently active, once the data is loaded.
  useEffect(() => {
    if (catDraft === null && categoryUniverse.length > 0) setCatDraft(activeCategories);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryUniverse.length]);

  const catInDraft = (name: string) =>
    (catDraft ?? []).some(c => c.toLowerCase() === name.toLowerCase());

  const toggleCat = (name: string) => {
    setCatDraft(prev => {
      const arr = prev ?? [];
      return arr.some(c => c.toLowerCase() === name.toLowerCase())
        ? arr.filter(c => c.toLowerCase() !== name.toLowerCase())
        : [...arr, name];
    });
  };

  // Full ui_preferences blob, kept so we merge (never clobber) other prefs.
  const uiPrefsRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    settingsApi.getProfile()
      .then((p: { ui_preferences?: Record<string, unknown> }) => {
        const prefs = p?.ui_preferences ?? {};
        uiPrefsRef.current = prefs;
        // Server is authoritative for the saved selection on load.
        if (Array.isArray(prefs.selected_categories)) {
          setSelectedCategories((prefs.selected_categories as unknown[]).map(String));
        }
      })
      .catch(() => { /* best-effort; local persisted copy still applies */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dirty = the draft differs from what's active right now.
  const catDirty = catDraft !== null && (
    catDraft.length !== activeCategories.length ||
    [...catDraft].map(c => c.toLowerCase()).sort().join('|') !==
      [...activeCategories].map(c => c.toLowerCase()).sort().join('|')
  );

  const saveCategories = () => {
    const chosen = catDraft ?? [];
    setSelectedCategories(chosen);
    const merged = { ...uiPrefsRef.current, selected_categories: chosen };
    uiPrefsRef.current = merged;
    settingsApi.updateProfile({ ui_preferences: merged }).catch(() => { /* local copy persists */ });
    setCatSaved(true);
    setTimeout(() => setCatSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
    <Card>
      <h2 className="font-semibold mb-1">Categories</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
        Tap the categories you want. Only the highlighted ones show up when you categorise a
        transaction or build a budget. Add your own below, then press Save.
      </p>

      {/* Add a category — shared with the budget editor, so both apply
          the same identity rules and ask the same "did you mean?". */}
      <div className="max-w-md mb-5">
        <AddCategoryField
          label="Add a category"
          placeholder="e.g. Eating out, Pets, Coffee"
          onAdded={name => setCatDraft(prev => {
            const arr = prev ?? [];
            return arr.some(c => sameCategory(c, name)) ? arr : [...arr, name];
          })}
        />
      </div>

      {/* The one menu: tap to select / deselect */}
      <div className="flex flex-wrap gap-2">
        {categoryUniverse.map(c => {
          const locked = committedKeys.has(categoryKey(c));
          const on = locked || catInDraft(c);
          const deletable = deletableKeys.has(categoryKey(c));
          return (
            <span
              key={c}
              className={`inline-flex items-center rounded-full border transition-colors
                ${on
                  ? 'bg-brand/10 border-brand/40'
                  : 'bg-transparent border-zinc-200 dark:border-zinc-800'}`}
            >
              <button
                onClick={() => !locked && toggleCat(c)}
                aria-pressed={on}
                disabled={locked}
                title={locked ? 'Always available — this category has a budget' : undefined}
                className={`inline-flex items-center gap-1.5 pl-3 py-1.5 rounded-full text-sm
                  ${deletable ? 'pr-1.5' : 'pr-3'}
                  ${on ? 'text-brand font-medium' : 'text-zinc-500 dark:text-zinc-400'}
                  ${locked ? 'cursor-default' : ''}`}
              >
                <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] ${
                  on ? 'bg-brand text-white' : 'border border-zinc-300 dark:border-zinc-700'
                }`}>{on ? '✓' : ''}</span>
                {c}
                {locked && <span className="text-[9px] opacity-70" aria-hidden="true">🔒</span>}
              </button>
              {deletable && (
                <button
                  onClick={() => { setDeletingCat(c); setReassignTo(''); setDeleteCatError(null); }}
                  aria-label={`Delete ${c}`}
                  title={`Delete ${c}`}
                  className="pl-1 pr-2.5 py-1.5 text-[13px] leading-none rounded-r-full
                    text-zinc-400 hover:text-[#ef4444] transition-colors"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      {committedKeys.size > 0 && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-2">
          🔒 Categories with a budget are always available everywhere — remove the budget to
          free them up.
        </p>
      )}
      {deletableKeys.size > 0 && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
          × deletes a category you created. Built-in categories can only be switched off.
        </p>
      )}

      {/* Save */}
      <div className="flex items-center gap-3 mt-6">
        <Button variant="primary" onClick={saveCategories} disabled={!catDirty && !catSaved}>
          {catSaved ? '✓ Saved' : 'Save'}
        </Button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {(catDraft ?? []).length} selected
          {catDirty && <span className="text-[#f59e0b]"> · unsaved changes</span>}
        </span>
      </div>

      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-4">
        Un-selecting a category doesn't change transactions already filed under it — it just
        stops it appearing when you pick a category.
      </p>
    </Card>

    <CategoryRules currency={user?.currency_preference ?? 'AUD'} />

    {/* Deleting a category means dealing with everything pointing at it —
        so the confirmation shows exactly that, and nothing but the
        category row itself is ever destroyed. */}
    <Modal
      isOpen={!!deletingCat}
      onClose={() => { setDeletingCat(null); setDeleteCatError(null); }}
      title={`Delete “${deletingCat ?? ''}”?`}
      size="md"
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={() => { setDeletingCat(null); setDeleteCatError(null); }}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirmDeleteCategory}>
            {reassignTo ? `Delete and move to ${reassignTo}` : 'Delete category'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            “{deletingCat}” is currently used by:
          </p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'Budgets', n: deletingUsage?.budgets ?? 0 },
              { label: 'Rules', n: deletingUsage?.rules ?? 0 },
              { label: 'Transactions', n: (deletingUsage?.transactions ?? 0) + (deletingUsage?.splits ?? 0) },
            ].map(u => (
              <div
                key={u.label}
                className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2 text-center"
              >
                <div className="text-lg font-semibold tabular-nums">{u.n}</div>
                <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{u.label}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1.5">
            Transaction counts cover the transactions loaded on this device.
          </p>
        </div>

        <div>
          <Select
            label="Move its transactions to"
            value={reassignTo}
            onChange={e => setReassignTo(e.target.value)}
            options={[
              { value: '', label: 'Leave them uncategorised' },
              ...categoryUniverse
                .filter(c => !sameCategory(c, deletingCat ?? ''))
                .map(c => ({ value: c, label: c })),
            ]}
          />
        </div>

        <ul className="text-[11px] text-zinc-500 dark:text-zinc-400 space-y-1 list-disc pl-4">
          <li>
            {reassignTo
              ? <>Transactions and split lines move to <strong>{reassignTo}</strong>.</>
              : <>Transactions and split lines stay exactly as they are and become <strong>Uncategorised</strong>.</>}
          </li>
          <li>
            {reassignTo
              ? <>Budgets and rules on it are re-pointed at {reassignTo}.</>
              : <>Budgets on it are switched off, and rules stop filing new transactions under it. Nothing is deleted.</>}
          </li>
          <li>No transaction is ever deleted.</li>
        </ul>

        {deleteCatError && (
          <p className="text-xs text-[#ef4444]">{deleteCatError}</p>
        )}
      </div>
    </Modal>
    </div>
  );
}
