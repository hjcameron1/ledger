import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

// ─────────────────────────────────────────────────────────────────────────────
// AppShell — the family layout frame (copied from ~/design-kit and extended with
// an optional `topBar` slot so Ledger can host its bell / Quick Add / avatar).
//   • desktop: a left sidebar with the logo, nav, and a footer slot; a slim sticky
//              top bar over the content for page-level actions
//   • mobile:  a sticky bar with the brand + the same actions, plus a FIXED,
//              horizontally scrollable bottom nav strip that stays visible
// This is what makes Ledger, PAssistant, and future apps feel like one product.
// ─────────────────────────────────────────────────────────────────────────────

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

export interface AppShellProps {
  /** App name split into two halves so the second half is brand-coloured,
   *  e.g. brandLead="P", brandTail="Assistant" → P**Assistant**.
   *  For an all-brand wordmark, put it all in brandTail and leave brandLead "". */
  brandLead: string;
  brandTail?: string;
  /** Small strapline under the logo, e.g. "Personal finance". */
  tagline?: string;
  navItems: NavItem[];
  /** Optional content pinned to the bottom of the desktop sidebar (user card, logout). */
  sidebarFooter?: ReactNode;
  /** Optional tab row rendered above the page content (e.g. sub-modules of a group). */
  contentTabs?: ReactNode;
  children: ReactNode;
}

function Logo({ lead, tail, size }: { lead: string; tail?: string; size: 'sidebar' | 'mobile' }) {
  return (
    <div className={size === 'sidebar' ? 'text-xl font-bold tracking-tight' : 'text-lg font-bold tracking-tight leading-none'}>
      {lead}
      {tail ? <span className="text-brand">{tail}</span> : null}
    </div>
  );
}

function sidebarNavClass(isActive: boolean) {
  return `flex items-center px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
    isActive ? 'bg-brand/10 text-brand' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
  }`;
}

// Mobile bottom nav: a horizontally scrollable strip so every tab is reachable
// regardless of how many there are. The scrollbar is hidden for looks, so we add
// edge fade-gradients that appear only when there's more to scroll in that
// direction — the affordance that tells the user "swipe for more tabs".
function BottomNav({ navItems }: { navItems: NavItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const { pathname } = useLocation();

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= maxScroll - 1);
  }, []);

  // Recompute on mount, and whenever the tab set or viewport width changes.
  useLayoutEffect(updateFades, [updateFades, navItems.length]);
  useEffect(() => {
    window.addEventListener('resize', updateFades);
    return () => window.removeEventListener('resize', updateFades);
  }, [updateFades]);

  // Center the active tab when the route changes (e.g. tapping Settings on a
  // narrow screen scrolls it into view). Keyed to pathname so it does NOT fight
  // the user's own horizontal scrolling.
  useEffect(() => {
    scrollRef.current?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
    // Fades settle after the scroll animation.
    const t = setTimeout(updateFades, 350);
    return () => clearTimeout(t);
  }, [pathname, updateFades]);

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 pb-safe">
      <div className="relative">
        <div ref={scrollRef} onScroll={updateFades} className="overflow-x-auto no-scrollbar scroll-smooth">
          <div className="flex items-stretch px-2">
            {navItems.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `shrink-0 text-center px-4 py-3.5 text-sm font-semibold whitespace-nowrap transition-colors ${
                    isActive
                      ? 'text-brand border-b-2 border-brand'
                      : 'text-zinc-500 dark:text-zinc-400 border-b-2 border-transparent'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </div>
        </div>
        {/* Edge fades — shown only when more tabs lie off that edge. */}
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white dark:from-zinc-900 to-transparent transition-opacity duration-200 ${atStart ? 'opacity-0' : 'opacity-100'}`}
        />
        <div
          className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-white dark:from-zinc-900 to-transparent transition-opacity duration-200 ${atEnd ? 'opacity-0' : 'opacity-100'}`}
        />
      </div>
    </nav>
  );
}

export default function AppShell({
  brandLead, brandTail = '', tagline, navItems, sidebarFooter, contentTabs, children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex">
      {/* Sidebar — hidden on small screens (bottom bar takes over) */}
      <aside className="hidden md:flex w-56 shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-col">
        <div className="px-5 py-5">
          <Logo lead={brandLead} tail={brandTail} size="sidebar" />
          {tagline && <div className="text-xs text-zinc-400 mt-0.5">{tagline}</div>}
        </div>
        <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto">
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => sidebarNavClass(isActive)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {sidebarFooter && (
          <div className="p-3 border-t border-zinc-200 dark:border-zinc-800">{sidebarFooter}</div>
        )}
      </aside>

      <main className="flex-1 overflow-y-auto pb-24 md:pb-0">
        {/* Mobile-only brand bar — NOT sticky, scrolls away with content (the logo
            lives in the sidebar on desktop). No action cluster here any more. */}
        <div className="md:hidden border-b border-zinc-200 dark:border-zinc-800 px-4 py-2.5">
          <Logo lead={brandLead} tail={brandTail} size="mobile" />
          {tagline && <div className="text-[11px] text-zinc-400 mt-0.5">{tagline}</div>}
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {contentTabs}
          {children}
        </div>
      </main>

      {/* Bottom nav — mobile only. Horizontally scrollable so every tab is
          reachable, with edge fades hinting there's more to swipe. */}
      <BottomNav navItems={navItems} />
    </div>
  );
}
