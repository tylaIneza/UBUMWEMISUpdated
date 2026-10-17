import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, NetworkError, newSubmissionKey } from '../api';
import { useAuth, useMeta } from '../auth';
import { amount as plain, date, dateTime, isoDay, money, month } from '../format';
import { DocumentsPanel, LedgerTable, PaymentsTable, TimelinePanel, useAction, useApi } from '../shared';
import { Alert, AutoForm, Badge, Button, Card, Confirm, DL, Empty, enumOpts, ErrorBox, Field, Loading, Modal, opts, PageHead, Pager, Select, Stat, Table, TextInput, useDebounced, useToast } from '../ui';

// ───────────── Record payment: choose contract → amount → allocation → confirm → receipt ─────────────

function ContractPicker({ onPick }: { onPick: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const list = useApi('/contracts', { q, pageSize: 12 }, q.length >= 2);
  return (
    <Card title="1. Find the tenant">
      <div className="stack">
        <TextInput label="Search by tenant name, room number or contract number" value={search} onChange={setSearch} placeholder="Start typing…" />
        <Table rows={q.length >= 2 ? list.data?.items.filter((c: any) => c.status !== 'DRAFT') : []} onRow={(c: any) => onPick(c.id)}
          empty={<Empty title={q.length >= 2 ? 'No contract found' : 'Type at least two characters'} />} columns={[
            { header: 'Tenant', cell: (c: any) => <span className="strong">{c.tenant.fullName}</span> }, { header: 'Room', cell: (c: any) => `${c.room.number} · ${c.building.name}` },
            { header: 'Contract', cell: (c: any) => <>{c.contractNumber} <Badge status={c.status} /></>, hideSm: true }, { header: 'Outstanding', num: true, cell: (c: any) => money(c.outstanding) },
          ]} />
      </div>
    </Card>
  );
}

export function RecordPayment() {
  const [params, setParams] = useSearchParams();
  const contractId = params.get('contractId') ?? '';
  const { me, can } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const today = me!.organization.today;

  const [amountText, setAmountText] = useState('');
  const [methodId, setMethodId] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [notes, setNotes] = useState('');
  const [advance, setAdvance] = useState(false);
  const [stage, setStage] = useState<'entry' | 'confirm'>('entry');
  const [submissionKey, setSubmissionKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [uncertain, setUncertain] = useState(false);
  const [plan, setPlan] = useState<any>(null);
  const [planError, setPlanError] = useState<unknown>(null);

  const contract = useApi(`/contracts/${contractId}`, undefined, Boolean(contractId));
  const open = useApi('/rent/charges', { contractId, pageSize: 60, dir: 'asc' }, Boolean(contractId));
  const cleaned = amountText.replace(/[,\s]/g, '');
  const valid = /^\d{1,12}(\.\d{1,2})?$/.test(cleaned) && Number(cleaned) > 0;
  const debounced = useDebounced(valid ? cleaned : '', 250);
  const methods: any[] = meta.data?.paymentMethods?.filter((m: any) => m.isActive) ?? [];
  const method = methods.find((m) => m.id === methodId);

  // Ask the server exactly how this amount would be allocated — nothing is saved by this call.
  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    if (!contractId || !debounced) return;
    api.post('/payments/preview', { contractId, amount: debounced, overpayment: advance ? 'ADVANCE' : 'REJECT' })
      .then((p) => { if (!cancelled) setPlan(p); })
      .catch((e) => { if (!cancelled) setPlanError(e); });
    return () => { cancelled = true; };
  }, [contractId, debounced, advance]);
  useEffect(() => { setAdvance(false); setStage('entry'); }, [contractId]);

  const outstanding = useMemo(() => (open.data?.items ?? []).filter((c: any) => Number(c.balance) > 0 && ['UNPAID', 'PARTIAL', 'OVERDUE'].includes(c.status)), [open.data]);
  const totalOutstanding = outstanding.reduce((a: number, c: any) => a + Number(c.balance), 0);
  const overpaid = plan?.overpaid && !advance;
  const ready = valid && plan && !overpaid && debounced === cleaned && methodId && (!method?.requiresReference || reference.trim()) && paidOn <= today;

  if (!contractId) {
    return (
      <div className="stack">
        <PageHead title="Record payment" sub="Find the tenant, enter the amount, check the allocation, confirm." />
        <ContractPicker onPick={(id) => setParams({ contractId: id })} />
      </div>
    );
  }
  if (contract.error) return <ErrorBox error={contract.error} />;
  if (!contract.data) return <Loading />;
  const c = contract.data;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.post('/payments', {
        contractId, amount: cleaned, methodId, reference: reference.trim(), notes, overpayment: advance ? 'ADVANCE' : 'REJECT', idempotencyKey: submissionKey,
        // A back-dated payment is stamped at midday Kigali time on that day.
        paidAt: paidOn === today ? undefined : `${paidOn}T12:00:00+02:00`,
      });
      navigate(`/payments/${saved.id}?recorded=1`, { replace: true });
    } catch (e) {
      // If the connection dropped we cannot know whether the server saved it. Retrying with the SAME key is safe.
      setUncertain(e instanceof NetworkError);
      setError(e);
      if (e instanceof ApiError && e.code === 'OVERPAYMENT') setStage('entry');
      setBusy(false);
    }
  }

  const summary: Array<[string, React.ReactNode]> = [
    ['Tenant', <strong>{c.tenant.fullName}</strong>], ['Room', c.room.number], ['Building', `${c.building.name} · ${c.floor.name}`],
    ['Payment', <span className="big-amount">{valid ? money(cleaned) : '—'}</span>], ['Method', `${method?.name ?? '—'}${reference ? ` · ref. ${reference}` : ''}`], ['Date', date(paidOn)],
  ];

  const allocation = plan && (
    <div className="alloc">
      <table className="table">
        <thead><tr><th>Month</th><th className="num">Balance before</th><th className="num">This payment</th><th className="num">Remaining</th></tr></thead>
        <tbody>
          {plan.plan.lines.filter((l: any) => Number(l.applied) > 0).map((l: any) => (
            <tr key={l.periodLabel}>
              <td>{l.periodLabel}{l.future && <> <Badge status="RENEWED" text="Advance" /></>}</td>
              <td className="num">{plain(l.balanceBefore)}</td><td className="num strong">{plain(l.applied)}</td><td className="num">{plain(l.balanceAfter)}</td>
            </tr>
          ))}
          {Number(plan.plan.unallocated) > 0 && <tr><td colSpan={2}>Held as advance credit (no month left to apply it to)</td><td className="num strong">{plain(plan.plan.unallocated)}</td><td /></tr>}
        </tbody>
        <tfoot><tr><td colSpan={3}>Remaining balance after this payment</td><td className="num">{money(plan.plan.outstandingAfter)}</td></tr></tfoot>
      </table>
    </div>
  );

  if (stage === 'confirm') {
    return (
      <div className="stack" style={{ maxWidth: 640 }}>
        <PageHead title="Confirm payment" sub="Check every line. Nothing has been saved yet." />
        <Card>
          <div className="stack">
            {uncertain ? (
              <Alert tone="amber"><strong>The connection was lost before the server answered.</strong> The payment may or may not have been saved. Press “Check and retry”: if it was already saved you will be taken to its receipt, and it will <em>not</em> be recorded twice.</Alert>
            ) : <ErrorBox error={error} />}
            <DL items={summary} />
            <h3>Allocation</h3>
            {allocation}
            {notes && <DL items={[['Notes', notes]]} />}
            <div className="row between">
              <Button onClick={() => { setStage('entry'); setError(null); setUncertain(false); }} disabled={busy}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={confirm}>{uncertain ? 'Check and retry' : 'Confirm payment'}</Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead title="Record payment" sub={<><Link to={`/tenants/${c.tenant.id}`}>{c.tenant.fullName}</Link> · Room {c.room.number} · {c.building.name} · {c.contractNumber} <Badge status={c.status} /></>}>
        <Button onClick={() => setParams({})}>Choose another tenant</Button>
      </PageHead>
      <div className="grid c2">
        <Card title="Current outstanding" pad={false}>
          <Table rows={open.data ? outstanding : undefined} empty={<Empty title="Nothing outstanding">This contract is fully paid up. A payment now can only be recorded as an advance.</Empty>} columns={[
            { header: 'Month', cell: (x: any) => month(x.period) }, { header: 'Due', num: true, cell: (x: any) => plain(x.amountDue), hideSm: true }, { header: 'Paid', num: true, cell: (x: any) => plain(x.amountPaid), hideSm: true },
            { header: 'Balance', num: true, cell: (x: any) => <strong>{plain(x.balance)}</strong> }, { header: 'Status', cell: (x: any) => <Badge status={x.isOverdue ? 'OVERDUE' : x.status} /> },
          ]} foot={<tr><td>Total outstanding</td><td className="hide-sm" /><td className="hide-sm" /><td className="num">{money(totalOutstanding)}</td><td /></tr>} />
          {Number(c.summary.credit) > 0 && <div className="card-body"><Alert tone="blue">Advance credit already held: {money(c.summary.credit)}.</Alert></div>}
        </Card>
        <Card title="Payment">
          <div className="stack">
            <ErrorBox error={error ?? planError} />
            <div className="form-grid">
              <Field label="Payment amount (RWF)" required error={amountText && !valid ? 'Enter a valid amount.' : undefined}>
                {(id) => <input id={id} className="input" inputMode="decimal" autoFocus value={amountText} onChange={(e) => { setAmountText(e.target.value); setAdvance(false); }} style={{ fontSize: 18, fontWeight: 650 }} />}
              </Field>
              <Select label="Payment method *" value={methodId} onChange={setMethodId} all="Select…" options={opts(methods)} />
              <Field label={`Transaction reference${method?.requiresReference ? ' *' : ''}`} hint={method?.requiresReference ? `Required for ${method.name}.` : 'Optional'}>
                {(id) => <input id={id} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />}
              </Field>
              <Field label="Payment date" error={paidOn > today ? 'The date cannot be in the future.' : undefined}>{(id) => <input id={id} type="date" className="input" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
              <Field label="Notes" full>{(id) => <input id={id} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
            </div>
            <div className="row">
              <Button size="sm" disabled={totalOutstanding <= 0} onClick={() => { setAmountText(String(totalOutstanding)); setAdvance(false); }}>Pay total outstanding ({money(totalOutstanding)})</Button>
            </div>

            {plan?.overpaid && !advance && (
              <div className="alert red" role="alert">
                <div className="grow stack tight">
                  <strong>{Number(plan.plan.outstandingBefore) === 0 ? 'There is no outstanding balance on this contract.' : `Payment exceeds current outstanding balance by ${money(plan.plan.excess)}.`}</strong>
                  <span>Choose what to do with the extra {money(plan.plan.excess)}:</span>
                  <div className="row">
                    <Button size="sm" onClick={() => setAmountText('')}>Cancel</Button>
                    {Number(plan.plan.outstandingBefore) > 0 && <Button size="sm" onClick={() => setAmountText(String(Number(plan.plan.outstandingBefore)))}>Apply only outstanding amount ({money(plan.plan.outstandingBefore)})</Button>}
                    <Button size="sm" disabled={!plan.canRecordAdvance} onClick={() => setAdvance(true)}>Record excess as advance payment</Button>
                  </div>
                  {!plan.canRecordAdvance && <span className="small">Only a manager or accountant can record an advance payment.</span>}
                </div>
              </div>
            )}
            {advance && plan && <Alert tone="blue">Recording as an <strong>advance payment</strong>: {money(plan.plan.excess)} beyond the current balance goes to the following months{plan.plan.monthsCovered.length ? ` (fully covers: ${plan.plan.monthsCovered.join(', ')})` : ''}. <Button size="sm" variant="ghost" onClick={() => setAdvance(false)}>Undo</Button></Alert>}

            {plan && !overpaid && (<><h3>How this payment will be applied</h3>{allocation}</>)}
            {!plan && valid && !planError && <p className="muted">Calculating allocation…</p>}

            <div className="row end">
              <Button variant="primary" disabled={!ready} onClick={() => { setSubmissionKey(newSubmissionKey()); setError(null); setUncertain(false); setStage('confirm'); }}>Review payment</Button>
            </div>
            {!can('payment.advance') && <p className="muted small">Payments are applied to the oldest unpaid month first.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ───────────── Payment list ─────────────

export function Payments() {
  const { can, buildingId, me } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const f = { from: params.get('from') ?? '', to: params.get('to') ?? '', methodId: params.get('methodId') ?? '', status: params.get('status') ?? '', verified: params.get('verified') ?? '' };
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const totals = useApi('/payments', { ...f, q, buildingId, pageSize: 1 });
  return (
    <div className="stack">
      <PageHead title="Payments" sub="The rent payment ledger. Entries are never edited or deleted — corrections are made by reversal.">
        {can('payment.create') && <Link to="/payments/new" className="btn primary">Record payment</Link>}
      </PageHead>
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Receipt number, reference, tenant or room" />
          <TextInput label="From" type="date" value={f.from} onChange={(v) => set('from', v)} /><TextInput label="To" type="date" value={f.to} onChange={(v) => set('to', v)} />
          <Select label="Method" value={f.methodId} onChange={(v) => set('methodId', v)} all="All methods" options={opts(meta.data?.paymentMethods)} />
          <Select label="Status" value={f.status} onChange={(v) => set('status', v)} all="All" options={enumOpts(['POSTED', 'REVERSED'])} />
          <Select label="Verification" value={f.verified} onChange={(v) => set('verified', v)} all="All" options={[{ value: 'false', label: 'Awaiting verification' }, { value: 'true', label: 'Verified' }]} />
          <Button size="sm" onClick={() => setParams({ from: me!.organization.today, to: me!.organization.today })}>Today</Button>
        </div>
        <div className="card-body row between" style={{ borderBottom: '1px solid var(--border)' }}>
          <span>{totals.data ? `${totals.data.total.toLocaleString()} ledger entr${totals.data.total === 1 ? 'y' : 'ies'}` : '…'}</span>
          <span>Net amount (reversals deducted): <strong>{money(totals.data?.netAmount)}</strong></span>
        </div>
        <PaymentsTable params={{ ...f, q, buildingId }} pageSize={25} key={JSON.stringify([f, q, buildingId])} />
      </Card>
    </div>
  );
}

// ───────────── Payment detail = receipt ─────────────

export function PaymentDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { can, me } = useAuth();
  const toast = useToast();
  const q = useApi(`/payments/${id}`);
  const [dialog, setDialog] = useState<'' | 'reverse' | 'ebm'>('');
  const [message, setMessage] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const verify = useAction(() => api.post(`/payments/${id}/verify`), 'Payment verified.');
  const reverse = useAction((reason: string) => api.post(`/payments/${id}/reverse`, { reason }), (r: any) => (r.executed ? 'Payment reversed.' : 'Reversal submitted for approval.'));
  const ebm = useAction((v: any) => api.patch(`/invoices/${q.data.invoice.id}`, v), 'Invoice updated.');
  const confirmMsg = useAction((channel: string) => api.post('/messages', { tenantId: q.data.tenant.id, paymentId: id, template: 'PAYMENT_CONFIRMATION', channel }));
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const p = q.data;
  const isReversal = p.type === 'REVERSAL';
  const reversed = p.status === 'REVERSED';
  const snap = p.receipt?.snapshot;
  const text = `Receipt ${p.receipt?.receiptNumber} — ${money(p.amount)} received from ${p.tenant.fullName} for Room ${p.room.number} (${p.building.name}) by ${p.method.name}${p.reference ? `, ref. ${p.reference}` : ''} on ${date(p.businessDate)}.`;
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      {params.get('recorded') && !reversed && (
        <Alert tone="green"><strong>PAYMENT SUCCESSFUL</strong> — receipt {p.receipt?.receiptNumber} for {money(p.amount)} has been issued.{p.replayed ? ' (This payment had already been saved; it was not recorded twice.)' : ''}</Alert>
      )}
      <PageHead title={isReversal ? 'Reversal entry' : <>Receipt {p.receipt?.receiptNumber}</>} sub={<>{isReversal ? <Badge status="REVERSAL" /> : reversed ? <Badge status="REVERSED" /> : p.verifiedAt ? <Badge status="VERIFIED" /> : <Badge status="PENDING" text="Awaiting verification" />} · recorded {dateTime(p.createdAt)} by {p.recordedBy.fullName}</>}>
        {!isReversal && <>
          <Button variant="primary" onClick={() => window.print()}>Print receipt</Button>
          <a className="btn" href={api.url(`/payments/${id}/receipt.pdf`, { download: 1 })}>Download PDF</a>
          <Button onClick={async () => { await navigator.clipboard.writeText(text); toast('Payment information copied.'); }}>Copy payment information</Button>
          {!reversed && can('payment.verify') && !p.verifiedAt && <Button onClick={() => verify.mutate(undefined as never, { onError: setError })}>Verify</Button>}
          {!reversed && can('payment.reverse.request') && !p.pendingReversal && <Button variant="danger" onClick={() => setDialog('reverse')}>Reverse…</Button>}
        </>}
      </PageHead>
      <ErrorBox error={error} />
      {reversed && <Alert><strong>This payment was reversed</strong>{p.reversedBy ? <> on {dateTime(p.reversedBy.paidAt)} by {p.reversedBy.recordedBy.fullName}: {p.reversedBy.reason}. <Link to={`/payments/${p.reversedBy.id}`}>View reversal entry</Link></> : '.'} The receipt is void.</Alert>}
      {isReversal && <Alert tone="amber">This entry reverses <Link to={`/payments/${p.reverses?.id}`}>receipt {p.reverses?.receipt?.receiptNumber}</Link>. Reason: {p.reason}</Alert>}
      {p.pendingReversal && <Alert tone="amber">A reversal has been requested and is awaiting approval: “{p.pendingReversal.reason}”. {can('approval.decide') && <Link to="/approvals">Review in Approvals</Link>}</Alert>}

      <Card>
        <div className="stack">
          <div className="print-only"><h1>{me?.organization.name}</h1><p>RENT PAYMENT RECEIPT {reversed ? '— VOID' : ''}</p>{me?.organization.isDemo && <p><strong>DEMO DATA — not a real receipt</strong></p>}</div>
          <div className="grid c2">
            <DL items={[
              ['Receipt number', p.receipt?.receiptNumber ?? '—'], ['Tenant', <Link to={`/tenants/${p.tenant.id}`}>{p.tenant.fullName}</Link>], ['Room', <Link to={`/rooms/${p.room.id}`}>{p.room.number}</Link>],
              ['Building', `${p.building.name} · ${p.floor.name}`], ['Contract', <Link to={`/contracts/${p.contract.id}`}>{p.contract.contractNumber}</Link>],
            ]} />
            <DL items={[
              ['Amount', <span className="big-amount">{money(p.amount)}</span>], ['Payment method', p.method.name], ['Reference', p.reference ?? '—'], ['Date', date(p.businessDate)],
              ['Verified by', p.verifiedBy ? `${p.verifiedBy.fullName} · ${dateTime(p.verifiedAt)}` : 'Not yet verified'],
            ]} />
          </div>
          <h3>Applied to</h3>
          <Table rows={p.allocations} empty={<Empty title="Not applied to any month">The whole amount is held as advance credit.</Empty>} columns={[
            { header: 'Billing month', cell: (a: any) => month(a.rentCharge.period) }, { header: 'Applied', num: true, cell: (a: any) => money(a.amount) },
            { header: 'Month balance now', num: true, cell: (a: any) => money(a.rentCharge.balance) }, { header: 'Month status', cell: (a: any) => <Badge status={a.rentCharge.status} /> },
          ]} foot={<tr><td>Allocated to rent</td><td className="num">{money(p.allocatedAmount)}</td><td colSpan={2}>{Number(p.unallocatedAmount) !== 0 && <>Advance credit not yet applied: {money(p.unallocatedAmount)}</>}</td></tr>} />
          {snap && !isReversal && <p className="muted small">At the time of payment the remaining balance was {money(snap.outstandingAfter)}.</p>}
          {p.notes && <DL items={[['Notes', p.notes]]} />}
        </div>
      </Card>

      {!isReversal && p.invoice && (
        <Card title="Invoice / EBM" actions={can('invoice.manage') && !reversed ? <Button size="sm" onClick={() => setDialog('ebm')}>Update EBM reference</Button> : undefined}>
          <DL items={[['Invoice number', p.invoice.invoiceNumber], ['Status', <Badge status={p.invoice.status} />], ['EBM reference', p.invoice.ebmReference ?? <span className="muted">Not recorded yet</span>]]} />
        </Card>
      )}
      {!isReversal && !reversed && can('message.create') && (
        <Card title="Payment confirmation message">
          <div className="stack tight no-print">
            <div className="row"><Button onClick={async () => setMessage(await confirmMsg.mutateAsync('COPY'))}>Generate confirmation message</Button></div>
            {message && <div className="alert blue"><div className="grow stack tight"><div>{message.body}</div><div className="row"><Button size="sm" onClick={async () => { await navigator.clipboard.writeText(message.body); toast('Message copied.'); }}>Copy message</Button><span className="small">To: {message.phone}</span></div></div></div>}
            <p className="muted small">SMS and WhatsApp are not connected to this system; copy the message and send it from your phone.</p>
          </div>
        </Card>
      )}
      <div className="no-print stack">
        <Card title="Payment evidence"><DocumentsPanel entityType="Payment" entityId={id} defaultCategory="PAYMENT_EVIDENCE" /></Card>
        <Card title="History"><TimelinePanel entityType="Payment" entityId={id} /></Card>
      </div>

      {dialog === 'reverse' && (
        <Confirm title="Reverse this payment?" danger confirmLabel={can('approval.decide') ? 'Reverse payment' : 'Request reversal'} reason="Reason for the reversal (kept on record)" onClose={() => setDialog('')} onConfirm={(reason) => reverse.mutateAsync(reason)}>
          The original payment of {money(p.amount)} stays in the ledger and is marked reversed; a reversal entry is added, the months it paid become owing again, and the receipt is voided.
          {!can('approval.decide') && ' Your request will be sent to a manager for approval.'}
        </Confirm>
      )}
      {dialog === 'ebm' && (
        <Modal title="Update invoice / EBM" onClose={() => setDialog('')}>
          <AutoForm onCancel={() => setDialog('')} initial={{ ebmReference: p.invoice.ebmReference ?? '', status: p.invoice.status === 'PENDING' ? 'ISSUED' : p.invoice.status, statusNote: '' }} fields={[
            { name: 'ebmReference', label: 'EBM reference / number', hint: 'As printed on the EBM invoice.' },
            { name: 'status', label: 'Status', type: 'select', required: true, options: enumOpts(['PENDING', 'GENERATED', 'ISSUED', 'FAILED', 'CANCELLED']) },
            { name: 'statusNote', label: 'Note (required for Failed / Cancelled)', full: true },
          ]} onSubmit={async (v) => { await ebm.mutateAsync(v); setDialog(''); }}>
            <p className="muted small">This system records the reference you enter. It is not connected to RRA/EBM and does not issue EBM invoices itself.</p>
          </AutoForm>
        </Modal>
      )}
    </div>
  );
}

// ───────────── Rent ledger ─────────────

/** The rent charges list; `owing` shows only rent that has fallen due and is not fully paid (Unpaid & overdue). */
export function Rent({ owing = false }: { owing?: boolean }) {
  const { can, buildingId } = useAuth();
  const [params, setParams] = useSearchParams();
  const [waive, setWaive] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const f = { status: params.get('status') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '', overdueOnly: params.get('overdueOnly') ?? '', ...(owing ? { owingOnly: 'true' } : {}) };
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const run = useAction(() => api.post('/rent/generate'));
  const request = useAction((v: any) => api.post(`/rent/charges/${waive.id}/waive`, v), (r: any) => (r.executed ? 'Waiver approved and applied.' : 'Waiver submitted for approval.'));
  return (
    <div className="stack">
      {owing ? (
        <PageHead title="Unpaid & overdue" sub="Tenants whose rent has fallen due and is not fully paid. Unpaid: still within the grace period. Overdue: the grace period has passed. Partial: paid only part.">
          {/* The arrears report lists the same charges; the PDF follows the building, status and "overdue only" filters. */}
          {can('export.data') && can('report.financial') && (
            <a className="btn primary" href={api.url('/reports/arrears/export', { format: 'pdf', buildingId: buildingId || undefined, paymentStatus: f.status || undefined, overdueOnly: f.overdueOnly || undefined })}>Download PDF</a>
          )}
        </PageHead>
      ) : (
        <PageHead title="Rent" sub="Monthly rent charges for every contract. Click a month to see the payments behind it.">
          {can('rent.generate') && <Button busy={run.isPending} onClick={async () => setResult(await run.mutateAsync(undefined as never))}>Run billing now</Button>}
        </PageHead>
      )}
      {result && <Alert tone="blue">Billing run complete for {date(result.day)}: {result.chargesCreated} new charge(s), {result.newlyOverdue} newly overdue, {result.expiring + result.expired} contract status change(s). Billing also runs automatically every hour.</Alert>}
      <ErrorBox error={run.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <Select label="Status" value={f.status} onChange={(v) => set('status', v)} all={owing ? 'All unpaid & overdue' : 'All (except void)'} options={enumOpts(owing ? ['UNPAID', 'PARTIAL', 'OVERDUE'] : ['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED', 'VOID'])} />
          <Select label="Show" value={f.overdueOnly} onChange={(v) => set('overdueOnly', v)} all={owing ? 'Unpaid and overdue' : 'All charges'} options={[{ value: 'true', label: 'Overdue only' }]} />
          <TextInput label="From month" type="date" value={f.from} onChange={(v) => set('from', v ? `${v.slice(0, 7)}-01` : '')} /><TextInput label="To month" type="date" value={f.to} onChange={(v) => set('to', v)} />
        </div>
        <LedgerTable params={{ ...f, buildingId }} showTenant pageSize={25} key={JSON.stringify([f, buildingId])} onWaive={can('adjustment.request') ? setWaive : undefined} />
      </Card>
      {waive && (
        <Modal title={`Waive rent — ${waive.tenant.fullName}, ${month(waive.period)}`} onClose={() => setWaive(null)}>
          <AutoForm onCancel={() => setWaive(null)} submitLabel={can('approval.decide') ? 'Approve and waive' : 'Submit for approval'} initial={{ amount: Number(waive.balance) }} fields={[
            { name: 'amount', label: `Amount to waive (balance: ${money(waive.balance)})`, type: 'money', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true },
          ]} onSubmit={async (v) => { await request.mutateAsync(v); setWaive(null); }}>
            <p className="muted small">A waiver writes off debt without a payment. It needs approval and is recorded with the approver’s name.</p>
          </AutoForm>
        </Modal>
      )}
    </div>
  );
}

// ───────────── Invoices / EBM ─────────────

export function Invoices() {
  const { can, buildingId } = useAuth();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const q = useDebounced(search);
  const status = params.get('status') ?? '';
  const missing = params.get('missingEbm') === 'true';
  const list = useApi('/invoices', { q, status, missingEbm: missing || undefined, buildingId, page, pageSize: 25 });
  const save = useAction((v: any) => api.patch(`/invoices/${edit.id}`, v), 'Invoice updated.');
  useEffect(() => setPage(1), [q, status, missing, buildingId]);
  return (
    <div className="stack">
      <PageHead title="Invoices / EBM" sub="Tracks the EBM invoice reference for every rent payment. References are entered by staff; this system is not connected to RRA/EBM." />
      {list.data && list.data.missingEbm > 0 && (
        <Alert tone="amber"><strong>{list.data.missingEbm} payment{list.data.missingEbm === 1 ? ' has' : 's have'} no recorded EBM/invoice reference.</strong> {!missing && <Button size="sm" variant="ghost" onClick={() => setParams({ missingEbm: 'true' })}>Show them</Button>}</Alert>
      )}
      <div className="grid c4">
        {(list.data?.byStatus ?? []).map((s: any) => <Stat key={s.status} k={`${s.status.charAt(0)}${s.status.slice(1).toLowerCase()}`} v={s.count} s={money(s.amount)} />)}
      </div>
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Invoice number, EBM reference, receipt or tenant" />
          <Select label="Status" value={status} onChange={(v) => setParams(v ? { status: v } : {}, { replace: true })} all="All statuses" options={enumOpts(['PENDING', 'GENERATED', 'ISSUED', 'FAILED', 'CANCELLED'])} />
          <Select label="EBM reference" value={missing ? 'true' : ''} onChange={(v) => setParams(v ? { missingEbm: v } : {}, { replace: true })} all="Any" options={[{ value: 'true', label: 'Missing only' }]} />
        </div>
        <Table rows={list.data?.items} empty={<Empty title="No invoices found" />} columns={[
          { header: 'Invoice', cell: (i: any) => <span className="strong">{i.invoiceNumber}</span> }, { header: 'Date', cell: (i: any) => date(i.issueDate), hideSm: true },
          { header: 'Tenant', cell: (i: any) => <>{i.tenant.fullName}<div className="muted small">Room {i.payment.room.number} · {i.building.name}</div></> },
          { header: 'Payment', cell: (i: any) => <Link to={`/payments/${i.payment.id}`}>{i.payment.receipt?.receiptNumber}</Link> }, { header: 'Amount', num: true, cell: (i: any) => money(i.amount) },
          { header: 'EBM reference', cell: (i: any) => i.ebmReference ?? <span className="muted">—</span> }, { header: 'Status', cell: (i: any) => <Badge status={i.status} /> },
          { header: '', cell: (i: any) => can('invoice.manage') && i.status !== 'CANCELLED' ? <Button size="sm" onClick={() => setEdit(i)}>Update</Button> : null },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
      {edit && (
        <Modal title={`Update ${edit.invoiceNumber}`} onClose={() => setEdit(null)}>
          <AutoForm onCancel={() => setEdit(null)} initial={{ ebmReference: edit.ebmReference ?? '', status: edit.status === 'PENDING' ? 'ISSUED' : edit.status, statusNote: edit.statusNote ?? '' }} fields={[
            { name: 'ebmReference', label: 'EBM reference / number' }, { name: 'status', label: 'Status', type: 'select', required: true, options: enumOpts(['PENDING', 'GENERATED', 'ISSUED', 'FAILED', 'CANCELLED']) },
            { name: 'statusNote', label: 'Note (required for Failed / Cancelled)', full: true },
          ]} onSubmit={async (v) => { await save.mutateAsync(v); setEdit(null); }}>
            <p className="muted small">{edit.tenant.fullName} · {money(edit.amount)} · {isoDay(edit.issueDate)}</p>
          </AutoForm>
        </Modal>
      )}
    </div>
  );
}

// ───────────── Security deposits ─────────────

export function Deposits() {
  const { buildingId } = useAuth();
  const navigate = useNavigate();
  const [onlyHeld, setOnlyHeld] = useState('true');
  const q = useApi('/deposits', { buildingId, onlyHeld: onlyHeld === 'true' || undefined });
  const rows: any[] | undefined = q.data?.items;
  const total = (rows ?? []).reduce((a, r) => a + Number(r.held), 0);
  return (
    <div className="stack">
      <PageHead title="Security deposits" sub="Deposits held for tenants. Kept apart from rent and never counted as income." />
      <ErrorBox error={q.error} />
      <div className="grid c3"><Stat k="Total deposits held" v={money(total)} s={`${rows?.filter((r) => Number(r.held) > 0).length ?? 0} contract(s)`} /></div>
      <Card pad={false}>
        <div className="filters no-print"><Select label="Show" value={onlyHeld} onChange={setOnlyHeld} options={[{ value: 'true', label: 'Deposits currently held' }, { value: 'false', label: 'All contracts with a deposit' }]} /></div>
        <Table rows={rows} onRow={(r: any) => navigate(`/contracts/${r.id}`)} empty={<Empty title="No deposits" />} columns={[
          { header: 'Tenant', cell: (r: any) => r.tenant.fullName }, { header: 'Room', cell: (r: any) => `${r.room.number} · ${r.building.name}` }, { header: 'Contract', cell: (r: any) => <>{r.contractNumber} <Badge status={r.status} /></>, hideSm: true },
          { header: 'Required', num: true, cell: (r: any) => money(r.depositAmount) }, { header: 'Paid', num: true, cell: (r: any) => money(r.paid), hideSm: true },
          { header: 'Deducted', num: true, cell: (r: any) => money(r.deducted), hideSm: true }, { header: 'Refunded', num: true, cell: (r: any) => money(r.refunded), hideSm: true }, { header: 'Held', num: true, cell: (r: any) => <strong>{money(r.held)}</strong> },
        ]} foot={<tr><td colSpan={7}>Total held</td><td className="num">{money(total)}</td></tr>} />
      </Card>
    </div>
  );
}
