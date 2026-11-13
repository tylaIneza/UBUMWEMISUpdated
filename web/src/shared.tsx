import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ButtonHTMLAttributes, type MouseEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage, type Query } from './api';
import { useAuth, useMeta } from './auth';
import { date, dateTime, fileSize, label, money, month } from './format';
import { Alert, Badge, Button, Confirm, Empty, ErrorBox, Loading, Pager, Select, Table, useToast } from './ui';

/** GET a resource; the query key includes the parameters so filters and pages cache separately. */
export function useApi<T = any>(path: string, params?: Query, enabled = true) {
  return useQuery<T>({ queryKey: [path, params ?? {}], queryFn: () => api.get<T>(path, params), enabled, placeholderData: keepPreviousData });
}

/** Run a write, then refresh everything on screen (figures on several pages depend on most writes). */
export function useAction<TArgs, TResult = any>(fn: (args: TArgs) => Promise<TResult>, success?: string | ((r: TResult) => string)) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result) => {
      await qc.invalidateQueries();
      if (success) toast(typeof success === 'function' ? success(result) : success);
    },
  });
}

/** A button that downloads a file, showing "Preparing…" until it arrives and a toast if it fails. */
export function DownloadButton({ path, params, busyLabel = 'Preparing…', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { path: string; params?: Query; busyLabel?: string; variant?: 'primary'; size?: 'sm' }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const start = async (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await api.download(path, params);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return <Button {...rest} disabled={busy} aria-busy={busy || undefined} onClick={start}>{busy ? <><span className="spinner" aria-hidden="true" />{busyLabel}</> : children}</Button>;
}

export function ReceiptLink({ payment }: { payment: { id: string; receipt?: { receiptNumber: string } | null; type?: string } }) {
  return <Link to={`/payments/${payment.id}`} onClick={(e) => e.stopPropagation()}>{payment.receipt?.receiptNumber ?? (payment.type === 'REVERSAL' ? 'Reversal entry' : 'Payment')}</Link>;
}

/** Monthly rent ledger. Click a month to see the transactions behind it. */
export function LedgerTable({ params, showTenant, pageSize = 12, onWaive }: { params: Query; showTenant?: boolean; pageSize?: number; onWaive?: (charge: any) => void }) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useApi('/rent/charges', { ...params, page, pageSize });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  if (!q.data.items.length) return <Empty title="No rent charges">No rent has been billed for this selection yet.</Empty>;
  const cols = showTenant ? 8 : 6;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              {showTenant && <><th scope="col">Tenant</th><th scope="col" className="hide-sm">Room</th></>}
              <th scope="col" className="num">Due</th><th scope="col" className="num">Paid</th><th scope="col" className="num">Balance</th>
              <th scope="col">Status</th><th scope="col" className="hide-sm">Due date</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((c: any) => (
              <FragmentRow key={c.id}>
                <tr className="click" onClick={() => setOpen(open === c.id ? null : c.id)} tabIndex={0} aria-expanded={open === c.id}
                  onKeyDown={(e) => { if (e.key === 'Enter') setOpen(open === c.id ? null : c.id); }}>
                  <td className="strong nowrap">{open === c.id ? '▾' : '▸'} {month(c.period)}</td>
                  {showTenant && <><td><Link to={`/tenants/${c.tenant.id}`} onClick={(e) => e.stopPropagation()}>{c.tenant.fullName}</Link></td><td className="hide-sm">{c.room.number} · {c.building.name}</td></>}
                  <td className="num">{money(c.amountDue)}</td><td className="num">{money(c.amountPaid)}</td>
                  <td className="num strong">{money(c.balance)}</td>
                  <td>
                    <Badge status={c.isOverdue && c.status === 'PARTIAL' ? 'OVERDUE' : c.status} text={c.isOverdue && c.status === 'PARTIAL' ? 'Partial · overdue' : undefined} />
                    {c.daysOverdue > 0 && <span className="muted small"> {c.daysOverdue} d</span>}
                  </td>
                  <td className="hide-sm">{date(c.dueDate)}</td>
                </tr>
                {open === c.id && (
                  <tr>
                    <td colSpan={cols} style={{ background: 'var(--surface-2)' }}>
                      <div className="stack tight">
                        <div className="small muted">
                          Rent {money(c.baseAmount)}{Number(c.adjustmentAmount) !== 0 && <> · adjustment {money(c.adjustmentAmount)}</>}{Number(c.amountWaived) > 0 && <> · waived {money(c.amountWaived)}</>}
                          {c.note && <> · {c.note}</>} · contract <Link to={`/contracts/${c.contract.id}`}>{c.contract.contractNumber}</Link>
                          {onWaive && Number(c.balance) > 0 && <> · <Button size="sm" variant="ghost" onClick={() => onWaive(c)}>Request waiver</Button></>}
                        </div>
                        {c.allocations.length === 0 ? <span className="small muted">No payments have been applied to this month.</span> : (
                          <table className="table inner">
                            <thead><tr><th>Date</th><th>Receipt</th><th>Method</th><th className="num">Applied to this month</th><th className="hide-sm">Recorded by</th></tr></thead>
                            <tbody>
                              {c.allocations.map((a: any) => (
                                <tr key={a.id}>
                                  <td>{dateTime(a.payment.paidAt)}</td><td><ReceiptLink payment={a.payment} /></td><td>{a.payment.method.name}</td>
                                  <td className="num">{money(a.amount)}</td><td className="hide-sm">{a.payment.recordedBy.fullName}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </FragmentRow>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={showTenant ? 3 : 1}>Total (all pages)</td>
              <td className="num">{money(q.data.totals.amountDue)}</td><td className="num">{money(q.data.totals.amountPaid)}</td><td className="num">{money(q.data.totals.balance)}</td><td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <Pager data={q.data} onPage={setPage} />
    </>
  );
}
const FragmentRow = ({ children }: { children: React.ReactNode }) => <>{children}</>;

export function PaymentsTable({ params, showTenant = true, pageSize = 15 }: { params: Query; showTenant?: boolean; pageSize?: number }) {
  const [page, setPage] = useState(1);
  const q = useApi('/payments', { ...params, page, pageSize });
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <Table rows={q.data?.items} empty={<Empty title="No payments">No payments have been recorded for this selection.</Empty>} columns={[
        { header: 'Date', cell: (p: any) => <span className="nowrap">{dateTime(p.paidAt)}</span> },
        { header: 'Receipt', cell: (p: any) => <ReceiptLink payment={p} /> },
        ...(showTenant ? [{ header: 'Tenant', cell: (p: any) => p.tenant.fullName }, { header: 'Room', cell: (p: any) => `${p.room.number} · ${p.building.name}`, hideSm: true }] : []),
        { header: 'Method', cell: (p: any) => <>{p.method.name}{p.reference && <span className="muted small"> · {p.reference}</span>}</>, hideSm: true },
        { header: 'Amount', num: true, cell: (p: any) => <span className="strong">{money(p.amount)}</span> },
        { header: 'Status', cell: (p: any) => p.type === 'REVERSAL' ? <Badge status="REVERSAL" /> : p.status === 'REVERSED' ? <Badge status="REVERSED" /> : p.verifiedAt ? <Badge status="VERIFIED" /> : <Badge status="PENDING" text="Unverified" /> },
        { header: 'EBM', hideSm: true, cell: (p: any) => p.invoice ? (p.invoice.ebmReference ?? <Badge status={p.invoice.status} />) : '—' },
      ]} />
      <Pager data={q.data} onPage={setPage} />
    </>
  );
}

const CATEGORIES = ['ID_DOCUMENT', 'PHOTO', 'CONTRACT', 'PAYMENT_EVIDENCE', 'RECEIPT', 'MAINTENANCE', 'OTHER'];

/** Upload, list and download the private documents attached to a record. */
export function DocumentsPanel({ entityType, entityId, defaultCategory = 'OTHER' }: { entityType: string; entityId: string; defaultCategory?: string }) {
  const { can } = useAuth();
  const q = useApi('/documents', { entityType, entityId });
  const [category, setCategory] = useState(defaultCategory);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const upload = useAction(async (file: File) => {
    const form = new FormData();
    form.set('entityType', entityType);
    form.set('entityId', entityId);
    form.set('category', category);
    form.set('file', file);
    return api.post('/documents', form);
  }, 'Document uploaded.');
  const archive = useAction((id: string) => api.del(`/documents/${id}`), 'Document archived.');
  return (
    <div className="stack">
      {can('document.upload') && (
        <div className="row no-print">
          <Select label="Document type" value={category} onChange={setCategory} options={CATEGORIES.map((c) => ({ value: c, label: label(c) }))} />
          <div className="field">
            <span className="label">File (PDF, JPG, PNG, WEBP, DOCX, XLSX — max 10 MB)</span>
            <input ref={input} type="file" className="input" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx" aria-label="Choose file to upload"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setError(null);
                try { await upload.mutateAsync(file); } catch (err) { setError(err); }
                if (input.current) input.current.value = '';
              }} />
          </div>
          {upload.isPending && <span className="muted">Uploading…</span>}
        </div>
      )}
      <ErrorBox error={error ?? q.error} />
      <Table rows={q.data?.items} empty={<Empty title="No documents">Nothing has been uploaded for this record.</Empty>} columns={[
        { header: 'File', cell: (d: any) => can('document.view') ? <a href={api.url(`/documents/${d.id}/download`)}>{d.fileName}</a> : d.fileName },
        { header: 'Type', cell: (d: any) => label(d.category) },
        { header: 'Version', cell: (d: any) => `v${d.version}`, hideSm: true },
        { header: 'Size', cell: (d: any) => fileSize(d.sizeBytes), hideSm: true },
        { header: 'Uploaded', cell: (d: any) => <>{dateTime(d.createdAt)}<span className="muted small"> · {d.uploadedBy.fullName}</span></> },
        { header: '', cell: (d: any) => can('document.upload') ? <Button size="sm" variant="ghost" onClick={() => archive.mutate(d.id, { onError: (e) => setError(e) })}>Archive</Button> : null },
      ]} />
    </div>
  );
}

export function TimelinePanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const q = useApi('/timeline', { entityType, entityId });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  if (!q.data.items.length) return <Empty title="No activity yet" />;
  return (
    <ol className="timeline">
      {q.data.items.map((t: any) => (
        <li key={t.id}>
          <span className="muted small">{dateTime(t.createdAt)}</span>
          <span>{t.summary ?? label(t.action)}<span className="muted small"> — {t.userLabel}</span></span>
        </li>
      ))}
    </ol>
  );
}

export function errText(e: unknown) {
  return errorMessage(e);
}

type ImportScope = 'rooms' | 'tenants';
const IMPORT_SHEETS: Record<ImportScope | 'all', string[]> = { all: ['Buildings', 'Floors', 'Rooms', 'Tenants', 'Contracts'], rooms: ['Floors', 'Rooms'], tenants: ['Tenants'] };
const IMPORT_INTRO: Record<ImportScope | 'all', string> = {
  all: 'Bring in existing buildings, floors, rooms, tenants and current contracts from Excel or CSV.',
  rooms: 'Choose the building, download its template and fill in each room’s floor, room number and monthly rent. A floor the building does not have yet can be added on the template’s Floors sheet.',
  tenants: 'Download the template and write one tenant’s full name per row. Add the phone, ID number and other details afterwards on each tenant’s page (Edit), and give them a room there.',
};

/** Excel / CSV import: check the file, show every row with its problems, then import in one step. Without a scope it accepts every record type. */
export function ImportPanel({ scope }: { scope?: ImportScope }) {
  const { buildingId: current } = useAuth();
  const meta = useMeta();
  const buildings = (meta.data?.buildings ?? []).filter((b: any) => b.status === 'ACTIVE');
  // A rooms import goes into one building, chosen here; the file then needs no building column.
  const perBuilding = scope === 'rooms';
  const [buildingId, setBuildingId] = useState(perBuilding ? current ?? '' : '');
  const building = buildings.find((b: any) => b.id === buildingId);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useAction(async () => undefined);
  const send = (path: string, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('file', file!);
    if (sheet) form.set('sheet', sheet);
    if (scope) form.set('for', scope);
    if (perBuilding) form.set('buildingId', buildingId);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    return api.post(path, form);
  };
  const run = async () => {
    setBusy(true); setError(null); setPreview(null); setDone(null);
    try { setPreview(await send('/import/preview')); } catch (e) { setError(e); if ((e as any)?.details?.sheets) setPreview((e as any).details); }
    setBusy(false);
  };
  const isCsv = file?.name.toLowerCase().endsWith('.csv');
  return (
    <div className="card-body stack">
      <p className="muted">{IMPORT_INTRO[scope ?? 'all']} The file is checked first and shown as a preview; nothing is saved until you confirm, and nothing at all is saved if any row has an error.</p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        {perBuilding && <Select label="Building" value={buildingId} onChange={(v) => { setBuildingId(v); setPreview(null); setDone(null); setError(null); }} all="Select…" options={buildings.map((b: any) => ({ value: b.id, label: b.name }))} />}
        {perBuilding && !building ? <Button disabled>Download Excel template</Button> : <a className="btn" href={api.url('/import/template', { for: scope, buildingId: building?.id })}>Download Excel template</a>}
        <div className="field"><span className="label">File (.xlsx or .csv)</span><input ref={input} type="file" className="input" accept=".xlsx,.csv" aria-label="Import file" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setDone(null); setError(null); }} /></div>
        {isCsv && <Select label="This CSV contains" value={sheet} onChange={setSheet} all="Select…" options={IMPORT_SHEETS[scope ?? 'all'].map((s) => ({ value: s, label: s }))} />}
        <Button variant="primary" disabled={!file || (isCsv && !sheet) || (perBuilding && !building)} busy={busy} onClick={run}>Check file</Button>
      </div>
      <ErrorBox error={error} />
      {done && <Alert tone="green">Import complete: {Object.entries(done).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}.</Alert>}
      {preview && (
        <div className="stack">
          {preview.totalErrors > 0 ? <Alert><strong>{preview.totalErrors} row(s) have errors.</strong> Correct the file and check it again. Nothing has been imported.</Alert>
            : preview.totalToCreate === 0 ? <Alert tone="amber">Every row already exists. There is nothing to import.</Alert>
              : <div className="alert green"><div className="grow"><strong>The file is valid.</strong> {preview.totalToCreate} new record(s) will be created.</div><Button variant="primary" onClick={() => setConfirm(true)}>Import {preview.totalToCreate} record(s)…</Button></div>}
          {preview.sheets.map((s: any) => (
            <div key={s.name}>
              <h3 style={{ marginBottom: 6 }}>{s.name} <span className="muted small" style={{ fontWeight: 400 }}>— {s.toCreate} to create, {s.toSkip} already exist, {s.errors} with errors</span></h3>
              <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 6, maxHeight: 320, overflowY: 'auto' }}>
                <table className="table">
                  <thead><tr><th>Row</th><th>Result</th>{Object.keys(s.rows[0]?.data ?? {}).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                  <tbody>
                    {s.rows.map((r: any) => (
                      <tr key={r.rowNumber} style={{ background: r.errors.length ? 'var(--red-bg)' : undefined }}>
                        <td>{r.rowNumber}</td>
                        <td style={{ minWidth: 220 }}>{r.errors.length ? <><Badge status="FAILED" text="Error" /><div className="small">{r.errors.join(' ')}</div></> : r.action === 'skip' ? <><Badge status="INACTIVE" text="Skip" /><div className="small muted">{r.note}</div></> : <Badge status="APPROVED" text="Will be created" />}</td>
                        {Object.values(r.data).map((v: any, i) => <td key={i}>{v}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <Confirm title="Import these records?" confirmLabel="Yes, import" onClose={() => setConfirm(false)} onConfirm={async () => {
          const result = await send('/import/commit', { confirm: 'yes' });
          setDone(result); setPreview(null); setFile(null);
          if (input.current) input.current.value = '';
          await refresh.mutateAsync(undefined as never);
        }}>
          {preview?.totalToCreate} record(s) will be created in one step{building ? ` in ${building.name}` : ''}.{!scope && ' Imported contracts become active immediately: their rooms are marked Occupied and rent is billed from each contract’s “billFrom” month.'}
        </Confirm>
      )}
    </div>
  );
}
