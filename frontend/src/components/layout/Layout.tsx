import React from 'react';
import AppShell, { NavItem } from '../design-kit/AppShell';
import NotificationBell from './TopBar';
import QuickAdd from './QuickAdd';

interface LayoutProps {
  children: React.ReactNode;
  showCustomise?: boolean;
  onCustomise?: () => void;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true },
  { to: '/accounts', label: 'Accounts' },
  { to: '/investments', label: 'Investments' },
  { to: '/income', label: 'Income' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout({ children }: LayoutProps) {
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
