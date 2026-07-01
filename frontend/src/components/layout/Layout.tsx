import React from 'react';
import AppShell, { NavItem } from '../design-kit/AppShell';
import TopBarActions from './TopBar';
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

export default function Layout({ children, onCustomise }: LayoutProps) {
  return (
    <>
      <AppShell
        brandLead=""
        brandTail="Ledger"
        tagline="Personal finance"
        navItems={NAV}
        topBar={<TopBarActions onCustomise={onCustomise} />}
      >
        {children}
      </AppShell>
      <QuickAdd />
    </>
  );
}
