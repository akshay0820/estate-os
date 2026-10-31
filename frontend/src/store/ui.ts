import { create } from 'zustand';
import { uid } from '@/lib/util';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

interface UiState {
  toasts: Toast[];
  cmdOpen: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  theme: 'light' | 'dark';
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
  setCmd: (open: boolean) => void;
  setCollapsed: (v: boolean) => void;
  setMobileOpen: (v: boolean) => void;
  toggleTheme: () => void;
}

const readTheme = (): 'light' | 'dark' =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

const readCollapsed = () => {
  try {
    return localStorage.getItem('estate-os:collapsed') === '1';
  } catch {
    return false;
  }
};

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  cmdOpen: false,
  collapsed: readCollapsed(),
  mobileOpen: false,
  theme: readTheme(),
  toast: (t) => {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => get().dismiss(id), t.kind === 'error' ? 6500 : 4200);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setCmd: (cmdOpen) => set({ cmdOpen }),
  setCollapsed: (collapsed) => {
    try {
      localStorage.setItem('estate-os:collapsed', collapsed ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    set({ collapsed });
  },
  setMobileOpen: (mobileOpen) => set({ mobileOpen }),
  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    const apply = () => {
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem('estate-os:theme', theme);
      } catch {
        /* storage unavailable */
      }
      set({ theme });
    };
    // The new theme sweeps in from the top-right corner (where the toggle sits) to the bottom-left, using the View
    // Transitions API (base.css). Browsers without it, or users who prefer reduced motion, get an instant switch.
    const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
    if (!doc.startViewTransition || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      apply();
      return;
    }
    const root = document.documentElement;
    root.classList.add('theme-switching');
    doc.startViewTransition(apply).finished.finally(() => root.classList.remove('theme-switching'));
  },
}));

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t);
