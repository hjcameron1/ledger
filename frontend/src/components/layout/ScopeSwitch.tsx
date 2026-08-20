/**
 * The My Finances / household switch.
 *
 * Views over the SAME rows — nothing here recomputes anything, it only changes
 * which slice every screen reads:
 *
 *   My Finances  the rows you own. Your whole financial life, shared or not,
 *                because a joint account is still your money. Accounts other
 *                people have shared with you appear here too, badged and kept
 *                out of every total: they are theirs.
 *   A household  the rows shared with THAT household, from every member, each
 *                counted once. Nobody's private accounts, not even your own.
 *
 * A user may be in several — a couple, a family, an investment group — and each
 * is its own view with its own totals, so they are listed separately rather than
 * merged into one "household" that would mean nothing.
 *
 * It renders only for somebody actually in a household. For everyone else there
 * is nothing to switch between: a lone direct grant adds rows to My Finances, it
 * does not create a second view, and a disabled control explaining a feature
 * nobody asked for is just clutter in the corner of every screen.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { buildContext, myHouseholds, activeHousehold } from '../../utils/household';

export default function ScopeSwitch() {
  const {
    user, households, householdMembers, activeHouseholdId,
    financeScope, setFinanceScope, setActiveHouseholdId,
  } = useStore();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const ctx = buildContext(user?.id ?? null, households, householdMembers, activeHouseholdId);
  const mine = myHouseholds(ctx);
  if (mine.length === 0) return null;

  const current = activeHousehold(ctx);
  const showing = financeScope === 'household' ? current?.name ?? 'Household' : 'My Finances';

  const pick = (householdId: string | null) => {
    if (householdId === null) { setFinanceScope('personal'); }
    else { setActiveHouseholdId(householdId); setFinanceScope('household'); }
    setOpen(false);
  };

  const shell = 'fixed top-3 right-14 sm:right-16 z-40 flex items-center gap-0.5 p-0.5 rounded-full '
    + 'bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 shadow-sm';

  // One household is the common case, and two taps to switch between two things
  // would be one tap too many. Several households need a list, because pills
  // across the top of every screen would not fit and could not be read.
  if (mine.length === 1) {
    const options: { value: 'personal' | 'household'; label: string; title: string }[] = [
      { value: 'personal', label: 'My Finances', title: 'Everything you own, shared or not' },
      {
        value: 'household',
        label: current?.name ?? 'Household',
        title: 'Only what this household shares — private accounts stay private',
      },
    ];
    return (
      <div className={shell} role="group" aria-label="Which money to show">
        {options.map(o => (
          <button
            key={o.value}
            onClick={() => pick(o.value === 'personal' ? null : current?.id ?? null)}
            aria-pressed={financeScope === o.value}
            title={o.title}
            className={`px-3 h-8 rounded-full text-xs font-medium transition-colors max-w-[140px] truncate
              ${financeScope === o.value
                ? 'bg-brand text-white'
                : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div ref={box} className={shell}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Which money to show"
        className="px-3 h-8 rounded-full text-xs font-medium bg-brand text-white flex items-center gap-1.5 max-w-[180px]"
      >
        <span className="truncate">{showing}</span>
        <span aria-hidden className="opacity-70">▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-10 right-0 w-56 py-1 rounded-xl bg-white dark:bg-zinc-900
            border border-zinc-200 dark:border-zinc-800 shadow-lg"
        >
          <Option
            label="My Finances"
            hint="Everything you own"
            selected={financeScope === 'personal'}
            onClick={() => pick(null)}
          />
          <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
          {mine.map(h => (
            <Option
              key={h.id}
              label={h.name}
              hint="What this household shares"
              selected={financeScope === 'household' && current?.id === h.id}
              onClick={() => pick(h.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Option({ label, hint, selected, onClick }: {
  label: string; hint: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800
        ${selected ? 'text-brand font-medium' : 'text-zinc-700 dark:text-zinc-200'}`}
    >
      <span className="block truncate">{label}</span>
      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{hint}</span>
    </button>
  );
}
