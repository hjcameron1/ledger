import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import NavIcon from '../layout/NavIcon';
import type { IconName, ViewMode } from '../../utils/appearance';

// ─────────────────────────────────────────────────────────────────────────────
// AppShell — the family layout frame (copied from ~/design-kit and extended with
// an optional `topBar` slot so Ledger can host its bell / Quick Add / avatar).
//   • desktop: a left sidebar with the logo, nav, and a footer slot
//   • mobile:  a brand bar, plus a FIXED bottom nav that stays visible
//
// The bottom nav has TWO shapes, chosen by `mode` (see utils/appearance):
//   technical — a horizontally scrollable strip carrying every page, squared off,
//               with mono labels. Made to get anywhere in one tap.
//   peaceful  — four tabs on a floating, rounded bar. Made to be looked at.
// Both are icon-first: a label alone is a wall of same-sized words, which is
// exactly what made the old strip hard to aim at.
// ─────────────────────────────────────────────────────────────────────────────

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  icon?: IconName;
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
  /** Which of the two bottom-nav shapes to render. Default 'technical'. */
  mode?: ViewMode;
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

// ─── Desktop / tablet sidebar geometry ───────────────────────────────────────
//
// The sidebar STICKS to the top of the viewport from the `md` breakpoint up, so
// the nav stays reachable on a long page instead of scrolling away with the
// content. Every part of that is deliberate, and all of it is `md:`-prefixed —
// below `md` the aside is `display:none` and the fixed bottom strip is the nav,
// so the phone layout is untouched.
//
//   md:sticky md:top-0   pin to the viewport once the page scrolls past it.
//                        Sticky (not fixed) keeps the aside in flow, so the
//                        content column is still laid out beside it and can
//                        never slide underneath.
//   md:h-screen          give it exactly the viewport to work with, which is
//                        what makes the internal scroll below meaningful.
//   md:z-20              above page content, below modals/overlays.
//
// Exported so the responsive contract can be asserted in a test — this repo has
// no DOM harness, and a dropped `md:` would silently restore the old behaviour.
export const SIDEBAR_CLASS =
  'hidden md:flex md:sticky md:top-0 md:h-screen md:z-20 w-56 shrink-0 '
  + 'border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex-col';

// `min-h-0` is load-bearing: a flex child defaults to min-height:auto, which
// refuses to shrink below its content, and `overflow-y-auto` on an element that
// never shrinks never scrolls. Without it, a nav taller than a short laptop
// window would overflow the pinned sidebar and its last items would be
// unreachable — the exact failure the sticky sidebar could otherwise introduce.
export const SIDEBAR_NAV_CLASS = 'flex-1 min-h-0 overflow-y-auto px-2 space-y-0.5';

function sidebarNavClass(isActive: boolean) {
  return `flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-colors ${
    isActive ? 'bg-brand/10 text-brand' : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
  }`;
}

// ── The two bottom-bar shapes, as class strings ──────────────────────────────
//
// Exported for the same reason SIDEBAR_CLASS is: there is no DOM harness here,
// and the difference between the two views is almost entirely a class list. A
// dropped `md:hidden` would put a phone bar on a desktop; a dropped `pb-safe`
// would tuck the tabs under an iPhone's home indicator.
export const PEACEFUL_BAR_CLASS =
  'md:hidden fixed bottom-0 inset-x-0 z-30 px-3 pb-safe pointer-events-none';

export const PEACEFUL_BAR_INNER_CLASS =
  'pointer-events-auto mx-auto mb-2 max-w-md flex items-stretch gap-1 p-1.5 '
  + 'rounded-[26px] border border-white/60 dark:border-white/10 '
  + 'bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl '
  + 'shadow-[0_10px_40px_-12px_rgba(0,0,0,0.35)]';

export const TECHNICAL_BAR_CLASS =
  'md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur '
  + 'border-t border-zinc-200 dark:border-zinc-800 pb-safe';

/** The bottom padding the content column needs to clear each bar. */
export function contentPadClass(mode: ViewMode) {
  return mode === 'peaceful' ? 'pb-32 md:pb-0' : 'pb-24 md:pb-0';
}

// Mobile bottom nav (technical): a horizontally scrollable strip so every tab is
// reachable regardless of how many there are. The scrollbar is hidden for looks,
// so we add edge fade-gradients that appear only when there's more to scroll in
// that direction — the affordance that tells the user "swipe for more tabs".
//
// Every page renders its own AppShell, so navigating fully RE-MOUNTS this strip —
// which would reset its scroll to the start on every tab change. We remember the
// horizontal scroll position at module scope (survives unmount/remount within the
// session) and restore it before paint, so the bar stays exactly where the user
// left it and only ever moves when the user scrolls it. A full page refresh
// reloads the module and starts at the beginning again.
let savedNavScrollLeft = 0;

function TechnicalNav({ navItems }: { navItems: NavItem[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft >= maxScroll - 1);
  }, []);

  // Restore the remembered scroll position BEFORE paint, so switching tabs never
  // makes the bar jump — it re-appears exactly where the user left it. Runs on
  // mount (i.e. every navigation, since the strip remounts) and when the tab set
  // or viewport width changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = savedNavScrollLeft;
    updateFades();
  }, [updateFades, navItems.length]);

  useEffect(() => {
    window.addEventListener('resize', updateFades);
    return () => window.removeEventListener('resize', updateFades);
  }, [updateFades]);

  // As the user scrolls the strip, remember the position (so it persists across
  // the remount on the next navigation) and refresh the edge fades.
  const onScroll = useCallback(() => {
    if (scrollRef.current) savedNavScrollLeft = scrollRef.current.scrollLeft;
    updateFades();
  }, [updateFades]);

  return (
    <nav className={TECHNICAL_BAR_CLASS}>
      <div className="relative">
        <div ref={scrollRef} onScroll={onScroll} className="overflow-x-auto no-scrollbar">
          <div className="flex items-stretch gap-1 px-2 py-1.5">
            {navItems.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `shrink-0 w-[66px] flex flex-col items-center justify-center gap-1 rounded-[10px] px-1 py-1.5 transition-colors ${
                    isActive
                      ? 'bg-brand/10 text-brand'
                      : 'text-zinc-500 dark:text-zinc-400 active:bg-zinc-100 dark:active:bg-zinc-800'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {/* The readout marker — a rule over the live tab, the way an
                        instrument marks the channel you're looking at. */}
                    <span className={`h-[2px] w-6 rounded-full ${isActive ? 'bg-brand' : 'bg-transparent'}`} />
                    {n.icon && <NavIcon name={n.icon} size={20} />}
                    <span className="text-[9.5px] font-semibold uppercase tracking-[0.06em] font-mono leading-none whitespace-nowrap">
                      {n.label}
                    </span>
                  </>
                )}
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

// Mobile bottom nav (peaceful): four tabs on a floating bar. Nothing scrolls,
// nothing is hidden off an edge, and each tab is a big soft target — the whole
// point is that you can hit it without looking and there is nothing to read.
function PeacefulNav({ navItems }: { navItems: NavItem[] }) {
  return (
    <nav className={PEACEFUL_BAR_CLASS}>
      <div className={PEACEFUL_BAR_INNER_CLASS}>
        {navItems.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center gap-1 rounded-[20px] py-2 transition-colors duration-200 ${
                isActive
                  ? 'bg-brand/10 text-brand'
                  : 'text-zinc-500 dark:text-zinc-400 active:bg-zinc-100/70 dark:active:bg-zinc-800/70'
              }`
            }
          >
            {n.icon && <NavIcon name={n.icon} size={22} />}
            <span className="text-[11px] font-semibold leading-none whitespace-nowrap">{n.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export default function AppShell({
  brandLead, brandTail = '', tagline, navItems, mode = 'technical', sidebarFooter, contentTabs, children,
}: AppShellProps) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex">
      {/* Sidebar — hidden on small screens (bottom bar takes over) */}
      <aside className={SIDEBAR_CLASS}>
        <div className="px-5 py-5 shrink-0">
          <Logo lead={brandLead} tail={brandTail} size="sidebar" />
          {tagline && <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{tagline}</div>}
        </div>
        <nav className={SIDEBAR_NAV_CLASS}>
          {navItems.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => sidebarNavClass(isActive)}>
              {n.icon && <NavIcon name={n.icon} size={18} />}
              {n.label}
            </NavLink>
          ))}
        </nav>
        {sidebarFooter && (
          <div className="p-3 shrink-0 border-t border-zinc-200 dark:border-zinc-800">{sidebarFooter}</div>
        )}
      </aside>

      <main className={`flex-1 overflow-y-auto ${contentPadClass(mode)}`}>
        {/* Mobile-only brand bar — NOT sticky, scrolls away with content (the logo
            lives in the sidebar on desktop). No action cluster here any more.
            The peaceful view drops the rule and the strapline: the page's own
            title should be the first thing read, and the wordmark is still there
            to say which app you're in. It keeps its height either way, which is
            what holds the page clear of the fixed bell in the corner. */}
        <div className={`md:hidden px-4 py-2.5 ${
          mode === 'peaceful' ? '' : 'border-b border-zinc-200 dark:border-zinc-800'}`}
        >
          <Logo lead={brandLead} tail={brandTail} size="mobile" />
          {tagline && mode !== 'peaceful' && (
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{tagline}</div>
          )}
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {contentTabs}
          {children}
        </div>
      </main>

      {/* Bottom nav — mobile only, in whichever shape this view uses. */}
      {mode === 'peaceful' ? <PeacefulNav navItems={navItems} /> : <TechnicalNav navItems={navItems} />}
    </div>
  );
}
