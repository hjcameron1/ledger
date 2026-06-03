import React from 'react';
import TopBar from './TopBar';
import Sidebar from './Sidebar';
import BottomTabBar from './BottomTabBar';
import QuickAdd from './QuickAdd';

interface LayoutProps {
  children: React.ReactNode;
  showCustomise?: boolean;
  onCustomise?: () => void;
}

export default function Layout({ children, onCustomise }: LayoutProps) {
  return (
    <div className="min-h-screen bg-white dark:bg-[#0f0f0f] text-[#0f0f0f] dark:text-[#f5f5f5]">
      <TopBar onCustomise={onCustomise} />
      <Sidebar />
      <main className="lg:ml-[240px] pb-20 lg:pb-6 min-h-[calc(100vh-56px)]">
        <div className="max-w-[1280px] mx-auto px-4 py-6">
          {children}
        </div>
      </main>
      <BottomTabBar />
      <QuickAdd />
    </div>
  );
}
