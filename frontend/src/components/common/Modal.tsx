import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  /** Accessible name for a modal that has no visible title. */
  ariaLabel?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  footer?: React.ReactNode;
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  full: 'max-w-4xl',
};

// One shared stack of every open modal, in opening order. Escape only closes
// the topmost, and the scroll lock is ref-counted — a closed sibling modal
// (most call sites keep <Modal isOpen={…}> mounted) must not unlock the page
// out from under the one still open.
const openStack: symbol[] = [];
let scrollLocks = 0;

// The app's real scroll container is <main> inside AppShell (the body never
// scrolls), so lock both: body as a fallback for pages outside the shell.
function scrollers(): HTMLElement[] {
  const els: HTMLElement[] = [document.body];
  const main = document.querySelector('main');
  if (main instanceof HTMLElement) els.push(main);
  return els;
}
function lockScroll(): void {
  if (++scrollLocks === 1) for (const el of scrollers()) el.style.overflow = 'hidden';
}
function unlockScroll(): void {
  if (scrollLocks > 0 && --scrollLocks === 0) for (const el of scrollers()) el.style.overflow = '';
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({ isOpen, onClose, title, ariaLabel, children, size = 'md', footer }: ModalProps) {
  const instance = useRef<symbol | null>(null);
  if (!instance.current) instance.current = Symbol('modal');
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const backdropMouseDown = useRef(false);
  const titleId = useId();

  // Latest onClose without re-arming the effect — call sites pass inline arrows.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const me = instance.current!;
    openStack.push(me);
    lockScroll();

    // Move focus into the dialog (deferred, so a field's own autoFocus wins),
    // remembering where it came from to put it back on close.
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = setTimeout(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== me) return; // only the topmost modal responds
      if (e.key === 'Escape') {
        // An inner editor that handled Escape itself (inline rename etc.)
        // signals it with preventDefault — the modal then stays open.
        if (e.defaultPrevented) return;
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        // Keep Tab inside the dialog — aria-modal promises the background is
        // unreachable, so make it true.
        const panel = panelRef.current;
        if (!panel) return;
        const els = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
          .filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (els.length === 0) { e.preventDefault(); panel.focus(); return; }
        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !(active instanceof Node) || !panel.contains(active)) {
            e.preventDefault(); last.focus();
          }
        } else if (active === last || !(active instanceof Node) || !panel.contains(active)) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(focusTimer);
      const i = openStack.indexOf(me);
      if (i >= 0) openStack.splice(i, 1);
      unlockScroll();
      const back = restoreRef.current;
      if (back && back.isConnected) back.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div className="modal-backdrop flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0"
        // Anchored to mousedown so a text selection dragged out of the panel
        // and released on the scrim doesn't dismiss the modal.
        onMouseDown={() => { backdropMouseDown.current = true; }}
        onClick={() => { if (backdropMouseDown.current) onClose(); backdropMouseDown.current = false; }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`modal-panel relative w-full ${sizeClasses[size]} bg-white dark:bg-zinc-900
          rounded-t-[20px] sm:rounded-[16px]
          shadow-2xl z-50 flex flex-col
          max-h-[90vh] outline-none`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? (ariaLabel ?? 'Dialog') : undefined}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
            <h2 id={titleId} className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full
                hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-zinc-200 dark:border-zinc-800 flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
