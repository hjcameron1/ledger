/**
 * The Personal / Household switch.
 *
 * Two views over the SAME rows — nothing here recomputes anything, it only
 * changes which slice every screen reads:
 *
 *   Personal   the rows you own. Your whole financial life, shared or not,
 *              because a joint account is still your money.
 *   Household  the rows shared with the household, from every member, each
 *              counted once. Nobody's private accounts, not even your own.
 *
 * It renders only for somebody actually in a household. For everyone else there
 * is nothing to switch between, and a disabled control explaining a feature they
 * haven't asked for is just clutter in the corner of every screen.
 */
import { useStore } from '../../store';
import { buildContext, myHouseholds, activeHousehold } from '../../utils/household';

export default function ScopeSwitch() {
  const {
    user, households, householdMembers, activeHouseholdId,
    financeScope, setFinanceScope,
  } = useStore();

  const ctx = buildContext(user?.id ?? null, households, householdMembers, activeHouseholdId);
  const mine = myHouseholds(ctx);
  if (mine.length === 0) return null;

  const current = activeHousehold(ctx);
  const options: { value: 'personal' | 'household'; label: string }[] = [
    { value: 'personal', label: 'Personal' },
    { value: 'household', label: current?.name ?? 'Household' },
  ];

  return (
    <div
      className="fixed top-3 right-14 sm:right-16 z-40 flex items-center gap-0.5 p-0.5 rounded-full
        bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 shadow-sm"
      role="group"
      aria-label="Which money to show"
    >
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => setFinanceScope(o.value)}
          aria-pressed={financeScope === o.value}
          title={o.value === 'personal'
            ? 'Everything you own, shared or not'
            : 'Only what the household shares — private accounts stay private'}
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
