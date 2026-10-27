import { useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { Button, Field, Input, Modal, Select, Textarea } from './ui';
import { useUi } from '@/store/ui';

interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Ask for a reason from a fixed list (e.g. loss reasons). */
  reasons?: string[];
  /** Ask for free text. */
  input?: { label: string; placeholder?: string; required?: boolean; multiline?: boolean };
  /** Make the user type a word to confirm (destructive actions). */
  typeToConfirm?: string;
}

interface ConfirmState {
  opts: ConfirmOptions | null;
  resolve: ((v: { ok: boolean; value?: string }) => void) | null;
}

const useConfirmStore = create<ConfirmState>(() => ({ opts: null, resolve: null }));

export function confirm(opts: ConfirmOptions): Promise<{ ok: boolean; value?: string }> {
  return new Promise((resolve) => useConfirmStore.setState({ opts, resolve }));
}

export function ConfirmHost() {
  const { opts, resolve } = useConfirmStore();
  if (!opts || !resolve) return null;
  return <ConfirmDialog key={opts.title} opts={opts} resolve={resolve} />;
}

function ConfirmDialog({ opts, resolve }: { opts: ConfirmOptions; resolve: (v: { ok: boolean; value?: string }) => void }) {
  const [value, setValue] = useState(opts.reasons?.[0] ?? '');
  const [typed, setTyped] = useState('');
  const close = (ok: boolean) => {
    useConfirmStore.setState({ opts: null, resolve: null });
    resolve({ ok, value });
  };
  const blocked = (opts.input?.required && !value.trim()) || (opts.typeToConfirm != null && typed !== opts.typeToConfirm);
  return (
    <Modal
      open
      size="narrow"
      onClose={() => close(false)}
      title={opts.title}
      description={opts.body}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={opts.danger ? 'danger-solid' : 'primary'} disabled={blocked} onClick={() => close(true)} data-autofocus={!opts.input && !opts.reasons && !opts.typeToConfirm ? true : undefined}>
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      {(opts.reasons || opts.input || opts.typeToConfirm) && (
        <div className="stack">
          {opts.reasons && (
            <Field label="Reason">
              <Select value={value} onChange={(e) => setValue(e.target.value)}>
                {opts.reasons.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
          )}
          {opts.input && (
            <Field label={opts.input.label}>
              {opts.input.multiline ? (
                <Textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder={opts.input.placeholder} />
              ) : (
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={opts.input.placeholder} />
              )}
            </Field>
          )}
          {opts.typeToConfirm && (
            <Field label={<>Type <b className="mono">{opts.typeToConfirm}</b> to confirm</>}>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}

const ICON = {
  success: <CheckCircle2 size={17} />,
  error: <XCircle size={17} />,
  warning: <AlertTriangle size={17} />,
  info: <Info size={17} />,
};

export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismiss);
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          <span className="t-icon">{ICON[t.kind]}</span>
          <div className="grow">
            <div className="t-title">{t.title}</div>
            {t.body && <div className="t-body">{t.body}</div>}
          </div>
          {t.action && (
            <button
              className="t-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" style={{ opacity: 0.5 }}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
