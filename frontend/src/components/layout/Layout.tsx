import React, { useEffect, useMemo } from 'react';
import AppShell, { NavItem } from '../design-kit/AppShell';
import NotificationBell from './TopBar';
import QuickAdd from './QuickAdd';
import { basiqDS } from '../../services/dataService';
import { useStore } from '../../store';
import { navFor } from '../../utils/appearance';

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
      {/* Bell lives fixed in the top-right corner at all times. */}
      <NotificationBell />
      <QuickAdd />
    </>
  );
}
