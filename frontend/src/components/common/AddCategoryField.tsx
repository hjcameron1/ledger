import { useState } from 'react';
import Input from './Input';
import Button from './Button';
import { customCategoriesDS } from '../../services/dataService';
import {
  isRemembered, isSeparable, tidyCategoryName, type CategoryResolution,
} from '../../utils/categoryResolve';

/**
 * The one place a category is created by typing its name.
 *
 * Settings and the budget editor both add categories, and before this they each
 * called `customCategoriesDS.add()` with the raw string — which is how one
 * category ends up as "Groceries", "groceries" and "Grocuries". This component
 * runs the identity rules (`utils/categoryResolve`) and owns the decision they
 * refuse to make alone: whether a match is the same category or a new one.
 *
 * Nothing is folded into an existing category behind the user's back. Any match
 * — case, punctuation, a curated alias, or a fuzzy near-miss — is said out loud
 * and answered by them:
 *
 *     This category already exists as “Groceries”.
 *     [Use Groceries]  [Add anyway]
 *
 * The answer is remembered, so it is asked once per spelling. "Add anyway" is
 * remembered as a decision in its own right: reconciliation reads the same
 * alias map, so a category the user has defended is never quietly merged into
 * its lookalike later.
 */
export default function AddCategoryField({ onAdded, placeholder = 'Add a category, e.g. Eating out', label }: {
  /** Called with the name that ended up being used (existing or newly created). */
  onAdded?: (name: string) => void;
  placeholder?: string;
  label?: string;
}) {
  const [name, setName] = useState('');
  const [asking, setAsking] = useState<CategoryResolution | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const finish = (used: string) => {
    setName('');
    setAsking(null);
    onAdded?.(used);
  };

  const submit = () => {
    const typed = tidyCategoryName(name);
    if (!typed) return;
    setNote(null);

    const resolution = customCategoriesDS.resolve(typed);

    // Anything that matched something is put to the user — EXCEPT a decision
    // they have already made about this exact spelling, which stands.
    if (resolution.status !== 'new' && !isRemembered(resolution)) {
      setAsking(resolution);
      return;
    }

    const { name: used } = customCategoriesDS.addResolved(typed);
    if (used && used.toLowerCase() !== typed.toLowerCase()) {
      setNote(`Using “${used}”, as you chose earlier.`);
    }
    finish(used);
  };

  /** The user confirmed the typed name means an existing category. */
  const useExisting = (canonical: string) => {
    customCategoriesDS.rememberAlias(asking!.input, canonical);
    finish(canonical);
  };

  /** The user says it really is a different category. Create it, and stop asking. */
  const addAnyway = () => {
    const typed = tidyCategoryName(asking!.input);
    // Self-alias: "I checked — this is its own category." Read by `resolve` on
    // every later attempt and by `reconcile`, so neither will merge it.
    customCategoriesDS.rememberAlias(typed, typed);
    customCategoriesDS.add(typed);
    finish(typed);
  };

  const candidates = asking == null
    ? []
    : asking.status === 'ambiguous' ? asking.candidates.slice(0, 3)
      : asking.status === 'new' ? []
        : [asking.canonical];

  // A name that differs only in case or punctuation is not a second category —
  // every lookup in Ledger keys on that same identity, so two rows would share
  // one pool of transactions while pretending to be separate.
  const separable = asking != null && isSeparable(asking);

  return (
    <div className="mt-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label={label}
            value={name}
            onChange={e => { setName(e.target.value); setAsking(null); }}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder={placeholder}
          />
        </div>
        <Button variant="secondary" onClick={submit} disabled={!name.trim()}>Add</Button>
      </div>

      {asking && (
        <div className="mt-2 rounded-[10px] border border-brand/30 bg-brand/5 px-3 py-2.5">
          <p className="text-[12px] text-zinc-700 dark:text-zinc-200">
            {candidates.length === 1
              ? <>This category already exists as <span className="font-semibold">{candidates[0]}</span>.</>
              : <>“{asking.input}” is close to {candidates.join(', ')}. Which did you mean?</>}
          </p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {candidates.map(c => (
              <button
                key={c}
                onClick={() => useExisting(c)}
                className="text-[11px] px-2.5 py-1 rounded-full bg-brand text-white hover:opacity-90 transition-opacity"
              >
                Use {c}
              </button>
            ))}
            <button
              onClick={addAnyway}
              disabled={!separable}
              title={separable ? undefined : 'Same name, different spelling — it would be the same category.'}
              className="text-[11px] px-2.5 py-1 rounded-full border border-zinc-300 dark:border-zinc-700
                hover:border-brand/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                disabled:hover:border-zinc-300 dark:disabled:hover:border-zinc-700"
            >
              Add anyway
            </button>
          </div>
          {!separable && (
            <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              “{asking.input}” and “{candidates[0]}” differ only in case or punctuation, and Ledger
              matches categories the same way — they'd share every transaction. Pick a distinct name
              if it really is something else.
            </p>
          )}
        </div>
      )}

      {note && <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">{note}</p>}
    </div>
  );
}
