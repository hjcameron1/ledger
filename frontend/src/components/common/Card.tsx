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
      <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{label}</span>
      <div className="text-right">
        <span className="text-sm font-medium text-[#0f0f0f] dark:text-[#f5f5f5] amount">{value}</span>
        {sub && <div className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{sub}</div>}
      </div>
    </div>
  );
}
