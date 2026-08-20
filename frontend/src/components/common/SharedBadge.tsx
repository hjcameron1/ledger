import { useStore } from '../../store';
import { householdsOf } from '../../utils/household';
import type { Shareable } from '../../types';

/**
 * The little "Shared" chip a list row wears when it sits in at least one
 * household — the at-a-glance half of the SharePanel that lives in the row's
 * detail. Hovering names the households (the ones this user is in; a household
 * they can't see into stays an anonymous count). Renders nothing for a personal
 * row, so screens can mount it unconditionally.
 */
export default function SharedBadge({ row }: { row: Shareable }) {
  const households = useStore(s => s.households);
  const ids = householdsOf(row);
  if (ids.length === 0) return null;

  const names = ids
    .map(id => households.find(h => h.id === id)?.name)
    .filter((n): n is string => !!n);
  const title = names.length > 0
    ? `Shared with ${names.join(', ')}`
    : 'Shared with a household';

  return (
    <span className="badge bg-brand/10 text-brand flex-shrink-0" title={title}>
      {ids.length === 1 ? 'Shared' : `Shared ×${ids.length}`}
    </span>
  );
}
