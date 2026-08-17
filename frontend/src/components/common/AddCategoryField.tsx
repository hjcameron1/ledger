import { useState } from 'react';
import Input from './Input';
import Button from './Button';
import { customCategoriesDS } from '../../services/dataService';
import { tidyCategoryName, type CategoryResolution } from '../../utils/categoryResolve';

/**
 * The one place a category is created by typing its name.
 *
 * Settings and the budget editor both add categories, and before this they each
 * called `customCategoriesDS.add()` with the raw string — which is how one
 * category ends up as "Groceries", "groceries" and "Grocuries". This component
 * runs the identity rules (`utils/categoryResolve`) and, crucially, owns the
 * ONE case those rules refuse to decide alone: a close-but-not-certain match.
 *
 * Deterministic answers are silent — retyping "groceries" simply selects
 * Groceries, because that is not a guess. A near miss asks:
 *
 *     Did you mean Groceries?   [Groceries]  [Keep "Grocuries"]
 *
 * Either answer is remembered, so the user is asked once per spelling and a
 * genuinely different category they defend is never questioned again.
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
    if (resolution.status === 'suggestion' || resolution.status === 'ambiguous') {
      setAsking(resolution);
      return;
    }

    const { name: used } = customCategoriesDS.addResolved(typed);
    // Say so when the name changed under them — silently filing "groceries"
    // under "Groceries" is right, but it should not be a surprise.
    if (used && used.toLowerCase() !== typed.toLowerCase()) setNote(`Using the existing “${used}”.`);
    finish(used);
  };

  /** The user confirmed the typed name means an existing category. */
  const useExisting = (canonical: string) => {
    customCategoriesDS.rememberAlias(asking!.input, canonical);
    finish(canonical);
  };

  /** The user says it really is a different category. Create it, and stop asking. */
  const keepAsNew = () => {
    const typed = tidyCategoryName(asking!.input);
    customCategoriesDS.rememberAlias(typed, typed);
    customCategoriesDS.add(typed);
    finish(typed);
  };

  const candidates = asking == null
    ? []
    : asking.status === 'ambiguous' ? asking.candidates.slice(0, 3)
      : asking.status === 'suggestion' ? [asking.canonical]
        : [];

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
              ? <>Did you mean <span className="font-semibold">{candidates[0]}</span>?</>
              : <>“{asking.input}” looks close to {candidates.join(', ')}. Which did you mean?</>}
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
              onClick={keepAsNew}
              className="text-[11px] px-2.5 py-1 rounded-full border border-zinc-300 dark:border-zinc-700 hover:border-brand/50 transition-colors"
            >
              Keep “{asking.input}”
            </button>
          </div>
        </div>
      )}

      {note && <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">{note}</p>}
    </div>
  );
}
