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
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('estate-os:theme', theme);
    } catch {
      /* storage unavailable */
    }
    set({ theme });
  },
}));

export const toast = (t: Omit<Toast, 'id'>) => useUi.getState().toast(t);
