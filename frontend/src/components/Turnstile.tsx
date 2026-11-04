import { useEffect, useId, useImperativeHandle, useRef, forwardRef } from 'react';
import { turnstileSiteKey } from '@/backend/client';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

type TurnstileApi = {
  render: (container: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  scriptPromise ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Turnstile script failed to load'));
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export type TurnstileHandle = { reset: () => void };

/**
 * Cloudflare Turnstile widget. Renders nothing when `VITE_TURNSTILE_SITE_KEY` is unset, so local, demo
 * and preview builds work unchanged; callers must treat a missing site key as "bot-check skipped",
 * never as a hard failure.
 */
export const Turnstile = forwardRef<TurnstileHandle, { onVerify: (token: string | null) => void }>(function Turnstile({ onVerify }, ref) {
  const containerId = useId().replace(/:/g, '');
  const widgetId = useRef<string | undefined>(undefined);
  const onVerifyRef = useRef(onVerify);
  onVerifyRef.current = onVerify;

  useEffect(() => {
    if (!turnstileSiteKey) return;
    let cancelled = false;
    void loadScript().then(() => {
      if (cancelled) return;
      const container = document.getElementById(containerId);
      const api = window.turnstile;
      if (!container || !api) return;
      widgetId.current = api.render(container, {
        sitekey: turnstileSiteKey,
        callback: (token: string) => onVerifyRef.current(token),
        'expired-callback': () => onVerifyRef.current(null),
        'error-callback': () => onVerifyRef.current(null),
      });
    });
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
    };
  }, [containerId]);

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetId.current) window.turnstile?.reset(widgetId.current);
      onVerifyRef.current(null);
    },
  }));

  if (!turnstileSiteKey) return null;
  return <div id={containerId} className="turnstile-widget" />;
});
