import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react';
import { ApiError, errorMessage } from './api';
import { label } from './format';

// ───────────── Buttons, badges, feedback ─────────────

export function Button({ variant, size, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'danger' | 'ghost'; size?: 'sm'; busy?: boolean }) {
  return (
    <button type="button" {...rest} className={`btn ${variant ?? ''} ${size ?? ''} ${rest.className ?? ''}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? 'Working…' : children}
    </button>
  );
}

type Tone = 'green' | 'amber' | 'red' | 'gray' | 'blue';
/** One semantic status system for the whole application. The symbol and text carry the meaning; colour only reinforces it. */
const STATUS: Record<string, [Tone, string]> = {
  PAID: ['green', '✓'], OCCUPIED: ['green', '●'], COMPLETED: ['green', '✓'], VERIFIED: ['green', '✓'], ACTIVE: ['green', '●'], APPROVED: ['green', '✓'], ISSUED: ['green', '✓'], POSTED: ['green', '✓'], OPEN: ['green', '●'], SENT: ['green', '✓'], CONVERTED: ['green', '✓'],
  PARTIAL: ['amber', '◐'], PENDING: ['amber', '…'], RESERVED: ['amber', '◆'], EXPIRING: ['amber', '!'], SUBMITTED: ['amber', '…'], GENERATED: ['amber', '…'], IN_PROGRESS: ['amber', '◐'], ASSIGNED: ['amber', '◐'], REPORTED: ['amber', '!'], MEDIUM: ['amber', '▲'], DRAFT: ['gray', '✎'], UNPAID: ['amber', '○'],
  OVERDUE: ['red', '!'], FAILED: ['red', '✕'], CRITICAL: ['red', '‼'], HIGH: ['red', '▲'], EXPIRED: ['red', '!'], REJECTED: ['red', '✕'], REVERSED: ['red', '↺'], REVERSAL: ['red', '↺'], BLACKLISTED: ['red', '⊘'], MAINTENANCE: ['red', '✚'], DISABLED: ['red', '⊘'], VOIDED: ['red', '✕'],
  VACANT: ['gray', '○'], INACTIVE: ['gray', '–'], FORMER: ['gray', '–'], TERMINATED: ['gray', '■'], RENEWED: ['blue', '↻'], CANCELLED: ['gray', '✕'], VOID: ['gray', '✕'], WAIVED: ['blue', '≈'], LOW: ['gray', '▽'], CLOSED: ['gray', '■'],
};

export function Badge({ status, text }: { status: string; text?: string }) {
  const [tone, symbol] = STATUS[status] ?? ['gray', '•'];
  return (
    <span className={`badge ${tone}`}>
      <span aria-hidden="true">{symbol}</span>
      {text ?? label(status)}
    </span>
  );
}

export function Alert({ tone = 'red', children }: { tone?: 'red' | 'amber' | 'blue' | 'green'; children: ReactNode }) {
  const symbol = { red: '!', amber: '!', blue: 'i', green: '✓' }[tone];
  return (
    <div className={`alert ${tone}`} role={tone === 'red' ? 'alert' : 'status'}>
      <strong aria-hidden="true">{symbol}</strong>
      <div className="grow">{children}</div>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert>{errorMessage(error)}</Alert>;
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="empty" role="status">{what}…</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

const ToastCtx = createContext<(message: string, kind?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; message: string; kind: string }>>([]);
  const push = useCallback((message: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, message, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────────── Layout pieces ─────────────

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row no-print">{children}</div>}
    </div>
  );
}

export function Card({ title, actions, children, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <h2>{title}</h2>
          {actions && <div className="row no-print">{actions}</div>}
        </div>
      )}
      {pad ? <div className="card-body">{children}</div> : children}
    </section>
  );
}

export function Stat({ k, v, s, onClick, icon, tone }: { k: string; v: ReactNode; s?: ReactNode; onClick?: () => void; icon?: ReactNode; tone?: 'blue' | 'teal' | 'red' | 'amber' | 'purple' | 'cyan' }) {
  const body = (
    <>
      {icon && <span className="stat-icon" aria-hidden="true">{icon}</span>}
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </>
  );
  const cls = `card stat ${icon ? 'has-icon' : ''} ${tone ? `tone-${tone}` : ''}`;
  return onClick ? (
    <button type="button" className={`${cls} link`} style={{ textAlign: 'left', width: '100%' }} onClick={onClick}>{body}</button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function DL({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="dl">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<[T, string]>; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([key, text]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} onClick={() => onChange(key)}>{text}</button>
      ))}
    </div>
  );
}

// ───────────── Table ─────────────

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  num?: boolean;
  hideSm?: boolean;
}

export function Table<T>({ columns, rows, onRow, empty, foot, rowKey }: { columns: Array<Column<T>>; rows: T[] | undefined; onRow?: (row: T) => void; empty?: ReactNode; foot?: ReactNode; rowKey?: (row: T, i: number) => string }) {
  if (!rows) return <Loading />;
  if (!rows.length) return <>{empty ?? <Empty title="Nothing to show">No records match the current filters.</Empty>}</>;
  const cls = (c: Column<T>) => `${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.header} scope="col" className={cls(c)}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : ((row as { id?: string }).id ?? i)} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(row) : undefined}
              tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(row); } : undefined}>
              {columns.map((c) => <td key={c.header} className={cls(c)}>{c.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
        {foot && <tfoot>{foot}</tfoot>}
      </table>
    </div>
  );
}

export function Pager({ data, onPage }: { data?: { page: number; pages: number; total: number; pageSize: number }; onPage: (p: number) => void }) {
  if (!data || data.total === 0) return null;
  const from = (data.page - 1) * data.pageSize + 1;
  return (
    <div className="pager no-print">
      <span>{from}–{Math.min(data.page * data.pageSize, data.total)} of {data.total.toLocaleString()}</span>
      <div className="row">
        <Button size="sm" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</Button>
        <span>Page {data.page} of {data.pages}</span>
        <Button size="sm" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>Next</Button>
      </div>
    </div>
  );
}

// ───────────── Dialogs ─────────────

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title}>
      <div className="modal-head">
        <h2>{title}</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close">✕</Button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </dialog>
  );
}

// ───────────── Forms ─────────────

export function Field({ label: text, error, hint, children, full, required }: { label: string; error?: string; hint?: ReactNode; children: (id: string) => ReactNode; full?: boolean; required?: boolean }) {
  const id = useId();
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      <label htmlFor={id}>{text}{required && <span aria-hidden="true"> *</span>}</label>
      {children(id)}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err" role="alert">{error}</span>}
    </div>
  );
}

export interface FieldDef {
  name: string;
  label: string;
  type?: 'text' | 'money' | 'number' | 'date' | 'select' | 'textarea' | 'checkbox' | 'password' | 'email' | 'tel';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  hint?: ReactNode;
  full?: boolean;
  placeholder?: string;
  /** Hide the field depending on the other values. */
  when?: (values: Record<string, any>) => boolean;
  min?: string;
  max?: string;
}

/**
 * A form described by data. It validates required fields locally for fast feedback;
 * the server validates everything again and its field errors are shown next to the field.
 */
export function AutoForm({ fields, initial, onSubmit, submitLabel = 'Save', onCancel, children, danger, onChange }: {
  fields: FieldDef[];
  initial?: Record<string, any>;
  onSubmit: (values: Record<string, any>) => Promise<unknown>;
  submitLabel?: string;
  onCancel?: () => void;
  children?: ReactNode;
  danger?: boolean;
  onChange?: (values: Record<string, any>) => void;
}) {
  const [values, setValues] = useState<Record<string, any>>(() => ({ ...Object.fromEntries(fields.map((f) => [f.name, f.type === 'checkbox' ? false : ''])), ...initial }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (name: string, v: unknown) => {
    const next = { ...values, [name]: v };
    setValues(next);
    onChange?.(next);
  };
  const visible = fields.filter((f) => !f.when || f.when(values));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    for (const f of visible) {
      const v = values[f.name];
      if (f.required && (v === '' || v === undefined || v === null)) found[f.name] = `${f.label} is required.`;
      if (f.type === 'money' && v !== '' && !/^\d{1,12}(\.\d{1,2})?$/.test(String(v).replace(/,/g, ''))) found[f.name] = 'Enter a valid amount.';
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    try {
      const payload = Object.fromEntries(visible.map((f) => [f.name, f.type === 'money' && values[f.name] !== '' ? String(values[f.name]).replace(/,/g, '') : values[f.name]]));
      await onSubmit(payload);
    } catch (err) {
      if (err instanceof ApiError && err.details?.fields) setErrors(err.details.fields);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="stack">
        <ErrorBox error={error} />
        <div className="form-grid">
          {visible.map((f) =>
            f.type === 'checkbox' ? (
              <label key={f.name} className={`check ${f.full ? 'full' : ''}`}>
                <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => set(f.name, e.target.checked)} />
                <span>{f.label}{f.hint && <span className="hint muted small"> — {f.hint}</span>}</span>
              </label>
            ) : (
              <Field key={f.name} label={f.label} error={errors[f.name]} hint={f.hint} full={f.full ?? f.type === 'textarea'} required={f.required}>
                {(id) =>
                  f.type === 'select' ? (
                    <select id={id} className={`input ${errors[f.name] ? 'invalid' : ''}`} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}>
                      <option value="">{f.placeholder ?? 'Select…'}</option>
                      {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea id={id} className={`input ${errors[f.name] ? 'invalid' : ''}`} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />
                  ) : (
                    <input id={id} className={`input ${errors[f.name] ? 'invalid' : ''}`} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} min={f.min} max={f.max}
                      type={f.type === 'money' ? 'text' : (f.type ?? 'text')} inputMode={f.type === 'money' ? 'decimal' : undefined} autoComplete={f.type === 'password' ? 'new-password' : 'off'} />
                  )
                }
              </Field>
            ),
          )}
        </div>
        {children}
        <div className="row end">
          {onCancel && <Button onClick={onCancel} disabled={busy}>Cancel</Button>}
          <button type="submit" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </div>
    </form>
  );
}

/** Confirmation dialog for consequential actions; optionally requires a written reason. */
export function Confirm({ title, children, confirmLabel, danger, reason, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; reason?: string; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(text.trim());
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button onClick={onClose} disabled={busy}>Cancel</Button>
      <Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={Boolean(reason) && text.trim().length < 3} onClick={run}>{confirmLabel}</Button>
    </>}>
      <div className="stack">
        <ErrorBox error={error} />
        <div>{children}</div>
        {reason && (
          <Field label={reason} required>
            {(id) => <textarea id={id} className="input" value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        )}
      </div>
    </Modal>
  );
}

export function Select({ label: text, value, onChange, options, all }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; all?: string }) {
  return (
    <Field label={text}>
      {(id) => (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {all !== undefined && <option value="">{all}</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}

export function TextInput({ label: text, value, onChange, type = 'text', placeholder, wide }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; wide?: boolean }) {
  const id = useId();
  return (
    <div className={`field ${wide ? 'wide' : ''}`}>
      <label htmlFor={id}>{text}</label>
      <input id={id} className="input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Debounces a fast-changing value (search boxes) so the server is not queried on every keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const opts = (items: Array<{ id: string; name: string }> | undefined) => (items ?? []).map((i) => ({ value: i.id, label: i.name }));
export const enumOpts = (values: string[]) => values.map((v) => ({ value: v, label: label(v) }));
