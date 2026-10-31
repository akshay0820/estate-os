// Motion helpers for styles/motion.css: the cursor spotlight on cards and the gliding selection indicators.
import { useLayoutEffect, useRef, type DependencyList } from 'react';

/**
 * Cards light up where the cursor is: one pointer listener writes --mx / --my on the hovered card, at most once per
 * frame. Mouse only; touch has no hover.
 */
export function installCardSpotlight() {
  let frame = 0;
  let last: { el: HTMLElement; x: number; y: number } | null = null;
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('.card');
      if (!el) return;
      last = { el, x: e.clientX, y: e.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!last) return;
        const r = last.el.getBoundingClientRect();
        last.el.style.setProperty('--mx', `${last.x - r.left}px`);
        last.el.style.setProperty('--my', `${last.y - r.top}px`);
      });
    },
    { passive: true },
  );
}

/**
 * Moves an indicator element onto the active item inside a container and glides it there on later changes.
 * `underline` keeps only the bottom edge (tabs), inset like the tab's own underline.
 */
export function useGlide<C extends HTMLElement>(activeSelector: string, deps: DependencyList, mode: 'box' | 'underline' = 'box') {
  const box = useRef<C>(null);
  const ink = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const container = box.current;
    const el = ink.current;
    if (!container || !el) return;
    const place = () => {
      const active = container.querySelector<HTMLElement>(activeSelector);
      if (!active) {
        el.style.opacity = '0';
        return;
      }
      const b = container.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      const x = r.left - b.left - container.clientLeft + container.scrollLeft;
      const y = r.top - b.top - container.clientTop + container.scrollTop;
      if (mode === 'underline') {
        el.style.width = `${Math.max(0, r.width - 20)}px`;
        el.style.transform = `translateX(${x + 10}px)`;
      } else {
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
        el.style.transform = `translate(${x}px, ${y}px)`;
      }
      el.style.opacity = '1';
    };
    place();
    // Glide only after the first placement, so the indicator does not fly in from the corner on mount.
    const ready = requestAnimationFrame(() => (el.dataset.ready = '1'));
    const ro = new ResizeObserver(place);
    ro.observe(container);
    return () => {
      cancelAnimationFrame(ready);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { box, ink };
}
