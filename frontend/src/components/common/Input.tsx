import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  prefix?: string;
  suffix?: string;
}

export default function Input({ label, error, hint, prefix, suffix, className = '', ...props }: InputProps) {
  return (
    <div className="w-full">
      {label && <label className="label">{label}</label>}
      <div className="relative flex items-center">
        {prefix && (
          <span className="absolute left-3 text-[#6b6b6b] dark:text-[#a0a0a0] text-sm select-none pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          className={`input ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-10' : ''} ${error ? 'border-[#ef4444] focus:ring-[#ef4444]' : ''} ${className}`}
          {...props}
        />
        {suffix && (
          <span className="absolute right-3 text-[#6b6b6b] dark:text-[#a0a0a0] text-sm select-none pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-[#ef4444]">{error}</p>}
      {hint && !error && <p className="mt-1 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{hint}</p>}
    </div>
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, error, options, className = '', ...props }: SelectProps) {
  return (
    <div className="w-full">
      {label && <label className="label">{label}</label>}
      <select
        className={`input appearance-none cursor-pointer ${error ? 'border-[#ef4444]' : ''} ${className}`}
        {...props}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-[#ef4444]">{error}</p>}
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  size?: 'sm' | 'md';
}

export function Toggle({ checked, onChange, label, size = 'md' }: ToggleProps) {
  const track = size === 'sm' ? 'w-8 h-4' : 'w-10 h-5';
  const thumb = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4';
  const translate = checked ? (size === 'sm' ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0.5';

  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex items-center ${track} rounded-full transition-colors duration-200
          ${checked ? 'bg-[#3b7dd8]' : 'bg-[#e5e5e5] dark:bg-[#2a2a2a]'}`}
      >
        <span
          className={`${thumb} bg-white rounded-full shadow-sm transition-transform duration-200 ${translate}`}
        />
      </button>
      {label && <span className="text-sm text-[#0f0f0f] dark:text-[#f5f5f5]">{label}</span>}
    </label>
  );
}
