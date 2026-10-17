import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useMeta } from '../auth';
import { date, money } from '../format';
import { DocumentsPanel, DownloadButton, LedgerTable, PaymentsTable, TimelinePanel, useAction, useApi } from '../shared';
import { Alert, AutoForm, Badge, Button, Card, Confirm, DL, Empty, enumOpts, ErrorBox, Loading, Modal, opts, PageHead, Pager, Select, Stat, Table, Tabs, TextInput, useDebounced, useToast } from '../ui';

export function Contracts() {
  const { can, buildingId } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const status = params.get('status') ?? '';
  const q = useDebounced(search);
  // "Expiring" on the dashboard means expiring OR already expired; show both together.
  const list = useApi('/contracts', { q, buildingId, status: status === 'EXPIRING' ? undefined : status, page, pageSize: 25 });
  const expiring = useApi('/contracts', { q, buildingId, status: 'EXPIRING', pageSize: 100 }, status === 'EXPIRING');
  const expired = useApi('/contracts', { q, buildingId, status: 'EXPIRED', pageSize: 100 }, status === 'EXPIRING');
  useEffect(() => setPage(1), [q, status, buildingId]);
  const rows = status === 'EXPIRING' ? (expiring.data && expired.data ? [...expired.data.items, ...expiring.data.items] : undefined) : list.data?.items;
  return (
    <div className="stack">
      <PageHead title="Contracts" sub="Every occupancy is based on a contract. Contracts are terminated or renewed, never deleted.">
        {can('contract.manage') && <Link to="/contracts/new" className="btn primary">Create contract</Link>}
      </PageHead>
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Contract number, tenant or room" />
          <Select label="Status" value={status} onChange={(v) => setParams(v ? { status: v } : {}, { replace: true })} all="All statuses"
            options={[{ value: 'OCCUPYING', label: 'Current (active, expiring, expired)' }, { value: 'EXPIRING', label: 'Expiring or expired' }, ...enumOpts(['DRAFT', 'ACTIVE', 'TERMINATED', 'RENEWED'])]} />
        </div>
        <Table rows={rows} onRow={(c: any) => navigate(`/contracts/${c.id}`)} empty={<Empty title="No contracts found" />} columns={[
          { header: 'Contract', cell: (c: any) => <span className="strong">{c.contractNumber}</span> }, { header: 'Tenant', cell: (c: any) => c.tenant.fullName },
          { header: 'Room', cell: (c: any) => <>{c.room.number}<span className="muted small"> · {c.building.name}</span></> },
          { header: 'Start', cell: (c: any) => date(c.startDate), hideSm: true }, { header: 'End', cell: (c: any) => date(c.terminatedOn ?? c.endDate) },
          { header: 'Monthly rent', num: true, cell: (c: any) => money(c.monthlyRent), hideSm: true }, { header: 'Outstanding', num: true, cell: (c: any) => money(c.outstanding) },
          { header: 'Status', cell: (c: any) => <Badge status={c.status} /> },
          { header: 'Contract', cell: (c: any) => c.renewedTo ? <Link className="btn sm" to={`/contracts/${c.renewedTo.id}`} onClick={(e) => e.stopPropagation()} title={`Renewed — the current contract is ${c.renewedTo.contractNumber}`}>→ {c.renewedTo.contractNumber}</Link> : !c.building.contractTemplate ? <span className="muted small" title={`No lease contract has been set up for ${c.building.name} yet`}>No contract yet</span> : <DownloadButton size="sm" path={`/contracts/${c.id}/document`} params={{ format: 'pdf' }} busyLabel="PDF…" title={`Download contract ${c.contractNumber} as PDF`}>⬇ PDF</DownloadButton> },
        ]} />
        {status !== 'EXPIRING' && <Pager data={list.data} onPage={setPage} />}
      </Card>
    </div>
  );
}

type Tab = 'overview' | 'ledger' | 'payments' | 'deposit' | 'documents' | 'history';
type Dialog = '' | 'terminate' | 'renew' | 'rent' | 'adjust' | 'deposit' | 'deduct' | 'refund' | 'activate' | 'discard' | 'terms' | 'dates';

export function ContractDetail() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const toast = useToast();
  const q = useApi(`/contracts/${id}`);
  const [tab, setTab] = useState<Tab>('overview');
  const [dialog, setDialog] = useState<Dialog>('');
  const today = me!.organization.today;
  const post = (path: string, msg: string | ((r: any) => string)) => useAction((v: any) => api.post(`/contracts/${id}${path}`, v), msg);
  const approvalMsg = (done: string) => (r: any) => (r.executed ? done : 'Request submitted for approval.');
  const terminate = post('/terminate', 'Contract terminated. The room is now available.');
  const renew = useAction((v: any) => api.post(`/contracts/${id}/renew`, v));
  const rentChange = post('/rent', 'Rent change recorded.');
  const adjust = post('/adjustments', approvalMsg('Adjustment approved and applied.'));
  const deposit = post('/deposits', 'Deposit recorded.');
  const deduct = post('/deposits/deduction', 'Deduction recorded.');
  const refund = post('/deposits/refund', approvalMsg('Refund approved and recorded.'));
  const activate = post('/activate', 'Contract activated.');
  const terms = useAction((v: any) => api.patch(`/contracts/${id}`, v), 'Contract terms updated.');
  const dates = post('/dates', 'Contract dates corrected. Rent is now counted from the new start date.');
  const discard = useAction(() => api.del(`/contracts/${id}`), 'Draft discarded.');
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const c = q.data;
  const occupying = ['ACTIVE', 'EXPIRING', 'EXPIRED'].includes(c.status);
  const s = c.summary;
  const methods = opts(meta.data?.paymentMethods?.filter((m: any) => m.isActive));
  const nextMonth = `${today.slice(0, 7) === `${today.slice(0, 4)}-12` ? `${Number(today.slice(0, 4)) + 1}-01` : `${today.slice(0, 4)}-${String(Number(today.slice(5, 7)) + 1).padStart(2, '0')}`}-01`;
  const close = () => setDialog('');
  return (
    <div className="stack">
      <PageHead title={<>{c.contractNumber} <Badge status={c.status} /></>} sub={<><Link to={`/tenants/${c.tenant.id}`}>{c.tenant.fullName}</Link> · Room <Link to={`/rooms/${c.room.id}`}>{c.room.number}</Link> · {c.floor.name}, {c.building.name}</>}>
        {c.renewedTo && <Link className="btn primary" to={`/contracts/${c.renewedTo.id}`}>Go to current contract {c.renewedTo.contractNumber}</Link>}
        {c.building.contractTemplate && <>
          <DownloadButton variant={c.renewedTo ? undefined : 'primary'} path={`/contracts/${c.id}/document`} params={{ format: 'pdf' }} busyLabel="Preparing PDF…" title={`The ${c.building.name} lease contract, filled with this tenant’s details, ready to print and sign`}>{c.renewedTo ? '⬇ Old contract (PDF)' : '⬇ Download contract (PDF)'}</DownloadButton>
          <DownloadButton path={`/contracts/${c.id}/document`} params={{ format: 'docx' }} title="Same contract as a Word file you can edit before printing">Word</DownloadButton>
        </>}
        {c.status !== 'DRAFT' && can('payment.create') && <Link className="btn" to={`/payments/new?contractId=${c.id}`}>Record payment</Link>}

        {c.status === 'DRAFT' && can('contract.manage') && <><Button variant="primary" onClick={() => setDialog('activate')}>Activate</Button><Button onClick={() => setDialog('discard')}>Discard draft</Button></>}
        {occupying && can('contract.manage') && <Button onClick={() => setDialog('renew')}>Renew</Button>}
        {occupying && can('contract.manage') && <Button onClick={() => setDialog('dates')} title="Set the day the tenant really started working; rent is counted again from that day">Correct dates</Button>}
        {occupying && can('room.rent.manage') && <Button onClick={() => setDialog('rent')}>Change rent</Button>}
        {occupying && can('adjustment.request') && <Button onClick={() => setDialog('adjust')}>Discount / surcharge</Button>}
        {occupying && can('contract.manage') && <Button onClick={() => setDialog('terms')}>Edit terms</Button>}
        {occupying && can('contract.terminate') && <Button variant="danger" onClick={() => setDialog('terminate')}>Terminate</Button>}
      </PageHead>
      {!c.building.contractTemplate && <Alert>No lease contract has been set up for <strong>{c.building.name}</strong> yet, so no contract can be printed for this tenant. Each building uses its own contract — the contract of another building is never given. Once {c.building.name}’s contract is added, choose it under <Link to="/buildings">Buildings</Link> → Edit {c.building.name} → Lease contract.</Alert>}
      {c.building.contractTemplate && (() => { const b = c.building; const gaps = [['company name', b.companyName], ['manager', b.managerName], ['TIN', b.tin], ['phone', b.phone], ['e-mail', b.email], ['bank', b.bankName], ['bank account', b.bankAccount], ['UPI', b.upi], ['district', b.district], ['sector', b.sector], ['cell', b.cell], ['village', b.village]].filter(([, v]) => !v).map(([k]) => k); return gaps.length ? <Alert tone="blue">{b.name} has no {gaps.join(', ')} yet, so the contract will show dotted lines for the landlord’s {gaps.length === 1 ? 'detail' : 'details'}. Add them under <Link to="/buildings">Buildings</Link> → Edit {b.name}.</Alert> : null; })()}
      {c.building.contractTemplate && (() => { const t = c.tenant; const gaps = [['District', t.district], ['Sector', t.sector], ['Cell', t.cell], ['Village', t.village], ['TIN', t.tin], ['E-mail', t.email]].filter(([, v]) => !v).map(([k]) => k); return gaps.length ? <Alert tone="blue">The printed contract will have blank lines (to fill by hand) for the tenant’s: {gaps.join(', ')}. To print them instead, <Link to={`/tenants/${t.id}`}>edit the tenant</Link> first.</Alert> : null; })()}
      {c.renewedTo && <Alert tone="blue">This contract was renewed as <Link to={`/contracts/${c.renewedTo.id}`}>{c.renewedTo.contractNumber}</Link>. It is closed and keeps its old dates ({date(c.startDate)} – {date(c.endDate)}). To print the contract with the new dates, open {c.renewedTo.contractNumber} and download it there.</Alert>}
      {c.status === 'EXPIRED' && <Alert>This contract ended on {date(c.endDate)} but the tenant has not moved out. No further rent is being billed. Renew the contract or record the move-out.</Alert>}
      {c.status === 'EXPIRING' && <Alert tone="amber">This contract ends on {date(c.endDate)}. Renew it or prepare the move-out.</Alert>}
      {c.status === 'TERMINATED' && Number(s.credit) > 0 && <Alert tone="amber">This ended contract holds {money(s.credit)} of unused advance payment. Refund it to the tenant or reverse the payment, as appropriate.</Alert>}

      <div className="grid c4">
        <Stat k="Monthly rent" v={money(c.monthlyRent)} s={Number(c.roomRentAtSigning) !== Number(c.monthlyRent) ? `Room rent at signing: ${money(c.roomRentAtSigning)}` : 'Same as the room’s standard rent'} />
        <Stat k="Outstanding" v={<span style={{ color: Number(s.outstanding) > 0 ? 'var(--red)' : undefined }}>{money(s.outstanding)}</span>} s={`Charged ${money(s.totalCharged)} · paid ${money(s.totalPaid)}`} />
        <Stat k="Advance credit" v={money(s.credit)} s={Number(s.totalWaived) > 0 ? `Waived ${money(s.totalWaived)}` : undefined} />
        <Stat k="Deposit held" v={money(s.depositHeld)} s={`Required ${money(c.depositAmount)}`} />
      </div>

      <Card pad={false}>
        <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Overview'], ['ledger', 'Rent Ledger'], ['payments', 'Payments'], ['deposit', 'Deposit'], ['documents', 'Documents'], ['history', 'History']]} />
        {tab === 'overview' && (
          <div className="card-body grid c2">
            <div className="stack">
              <h3>Contract</h3>
              <DL items={[
                ['Contract number', c.contractNumber], ['Tenant', c.tenant.fullName], ['Building', c.building.name], ['Floor', c.floor.name], ['Room', c.room.number],
                ['Start date', date(c.startDate)], ['End date', date(c.endDate)], ['Rent due', `Day ${c.paymentDueDay} of the month · ${c.graceDays} day(s) grace`], ['Special terms', c.specialTerms || '—'],
                ...(c.rentOverrideReason ? [['Tenant-specific rent reason', c.rentOverrideReason] as [string, string]] : []),
                ...(c.renewedFrom ? [['Renewal of', <Link to={`/contracts/${c.renewedFrom.id}`}>{c.renewedFrom.contractNumber}</Link>] as [string, any]] : []),
                ...(c.renewedTo ? [['Renewed as', <Link to={`/contracts/${c.renewedTo.id}`}>{c.renewedTo.contractNumber}</Link>] as [string, any]] : []),
                ...(c.billingStart ? [['Billed in this system from', date(c.billingStart)] as [string, string]] : []),
                ['Created by', c.createdBy?.fullName ?? '—'],
              ]} />
              {c.status === 'TERMINATED' && <>
                <h3>Move-out</h3>
                <DL items={[['Move-out date', date(c.terminatedOn)], ['Reason', c.terminationReason], ['Room condition', c.roomCondition || '—'], ['Rent balance at move-out', money(c.finalBalance)]]} />
              </>}
            </div>
            <div className="stack">
              <h3>Rent history</h3>
              <Table rows={c.rentRates} columns={[
                { header: 'From', cell: (r: any) => date(r.effectiveFrom) }, { header: 'To', cell: (r: any) => (r.effectiveTo ? date(r.effectiveTo) : 'Present') },
                { header: 'Rent', num: true, cell: (r: any) => money(r.amount) }, { header: 'Reason', cell: (r: any) => <span className="small">{r.reason}</span>, hideSm: true },
              ]} empty={<Empty title="No rent recorded yet">Rent history starts when the contract is activated.</Empty>} />
              <h3>Discounts and surcharges</h3>
              <Table rows={c.adjustments} empty={<Empty title="None" />} columns={[
                { header: 'Type', cell: (a: any) => <Badge status={a.type === 'DISCOUNT' ? 'WAIVED' : 'PENDING'} text={a.type === 'DISCOUNT' ? 'Discount' : 'Surcharge'} /> }, { header: 'Per month', num: true, cell: (a: any) => money(a.amount) },
                { header: 'Period', cell: (a: any) => `${date(a.effectiveFrom)} – ${a.effectiveTo ? date(a.effectiveTo) : 'open'}` }, { header: 'Reason', cell: (a: any) => <span className="small">{a.reason}</span>, hideSm: true },
              ]} />
            </div>
          </div>
        )}
        {tab === 'ledger' && (can('rent.view') ? <LedgerTable params={{ contractId: id, dir: 'asc' }} pageSize={24} /> : <Empty title="You do not have access to the rent ledger" />)}
        {tab === 'payments' && (can('payment.view') ? <PaymentsTable params={{ contractId: id }} showTenant={false} /> : <Empty title="You do not have access to payments" />)}
        {tab === 'deposit' && (
          <div className="card-body stack">
            <div className="row between">
              <DL items={[['Required', money(c.depositAmount)], ['Held now', <strong>{money(s.depositHeld)}</strong>]]} />
              {can('deposit.manage') && c.status !== 'DRAFT' && (
                <div className="row">
                  <Button onClick={() => setDialog('deposit')}>Record deposit received</Button>
                  <Button onClick={() => setDialog('deduct')} disabled={Number(s.depositHeld) <= 0}>Deduction</Button>
                  <Button onClick={() => setDialog('refund')} disabled={Number(s.depositHeld) <= 0}>Refund</Button>
                </div>
              )}
            </div>
            <Table rows={can('deposit.view') ? c.deposits : []} empty={<Empty title="No deposit transactions" />} columns={[
              { header: 'No.', cell: (d: any) => d.number }, { header: 'Date', cell: (d: any) => date(d.txnDate) }, { header: 'Type', cell: (d: any) => <Badge status={d.type === 'PAYMENT' ? 'PAID' : d.type === 'REFUND' ? 'RENEWED' : 'PENDING'} text={d.type === 'PAYMENT' ? 'Received' : d.type === 'REFUND' ? 'Refunded' : d.type === 'DEDUCTION' ? 'Deduction' : 'Transfer'} /> },
              { header: 'Amount', num: true, cell: (d: any) => money(d.amount) }, { header: 'Details', cell: (d: any) => <span className="small">{[d.method?.name, d.reference, d.reason].filter(Boolean).join(' · ')}</span>, hideSm: true }, { header: 'By', cell: (d: any) => d.recordedBy.fullName, hideSm: true },
            ]} />
            <p className="muted small">Security deposits are a liability held for the tenant. They are tracked here and never counted as rental income.</p>
          </div>
        )}
        {tab === 'documents' && <div className="card-body"><DocumentsPanel entityType="Contract" entityId={id} defaultCategory="CONTRACT" /></div>}
        {tab === 'history' && <div className="card-body"><TimelinePanel entityType="Contract" entityId={id} /></div>}
      </Card>

      {dialog === 'terminate' && (
        <Modal title={`Terminate ${c.contractNumber} — move-out`} wide onClose={close}>
          <AutoForm danger submitLabel="Terminate contract" onCancel={close} initial={{ moveOutDate: today }} fields={[
            { name: 'moveOutDate', label: 'Move-out date', type: 'date', required: true, max: today, min: c.startDate.slice(0, 10) }, { name: 'reason', label: 'Reason', required: true },
            { name: 'roomCondition', label: 'Room condition at move-out', type: 'textarea' },
            { name: 'needsMaintenance', label: 'The room needs repairs before it can be let again', type: 'checkbox', full: true, hint: 'sets the room to Maintenance and opens a request' },
            { name: 'maintenanceNote', label: 'What needs to be repaired', type: 'textarea', when: (v) => v.needsMaintenance },
            ...(can('deposit.manage') && Number(s.depositHeld) > 0 ? [
              { name: 'depositDeduction', label: `Deduct from deposit (held: ${money(s.depositHeld)})`, type: 'money' as const },
              { name: 'deductionReason', label: 'Reason for deduction', when: (v: any) => Number(v.depositDeduction) > 0, required: true },
            ] : []),
          ]} onSubmit={async (v) => { await terminate.mutateAsync(v); close(); }}>
            <div className="alert amber"><div>
              <strong>Final rent balance: {money(s.outstanding)}.</strong> The tenant and all payment history are kept. Room {c.room.number} becomes available for a new tenant, months after the move-out are no longer billed, and any rent already paid for those months is held as credit.
              {Number(s.depositHeld) > 0 && <> The deposit ({money(s.depositHeld)}) is settled from the Deposit tab.</>}
            </div></div>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'dates' && (
        <Modal title={`Correct the dates of ${c.contractNumber}`} onClose={close}>
          <AutoForm submitLabel="Correct dates" onCancel={close} initial={{ startDate: c.startDate.slice(0, 10), endDate: c.endDate.slice(0, 10), reason: '' }} fields={[
            { name: 'startDate', label: 'Day the tenant starts working', type: 'date', required: true, hint: `Now ${date(c.startDate)}. Rent and Ingingo 8 of the contract are counted from this day.` },
            { name: 'endDate', label: 'End date', type: 'date', required: true, min: today, hint: `Now ${date(c.endDate)}. If you move the start, move the end too to keep the same length.` },
            { name: 'reason', label: 'Reason', required: true, full: true, placeholder: 'e.g. The tenant started working on 15 October' },
          ]} onSubmit={async (v) => { await dates.mutateAsync(v); close(); }}>
            <div className="alert blue"><div>Months before the new start date (or after the new end date) stop being billed, and anything already paid for them becomes credit that pays the next rent. A first month that starts mid-month is billed in full, or only for its days if “Bill a partial first or last month by days” is on in Settings. Payments and receipts are not changed.</div></div>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'renew' && (
        <Modal title={`Renew ${c.contractNumber}`} onClose={close}>
          <AutoForm submitLabel="Renew contract" onCancel={close} fields={[
            { name: 'endDate', label: 'New end date', type: 'date', required: true, min: c.endDate.slice(0, 10), hint: `The new contract starts the day after ${date(c.endDate)}.` },
            { name: 'monthlyRent', label: 'Monthly rent (RWF)', type: 'money', hint: `Leave empty to keep ${money(c.monthlyRent)}.` },
            { name: 'rentChangeReason', label: 'Reason for the rent change', when: (v) => v.monthlyRent !== '' && Number(v.monthlyRent) !== Number(c.monthlyRent), required: true, full: true },
            { name: 'specialTerms', label: 'Special terms', type: 'textarea', hint: 'Leave empty to carry over the current terms.' },
          ]} onSubmit={async (v) => {
            const renewed = await renew.mutateAsync({ ...v, monthlyRent: v.monthlyRent === '' ? undefined : v.monthlyRent });
            toast(`Renewed as ${renewed.contractNumber}.`);
            close();
            navigate(`/contracts/${renewed.id}`);
          }} />
        </Modal>
      )}
      {dialog === 'rent' && (
        <Modal title="Change contract rent" onClose={close}>
          <AutoForm submitLabel="Record rent change" onCancel={close} initial={{ effectiveFrom: nextMonth }} fields={[
            { name: 'amount', label: 'New monthly rent (RWF)', type: 'money', required: true, hint: `Current: ${money(c.monthlyRent)}` },
            { name: 'effectiveFrom', label: 'Effective from (first day of a month)', type: 'date', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true },
          ]} onSubmit={async (v) => { await rentChange.mutateAsync(v); close(); }}>
            <div className="alert blue"><div>Months already billed keep their amount. The new rent applies to charges from the effective date onward, and the old rate stays in the rent history.</div></div>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'adjust' && (
        <Modal title="Request a rent discount or surcharge" onClose={close}>
          <AutoForm submitLabel={can('approval.decide') ? 'Approve and apply' : 'Submit for approval'} onCancel={close} initial={{ type: 'DISCOUNT', effectiveFrom: `${today.slice(0, 8)}01` }} fields={[
            { name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'DISCOUNT', label: 'Discount (reduces rent)' }, { value: 'SURCHARGE', label: 'Surcharge (increases rent)' }] },
            { name: 'amount', label: 'Amount per month (RWF)', type: 'money', required: true }, { name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true },
            { name: 'effectiveTo', label: 'Until (optional)', type: 'date' }, { name: 'reason', label: 'Reason', type: 'textarea', required: true },
          ]} onSubmit={async (v) => { await adjust.mutateAsync(v); close(); }}>
            <p className="muted small">The contract rent ({money(c.monthlyRent)}) is not changed. The adjustment is recorded separately with its reason and approver.</p>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'deposit' && (
        <Modal title="Record deposit received" onClose={close}>
          <AutoForm submitLabel="Record deposit" onCancel={close} initial={{ amount: Math.max(0, Number(c.depositAmount) - Number(s.depositHeld)), txnDate: today }} fields={[
            { name: 'amount', label: 'Amount (RWF)', type: 'money', required: true }, { name: 'txnDate', label: 'Date received', type: 'date', required: true, max: today },
            { name: 'methodId', label: 'Payment method', type: 'select', options: methods, required: true }, { name: 'reference', label: 'Transaction reference' },
          ]} onSubmit={async (v) => { await deposit.mutateAsync(v); close(); }} />
        </Modal>
      )}
      {dialog === 'deduct' && (
        <Modal title="Deduct from deposit" onClose={close}>
          <AutoForm submitLabel="Record deduction" onCancel={close} fields={[{ name: 'amount', label: `Amount (held: ${money(s.depositHeld)})`, type: 'money', required: true }, { name: 'reason', label: 'Reason (e.g. damage, unpaid rent)', type: 'textarea', required: true }]}
            onSubmit={async (v) => { await deduct.mutateAsync(v); close(); }} />
        </Modal>
      )}
      {dialog === 'refund' && (
        <Modal title="Refund deposit" onClose={close}>
          <AutoForm submitLabel={can('approval.decide') ? 'Approve and record refund' : 'Submit refund for approval'} onCancel={close} initial={{ amount: Number(s.depositHeld) }} fields={[
            { name: 'amount', label: `Refund amount (held: ${money(s.depositHeld)})`, type: 'money', required: true }, { name: 'methodId', label: 'Paid out by', type: 'select', options: methods },
            { name: 'reference', label: 'Reference' }, { name: 'reason', label: 'Reason', type: 'textarea', required: true },
          ]} onSubmit={async (v) => { await refund.mutateAsync(v); close(); }} />
        </Modal>
      )}
      {dialog === 'terms' && (
        <Modal title="Edit contract terms" onClose={close}>
          <AutoForm onCancel={close} initial={{ paymentDueDay: c.paymentDueDay, graceDays: c.graceDays, specialTerms: c.specialTerms ?? '' }} fields={[
            { name: 'paymentDueDay', label: 'Rent due on day of month', type: 'number', required: true }, { name: 'graceDays', label: 'Grace period (days)', type: 'number', required: true }, { name: 'specialTerms', label: 'Special terms', type: 'textarea' },
          ]} onSubmit={async (v) => { await terms.mutateAsync(v); close(); }}>
            <p className="muted small">Due day and grace period apply to months billed from now on. Dates and rent are changed through Renew, Terminate and Change rent.</p>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'activate' && <Confirm title="Activate this contract?" confirmLabel="Activate" onClose={close} onConfirm={() => activate.mutateAsync({})}>Room {c.room.number} will be marked Occupied and rent will be billed from {date(c.startDate)}.</Confirm>}
      {dialog === 'discard' && <Confirm title="Discard this draft?" confirmLabel="Discard draft" danger onClose={close} onConfirm={async () => { await discard.mutateAsync(undefined as never); navigate('/contracts'); }}>The draft has no financial records and will be removed.</Confirm>}
    </div>
  );
}
