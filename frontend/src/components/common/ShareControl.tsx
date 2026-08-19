/**
 * The Personal / Shared control for a single row.
 *
 * One component for all seven shareable entities, because it is one operation:
 * set or clear `household_id` on a row that already exists. It never creates
 * anything, never copies anything, and cannot touch a balance — which is what
 * lets the label be as blunt as it is.
 *
 * It renders nothing at all when the user is in no household, and nothing when
 * the row isn't theirs: a control that only ever refuses is worse than no
 * control, and somebody else's account is not this user's decision to make.
 */
import { useState } from 'react';
import { useStore } from '../../store';
import { sharingDS, type ShareableKind } from '../../services/dataService';
import { buildContext, myHouseholds, activeHousehold } from '../../utils/household';

interface Props {
  kind: ShareableKind;
  id: string;
  /** Optional: what to call this thing in the confirmation copy ("account"). */
  noun?: string;
  onChange?: () => void;
}

export default function ShareControl({ kind, id, noun = 'this', onChange }: Props) {
  const { user, households, householdMembers, activeHouseholdId } = useStore();
  const [error, setError] = useState<string | null>(null);

  const ctx = buildContext(user?.id ?? null, households, householdMembers, activeHouseholdId);
  if (myHouseholds(ctx).length === 0) return null;

  const status = sharingDS.status(kind, id);
  if (!status || !status.mine) return null;

  const householdName = activeHousehold(ctx)?.name ?? 'the household';

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = status.shared ? sharingDS.unshare(kind, id) : sharingDS.share(kind, id);
    setError(result.ok ? null : result.error ?? 'Could not change that.');
    if (result.ok) onChange?.();
  };

  return (
    <button
      onClick={toggle}
      title={status.shared
        ? `Everyone in ${householdName} can see ${noun}. Making it personal hides it from them and changes nothing else.`
        : `Let everyone in ${householdName} see ${noun}. It stays yours — sharing shows it, it doesn't hand it over.`}
      className={`text-xs hover:underline ${status.shared
        ? 'text-brand'
        : 'text-zinc-500 dark:text-zinc-400 hover:text-brand'}`}
    >
      {error ?? (status.shared ? '● Shared' : 'Share')}
    </button>
  );
}
