/* Dialog focus management (WCAG 2.1.2 / 2.4.3, WAI-ARIA dialog pattern) for every Drawer, Modal and lightbox:
   - initial focus inside the dialog (element marked [data-autofocus], else the first focusable, else the panel),
   - Tab / Shift+Tab cycle inside the dialog (focus trap),
   - Escape closes only the TOPMOST open dialog (a lightbox over a drawer closes alone),
   - focus returns to the element that opened the dialog when it closes / unmounts,
   - the page behind stops scrolling while a dialog is open. */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]", "area[href]", "button:not([disabled])", "input:not([disabled]):not([type='hidden'])", "select:not([disabled])",
  "textarea:not([disabled])", "iframe", "audio[controls]", "video[controls]", "[contenteditable='true']", "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Visible, tabbable descendants in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true" && (el.offsetParent !== null || el.getClientRects().length > 0));
}

const stack: symbol[] = [];
let scrollLocks = 0;
let savedOverflow = "";

export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void, options: { onKey?: (event: KeyboardEvent) => void } = {}): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const keyRef = useRef(options.onKey);
  keyRef.current = options.onKey;

  useEffect(() => {
    if (!open) return;
    const id = Symbol("dialog");
    stack.push(id);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLocks++ === 0) { savedOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }

    const focusInitial = () => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
      const target = preferred ?? focusableWithin(root)[0] ?? root;
      if (target === root && !root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    };
    const raf = requestAnimationFrame(focusInitial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;          // only the topmost dialog reacts
      const root = ref.current;
      if (!root) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      keyRef.current?.(event);
      if (event.key !== "Tab") return;
      const items = focusableWithin(root);
      if (!items.length) { event.preventDefault(); root.focus(); return; }
      const first = items[0]!; const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !root.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !root.contains(active))) { event.preventDefault(); first.focus(); }
    };
    // Focus that escapes (mouse click on the page behind, programmatic focus) is pulled back into the dialog.
    const onFocusIn = (event: FocusEvent) => {
      if (stack[stack.length - 1] !== id) return;
      const root = ref.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) focusInitial();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
