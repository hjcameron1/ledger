// Theme resolution. Ledger supports three preferences:
//   'light'  — always light
//   'dark'   — always dark
//   'system' — follow the device (phone / laptop) appearance setting live
//
// Tailwind is configured with darkMode: 'class', so the only thing we ever do is
// add/remove the `dark` class on <html>. 'system' resolves to light/dark via the
// OS `prefers-color-scheme` media query and re-resolves whenever the OS flips
// (see the subscribeSystemTheme listener wired up in App.tsx).

export type Theme = 'light' | 'dark' | 'system';

const DARK_QUERY = '(prefers-color-scheme: dark)';

// True when the OS/browser is currently set to a dark appearance.
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;
}

// The concrete light/dark a preference resolves to right now.
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

// Apply a preference to the document: toggles the `dark` class and keeps the
// browser/iOS status-bar tint (<meta name="theme-color">) in sync so the phone
// chrome matches the app background.
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // Matches the body backgrounds in index.css (zinc-50 / zinc-950).
    meta.setAttribute('content', resolved === 'dark' ? '#09090b' : '#fafafa');
  }
}

// Subscribe to OS appearance changes. The callback fires only while it matters
// (the caller unsubscribes when the preference isn't 'system'). Returns an
// unsubscribe fn.
export function subscribeSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
