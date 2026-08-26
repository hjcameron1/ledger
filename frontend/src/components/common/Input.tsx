import React, { useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  prefix?: string;
  suffix?: string;
}

// Beyond ±Number.MAX_SAFE_INTEGER a float silently loses integer precision and
// corrupts every total it enters. No real figure is within orders of magnitude
// of this bound; native min/max validation blocks the fat-finger before it saves.
// A caller passing its own min/max (e.g. min="0") still wins for that side.
const NUMBER_BOUNDS = { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };

export default function Input({ label, error, hint, prefix, suffix, className = '', id, ...props }: InputProps) {
  // Programmatically associate the label with its control — a visually-adjacent
  // <label> with no htmlFor is invisible to screen readers and doesn't focus the
  // field on click.
  const autoId = useId();
  const inputId = id ?? (label ? autoId : undefined);
  if (props.type === 'number') {
    props = { ...NUMBER_BOUNDS, ...props };
  }
  return (
    <div className="w-full">
      {label && <label htmlFor={inputId} className="label">{label}</label>}
      <div className="relative flex items-center">
        {prefix && (
          <span className="absolute left-3 text-zinc-500 dark:text-zinc-400 text-sm select-none pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          className={`input ${prefix ? 'pl-7' : ''} ${suffix ? 'pr-10' : ''} ${error ? 'border-[#ef4444] focus:ring-[#ef4444]' : ''} ${className}`}
          {...props}
        />
        {suffix && (
          <span className="absolute right-3 text-zinc-500 dark:text-zinc-400 text-sm select-none pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-[#ef4444]">{error}</p>}
      {hint && !error && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

export function Select({ label, error, options, className = '', id, ...props }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? (label ? autoId : undefined);
  return (
    <div className="w-full">
      {label && <label htmlFor={selectId} className="label">{label}</label>}
      <select
        id={selectId}
        aria-invalid={error ? true : undefined}
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
          ${checked ? 'bg-brand' : 'bg-zinc-200 dark:bg-zinc-800'}`}
      >
        <span
          className={`${thumb} bg-white rounded-full shadow-sm transition-transform duration-200 ${translate}`}
        />
      </button>
      {label && <span className="text-sm text-zinc-900 dark:text-zinc-100">{label}</span>}
    </label>
  );
}
