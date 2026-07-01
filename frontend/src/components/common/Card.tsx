import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  hover?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const paddingClasses = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export default function Card({ children, className = '', onClick, hover = false, padding = 'md' }: CardProps) {
  return (
    <div
      className={`card ${paddingClasses[padding]}
        ${hover ? 'cursor-pointer hover:shadow-card-hover dark:hover:shadow-[0_4px_12px_rgba(0,0,0,0.6)] transition-shadow duration-200' : ''}
        ${className}`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

interface StatRowProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}

export function StatRow({ label, value, sub }: StatRowProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="text-right">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 amount">{value}</span>
        {sub && <div className="text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
      </div>
    </div>
  );
}
