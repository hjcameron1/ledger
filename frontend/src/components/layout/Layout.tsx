import React, { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import AppShell, { NavItem } from '../design-kit/AppShell';
import NotificationBell from './TopBar';
import QuickAdd from './QuickAdd';
import { basiqDS, currentScope, householdContext } from '../../services/dataService';
import { useStore } from '../../store';
import { navFor } from '../../utils/appearance';
import { activeHousehold } from '../../utils/household';

/**
 * The one always-visible answer to "whose money am I looking at?".
 *
 * A user in three households who has never picked one is silently shown their
 * FIRST household (the switcher's fallback) — which is correct behaviour, but
 * invisible: a specific household's money with no indication of which. This
 * pill names the RESOLVED household — the fallback included — on every page,
 * whenever the app is in household view. Tapping it goes to the switcher.
 */
function ScopePill() {
  const navigate = useNavigate();
  // Subscribed so the pill re-renders the moment the scope or membership moves.
  const financeScope = useStore(s => s.financeScope);
  const activeId = useStore(s => s.activeHouseholdId);
  const households = useStore(s => s.households);
  const members = useStore(s => s.householdMembers);

  const name = useMemo(() => {
    if (currentScope() !== 'household') return null;
    return activeHousehold(householdContext())?.name ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [financeScope, activeId, households, members]);

  if (!name) return null;
  return (
    <button
      onClick={() => navigate('/settings?section=households')}
      className="fixed top-3 right-14 sm:right-[3.75rem] z-40 h-9 px-3 flex items-center gap-1.5 rounded-full bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shadow-sm max-w-[45vw]"
      title="This page shows this household's shared money. Tap to switch views."
    >
      <span className="w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0" />
      <span className="truncate">Viewing {name}</span>
    </button>
  );
}

interface LayoutProps {
  children: React.ReactNode;
  showCustomise?: boolean;
  onCustomise?: () => void;
}

export default function Layout({ children }: LayoutProps) {
  // Layout wraps every authenticated page, so this is the one place that starts
  // the background hourly Basiq auto-sync for the whole app. It's idempotent and
  // silently no-ops when the user has no live bank connected.
  useEffect(() => {
    basiqDS.startAutoSync();
  }, []);

  // The nav is DERIVED from the one destination list (utils/appearance), so the
  // chosen view decides how many tabs there are without a second list to keep.
  const viewMode = useStore(s => s.viewMode);
  const navItems: NavItem[] = useMemo(
    () => navFor(viewMode).map(d => ({ to: d.to, label: d.label, end: d.end, icon: d.icon })),
    [viewMode],
  );

  return (
    <>
      <AppShell
        brandLead=""
        brandTail="Ledger"
        tagline="Personal finance"
        navItems={navItems}
        mode={viewMode}
      >
        {children}
      </AppShell>
      {/* Bell lives fixed in the top-right corner at all times; the scope pill
          sits beside it whenever a household view is active. */}
      <ScopePill />
      <NotificationBell />
      <QuickAdd />
    </>
  );
}
