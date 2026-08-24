import React, { useEffect } from 'react';
import AppShell, { NavItem } from '../design-kit/AppShell';
import NotificationBell from './TopBar';
import QuickAdd from './QuickAdd';
import { basiqDS } from '../../services/dataService';

interface LayoutProps {
  children: React.ReactNode;
  showCustomise?: boolean;
  onCustomise?: () => void;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/forecast', label: 'Forecast' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/investments', label: 'Investments' },
  { to: '/loans', label: 'Loans' },
  { to: '/income', label: 'Income' },
  { to: '/tax', label: 'Tax' },
  { to: '/documents', label: 'Documents' },
  { to: '/insurance', label: 'Insurance' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout({ children }: LayoutProps) {
  // Layout wraps every authenticated page, so this is the one place that starts
  // the background hourly Basiq auto-sync for the whole app. It's idempotent and
  // silently no-ops when the user has no live bank connected.
  useEffect(() => {
    basiqDS.startAutoSync();
  }, []);

  return (
    <>
      <AppShell
        brandLead=""
        brandTail="Ledger"
        tagline="Personal finance"
        navItems={NAV}
      >
        {children}
      </AppShell>
      {/* Bell lives fixed in the top-right corner at all times. */}
      <NotificationBell />
      <QuickAdd />
    </>
  );
}
