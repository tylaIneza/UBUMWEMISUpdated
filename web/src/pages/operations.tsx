import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useMeta } from '../auth';
import { date, dateTime, label, money } from '../format';
import { DocumentsPanel, TimelinePanel, useAction, useApi } from '../shared';
import { AutoForm, Badge, Button, Card, Confirm, DL, Empty, enumOpts, ErrorBox, Modal, opts, PageHead, Pager, Select, Stat, Table, Tabs, TextInput, useDebounced, type FieldDef } from '../ui';

function usePlaces(buildingId: string) {
  const floors = useApi('/floors', { buildingId }, Boolean(buildingId));
  const rooms = useApi('/rooms', { buildingId, pageSize: 200 }, Boolean(buildingId));
  return {
    floors: (floors.data?.items ?? []).map((f: any) => ({ value: f.id, label: f.name })),
    rooms: (rooms.data?.items ?? []).map((r: any) => ({ value: r.id, label: `${r.number} — ${r.floor.name}` })),
  };
}

// ───────────── Expenses ─────────────

export function Expenses() {
  const { can, buildingId, me } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [form, setForm] = useState<any>(params.get('new') === '1' ? { maintenanceRequestId: params.get('maintenanceRequestId') ?? '', buildingId: params.get('buildingId') ?? buildingId, roomId: params.get('roomId') ?? '' } : null);
  const [formBuilding, setFormBuilding] = useState(form?.buildingId ?? buildingId);
  const [view, setView] = useState<any>(null);
  const [decide, setDecide] = useState<{ expense: any; decision: 'APPROVED' | 'REJECTED' | 'VOID' } | null>(null);
  const f = { status: params.get('status') ?? '', categoryId: params.get('categoryId') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('new'); setParams(p, { replace: true }); };
  const list = useApi('/expenses', { ...f, q, buildingId, page, pageSize: 25 });
  const places = usePlaces(formBuilding);
  const openMaint = useApi('/maintenance', { status: 'OPEN', buildingId: formBuilding, pageSize: 100 }, Boolean(form) && can('maintenance.view'));
  const today = me!.organization.today;
  const create = useAction((v: any) => api.post('/expenses', v), (e: any) => `Expense ${e.number} recorded and sent for approval.`);
  const decision = useAction((v: { id: string; decision: string; note: string }) => api.post(`/expenses/${v.id}/decision`, { decision: v.decision, note: v.note }), 'Expense updated.');
  useEffect(() => setPage(1), [q, buildingId, f.status, f.categoryId, f.from, f.to]);

  const fields: FieldDef[] = [
    { name: 'scope', label: 'This expense belongs to', type: 'select', required: true, options: [{ value: 'BUILDING', label: 'A building' }, { value: 'FLOOR', label: 'A floor' }, { value: 'ROOM', label: 'A room' }, { value: 'ORGANIZATION', label: 'The whole organization' }] },
    { name: 'buildingId', label: 'Building', type: 'select', options: opts(meta.data?.buildings), required: true, when: (v) => v.scope !== 'ORGANIZATION' },
    { name: 'floorId', label: 'Floor', type: 'select', options: places.floors, required: true, when: (v) => v.scope === 'FLOOR' },
    { name: 'roomId', label: 'Room', type: 'select', options: places.rooms, required: true, when: (v) => v.scope === 'ROOM' },
    { name: 'categoryId', label: 'Category', type: 'select', options: opts(meta.data?.expenseCategories?.filter((c: any) => c.isActive)), required: true },
    { name: 'amount', label: 'Amount (RWF)', type: 'money', required: true }, { name: 'expenseDate', label: 'Date', type: 'date', required: true, max: today },
    { name: 'methodId', label: 'Paid by', type: 'select', options: opts(meta.data?.paymentMethods?.filter((m: any) => m.isActive)) },
    { name: 'supplier', label: 'Supplier' }, { name: 'reference', label: 'Reference / voucher no.' },
    { name: 'maintenanceRequestId', label: 'Linked maintenance request', type: 'select', placeholder: 'None', options: (openMaint.data?.items ?? []).map((m: any) => ({ value: m.id, label: `${m.number} — ${m.title}` })), when: (v) => v.scope !== 'ORGANIZATION', hint: 'Links this cost to the repair so it shows in maintenance reports.' },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
  ];

  return (
    <div className="stack">
      <PageHead title="Expenses" sub="Costs by building, floor, room or organization-wide. Only approved expenses count in reports.">
        {can('expense.create') && <Button variant="primary" onClick={() => { setForm({}); setFormBuilding(buildingId); }}>Add expense</Button>}
      </PageHead>
      <ErrorBox error={list.error} />
      <div className="grid c3"><Stat k="Approved expenses (current filters)" v={money(list.data?.approvedTotal)} s={`${list.data?.total ?? 0} entries listed`} /></div>
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Description, supplier, number or reference" />
          <Select label="Category" value={f.categoryId} onChange={(v) => set('categoryId', v)} all="All categories" options={opts(meta.data?.expenseCategories)} />
          <Select label="Status" value={f.status} onChange={(v) => set('status', v)} all="All statuses" options={enumOpts(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'VOID'])} />
          <TextInput label="From" type="date" value={f.from} onChange={(v) => set('from', v)} /><TextInput label="To" type="date" value={f.to} onChange={(v) => set('to', v)} />
        </div>
        <Table rows={list.data?.items} onRow={setView} empty={<Empty title="No expenses found" />} columns={[
          { header: 'Date', cell: (e: any) => <span className="nowrap">{date(e.expenseDate)}</span> }, { header: 'No.', cell: (e: any) => e.number, hideSm: true },
          { header: 'Description', cell: (e: any) => <>{e.description}<div className="muted small">{e.category.name}{e.supplier ? ` · ${e.supplier}` : ''}{e.maintenance ? ` · ${e.maintenance.number}` : ''}</div></> },
          { header: 'Belongs to', hideSm: true, cell: (e: any) => e.scope === 'ORGANIZATION' ? 'Organization-wide' : [e.building?.name, e.floor?.name, e.room && `Room ${e.room.number}`].filter(Boolean).join(' · ') },
          { header: 'Amount', num: true, cell: (e: any) => <strong>{money(e.amount)}</strong> }, { header: 'Status', cell: (e: any) => <Badge status={e.status} text={e.status === 'SUBMITTED' ? 'Awaiting approval' : undefined} /> },
          { header: '', cell: (e: any) => can('expense.approve') && e.status === 'SUBMITTED' ? (
            <div className="row end" onClick={(ev) => ev.stopPropagation()}>
              <Button size="sm" variant="primary" onClick={() => setDecide({ expense: e, decision: 'APPROVED' })}>Approve</Button><Button size="sm" onClick={() => setDecide({ expense: e, decision: 'REJECTED' })}>Reject</Button>
            </div>) : null },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>

      {form && (
        <Modal title="Add expense" wide onClose={() => setForm(null)}>
          <AutoForm fields={fields} submitLabel="Record expense" onCancel={() => setForm(null)} onChange={(v) => setFormBuilding(v.buildingId)}
            initial={{ scope: form.roomId ? 'ROOM' : 'BUILDING', buildingId: form.buildingId ?? buildingId, roomId: form.roomId ?? '', expenseDate: today, maintenanceRequestId: form.maintenanceRequestId ?? '' }}
            onSubmit={async (v) => { await create.mutateAsync(v); setForm(null); }}>
            <p className="muted small">The expense is submitted for approval. It is counted in reports once a manager approves it. Receipts can be attached after saving.</p>
          </AutoForm>
        </Modal>
      )}
      {view && (
        <Modal title={`Expense ${view.number}`} wide onClose={() => setView(null)} footer={<>
          {can('expense.approve') && view.status === 'APPROVED' && <Button variant="danger" onClick={() => { setDecide({ expense: view, decision: 'VOID' }); setView(null); }}>Void…</Button>}
          <Button onClick={() => setView(null)}>Close</Button>
        </>}>
          <div className="stack">
            <DL items={[
              ['Status', <Badge status={view.status} />], ['Amount', <strong>{money(view.amount)}</strong>], ['Date', date(view.expenseDate)], ['Category', view.category.name], ['Description', view.description],
              ['Belongs to', view.scope === 'ORGANIZATION' ? 'Organization-wide' : [view.building?.name, view.floor?.name, view.room && `Room ${view.room.number}`].filter(Boolean).join(' · ')],
              ['Supplier', view.supplier ?? '—'], ['Paid by', view.method?.name ?? '—'], ['Reference', view.reference ?? '—'], ['Maintenance request', view.maintenance ? `${view.maintenance.number} — ${view.maintenance.title}` : '—'],
              ['Recorded by', view.recordedBy.fullName], [view.status === 'REJECTED' ? 'Rejected by' : 'Approved by', view.approvedBy ? `${view.approvedBy.fullName} · ${dateTime(view.decidedAt)}` : '—'], ['Decision note', view.decisionNote ?? '—'],
            ]} />
            <h3>Receipt / evidence</h3>
            <DocumentsPanel entityType="Expense" entityId={view.id} defaultCategory="RECEIPT" />
          </div>
        </Modal>
      )}
      {decide && (
        <Confirm title={`${decide.decision === 'APPROVED' ? 'Approve' : decide.decision === 'REJECTED' ? 'Reject' : 'Void'} expense ${decide.expense.number}?`} danger={decide.decision !== 'APPROVED'}
          confirmLabel={decide.decision === 'APPROVED' ? 'Approve expense' : decide.decision === 'REJECTED' ? 'Reject expense' : 'Void expense'} reason={decide.decision === 'APPROVED' ? undefined : 'Reason'}
          onClose={() => setDecide(null)} onConfirm={(note) => decision.mutateAsync({ id: decide.expense.id, decision: decide.decision, note })}>
          {money(decide.expense.amount)} — {decide.expense.description}. {decide.decision === 'APPROVED' ? 'It will be counted in expense and profitability reports.' : decide.decision === 'VOID' ? 'It will be removed from report totals; the record itself is kept.' : 'The person who recorded it will be notified.'}
        </Confirm>
      )}
    </div>
  );
}

// ───────────── Maintenance ─────────────

const NEXT: Record<string, string[]> = { REPORTED: ['APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'CANCELLED'], APPROVED: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'], ASSIGNED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'], IN_PROGRESS: ['COMPLETED', 'CANCELLED'] };

function MaintenanceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const q = useApi(`/maintenance/${id}`);
  const staff = useApi('/staff');
  const [tab, setTab] = useState<'details' | 'update' | 'documents' | 'history'>('details');
  const update = useAction((v: any) => api.patch(`/maintenance/${id}`, v), 'Maintenance request updated.');
  const m = q.data;
  const closed = m && ['COMPLETED', 'CANCELLED'].includes(m.status);
  return (
    <Modal title={m ? `${m.number} — ${m.title}` : 'Maintenance request'} wide onClose={onClose}>
      <ErrorBox error={q.error} />
      {m && (
        <div className="stack">
          <Tabs value={tab} onChange={setTab} tabs={[['details', 'Details'], ...(can('maintenance.manage') && !closed ? [['update', 'Update'] as ['update', string]] : []), ['documents', 'Photos & documents'], ['history', 'History']]} />
          {tab === 'details' && (
            <>
              <DL items={[
                ['Status', <Badge status={m.status} />], ['Priority', <Badge status={m.priority} />], ['Building', m.building.name], ['Floor', m.floor?.name ?? '—'], ['Room', m.room ? <Link to={`/rooms/${m.room.id}`}>{m.room.number}</Link> : '—'],
                ['Description', m.description ?? '—'], ['Reported', `${date(m.reportedOn)} by ${m.reportedBy.fullName}`], ['Assigned to', m.assignedTo?.fullName ?? 'Not assigned'], ['Supplier', m.supplier ?? '—'],
                ['Estimated cost', money(m.estimatedCost)], ['Actual cost', money(m.actualCost)], ['Recorded as expenses (approved)', <strong>{money(m.expensedCost)}</strong>], ['Completed', m.completedOn ? date(m.completedOn) : '—'],
              ]} />
              <div className="row between"><h3>Linked expenses</h3>{can('expense.create') && <Link className="btn sm" to={`/expenses?new=1&maintenanceRequestId=${m.id}&buildingId=${m.building.id}${m.room ? `&roomId=${m.room.id}` : ''}`}>Add expense for this repair</Link>}</div>
              <Table rows={m.expenses} empty={<Empty title="No expenses linked">Record the repair cost as an expense linked to this request so it appears in financial reports.</Empty>} columns={[
                { header: 'No.', cell: (e: any) => e.number }, { header: 'Date', cell: (e: any) => date(e.expenseDate) }, { header: 'Description', cell: (e: any) => `${e.description} (${e.category.name})` },
                { header: 'Amount', num: true, cell: (e: any) => money(e.amount) }, { header: 'Status', cell: (e: any) => <Badge status={e.status} /> },
              ]} />
            </>
          )}
          {tab === 'update' && (
            <AutoForm submitLabel="Save update" initial={{ status: '', priority: m.priority, assignedToId: m.assignedTo?.id ?? '', estimatedCost: m.estimatedCost ? Number(m.estimatedCost) : '', actualCost: m.actualCost ? Number(m.actualCost) : '', supplier: m.supplier ?? '', description: m.description ?? '' }}
              fields={[
                { name: 'status', label: 'Move to status', type: 'select', placeholder: `Keep “${label(m.status)}”`, options: enumOpts(NEXT[m.status] ?? []) }, { name: 'priority', label: 'Priority', type: 'select', options: enumOpts(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), required: true },
                { name: 'assignedToId', label: 'Assigned staff', type: 'select', placeholder: 'Not assigned', options: (staff.data?.items ?? []).map((u: any) => ({ value: u.id, label: u.fullName })) }, { name: 'supplier', label: 'Supplier' },
                { name: 'estimatedCost', label: 'Estimated cost (RWF)', type: 'money' }, { name: 'actualCost', label: 'Actual cost (RWF)', type: 'money' }, { name: 'description', label: 'Description', type: 'textarea' },
              ]}
              onSubmit={async (v) => { await update.mutateAsync({ ...v, status: v.status || undefined }); setTab('details'); }} />
          )}
          {tab === 'documents' && <DocumentsPanel entityType="MaintenanceRequest" entityId={id} defaultCategory="MAINTENANCE" />}
          {tab === 'history' && <TimelinePanel entityType="MaintenanceRequest" entityId={id} />}
        </div>
      )}
    </Modal>
  );
}

export function Maintenance() {
  const { can, buildingId } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [formBuilding, setFormBuilding] = useState(buildingId);
  const [open, setOpen] = useState('');
  const f = { status: params.get('status') ?? '', priority: params.get('priority') ?? '', roomId: params.get('roomId') ?? '' };
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('new'); setParams(p, { replace: true }); };
  const list = useApi('/maintenance', { ...f, q, buildingId, page, pageSize: 25 });
  const places = usePlaces(formBuilding);
  const staff = useApi('/staff', undefined, creating);
  const create = useAction((v: any) => api.post('/maintenance', v), (m: any) => `Maintenance request ${m.number} created.`);
  useEffect(() => setPage(1), [q, buildingId, f.status, f.priority]);
  return (
    <div className="stack">
      <PageHead title="Maintenance" sub="Issues reported for buildings and rooms, from report to completion.">
        {can('maintenance.manage') && <Button variant="primary" onClick={() => setCreating(true)}>Add maintenance request</Button>}
      </PageHead>
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Issue, number or supplier" />
          <Select label="Status" value={f.status} onChange={(v) => set('status', v)} all="All statuses" options={[{ value: 'OPEN', label: 'Open (not completed)' }, ...enumOpts(['REPORTED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])]} />
          <Select label="Priority" value={f.priority} onChange={(v) => set('priority', v)} all="All priorities" options={enumOpts(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])} />
        </div>
        <Table rows={list.data?.items} onRow={(m: any) => setOpen(m.id)} empty={<Empty title="No maintenance requests found" />} columns={[
          { header: 'No.', cell: (m: any) => m.number, hideSm: true }, { header: 'Issue', cell: (m: any) => <><span className="strong">{m.title}</span><div className="muted small">{[m.building.name, m.floor?.name, m.room && `Room ${m.room.number}`].filter(Boolean).join(' · ')}</div></> },
          { header: 'Reported', cell: (m: any) => date(m.reportedOn), hideSm: true }, { header: 'Assigned to', cell: (m: any) => m.assignedTo?.fullName ?? <span className="muted">—</span>, hideSm: true },
          { header: 'Priority', cell: (m: any) => <Badge status={m.priority} /> }, { header: 'Status', cell: (m: any) => <Badge status={m.status} /> },
          { header: 'Estimated', num: true, cell: (m: any) => money(m.estimatedCost), hideSm: true }, { header: 'Expensed', num: true, cell: (m: any) => money(m.expensedCost) },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
      {creating && (
        <Modal title="Add maintenance request" wide onClose={() => setCreating(false)}>
          <AutoForm submitLabel="Create request" onCancel={() => setCreating(false)} initial={{ buildingId: formBuilding, priority: 'MEDIUM', roomId: f.roomId }} onChange={(v) => setFormBuilding(v.buildingId)}
            fields={[
              { name: 'buildingId', label: 'Building', type: 'select', options: opts(meta.data?.buildings), required: true },
              { name: 'floorId', label: 'Floor (optional)', type: 'select', options: places.floors, placeholder: 'Whole building', when: (v) => !v.roomId },
              { name: 'roomId', label: 'Room (optional)', type: 'select', options: places.rooms, placeholder: 'Not a specific room' },
              { name: 'priority', label: 'Priority', type: 'select', options: enumOpts(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), required: true },
              { name: 'title', label: 'Issue', required: true, full: true, placeholder: 'e.g. Leaking ceiling' }, { name: 'description', label: 'Description', type: 'textarea' },
              { name: 'estimatedCost', label: 'Estimated cost (RWF)', type: 'money' }, { name: 'supplier', label: 'Supplier' },
              { name: 'assignedToId', label: 'Assign to', type: 'select', placeholder: 'Not assigned yet', options: (staff.data?.items ?? []).map((u: any) => ({ value: u.id, label: u.fullName })) },
              { name: 'markRoomUnderMaintenance', label: 'Take this (vacant) room out of service while the work is done', type: 'checkbox', full: true, when: (v) => Boolean(v.roomId) },
            ]}
            onSubmit={async (v) => { const m = await create.mutateAsync({ ...v, floorId: v.roomId ? undefined : v.floorId }); setCreating(false); setOpen(m.id); }} />
        </Modal>
      )}
      {open && <MaintenanceDetail id={open} onClose={() => setOpen('')} />}
    </div>
  );
}

// ───────────── Approvals ─────────────

export function Approvals() {
  const { can, me } = useAuth();
  const [status, setStatus] = useState('SUBMITTED');
  const [page, setPage] = useState(1);
  const [decide, setDecide] = useState<{ item: any; approve: boolean } | null>(null);
  const list = useApi('/approvals', { status, page, pageSize: 25 });
  const expenses = useApi('/expenses', { status: 'SUBMITTED', pageSize: 100 }, can('expense.view'));
  const decision = useAction((v: { id: string; approve: boolean; note: string }) => api.post(`/approvals/${v.id}/decision`, { approve: v.approve, note: v.note }), 'Decision recorded.');
  const withdraw = useAction((id: string) => api.post(`/approvals/${id}/cancel`), 'Request withdrawn.');
  const href = (a: any) => (a.entityType === 'Payment' ? `/payments/${a.entityId}` : a.entityType === 'Contract' ? `/contracts/${a.entityId}` : '/rent');
  return (
    <div className="stack">
      <PageHead title="Approvals" sub="Payment reversals, rent adjustments, debt waivers and deposit refunds need approval before they take effect." />
      <ErrorBox error={list.error ?? decision.error} />
      {can('expense.view') && (expenses.data?.total ?? 0) > 0 && <div className="alert amber"><div className="grow">{expenses.data.total} expense(s) are awaiting approval.</div><Link className="btn sm" to="/expenses?status=SUBMITTED">Review expenses</Link></div>}
      <Card pad={false}>
        <div className="filters no-print"><Select label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} all="All" options={[{ value: 'SUBMITTED', label: 'Awaiting decision' }, ...enumOpts(['APPROVED', 'REJECTED', 'CANCELLED'])]} /></div>
        <Table rows={list.data?.items} empty={<Empty title={status === 'SUBMITTED' ? 'Nothing is waiting for approval' : 'No requests'} />} columns={[
          { header: 'Requested', cell: (a: any) => <>{dateTime(a.createdAt)}<div className="muted small">{a.requestedBy.fullName}</div></> },
          { header: 'Type', cell: (a: any) => label(a.type) }, { header: 'Request', cell: (a: any) => <><Link to={href(a)}>{a.summary}</Link><div className="muted small">Reason: {a.reason}</div></> },
          { header: 'Status', cell: (a: any) => <><Badge status={a.status} text={a.status === 'SUBMITTED' ? 'Awaiting decision' : undefined} />{a.decidedBy && <div className="muted small">{a.decidedBy.fullName}{a.decisionNote ? ` — ${a.decisionNote}` : ''}</div>}</> },
          { header: '', cell: (a: any) => a.status !== 'SUBMITTED' ? null : (
            <div className="row end">
              {can('approval.decide') && <><Button size="sm" variant="primary" onClick={() => setDecide({ item: a, approve: true })}>Approve</Button><Button size="sm" onClick={() => setDecide({ item: a, approve: false })}>Reject</Button></>}
              {a.requestedById === me?.user.id && <Button size="sm" variant="ghost" onClick={() => withdraw.mutate(a.id)}>Withdraw</Button>}
            </div>) },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
      {decide && (
        <Confirm title={decide.approve ? 'Approve this request?' : 'Reject this request?'} confirmLabel={decide.approve ? 'Approve and post' : 'Reject'} danger={!decide.approve} reason={decide.approve ? undefined : 'Reason for rejection'}
          onClose={() => setDecide(null)} onConfirm={(note) => decision.mutateAsync({ id: decide.item.id, approve: decide.approve, note })}>
          <strong>{decide.item.summary}</strong><br />Requested by {decide.item.requestedBy.fullName}: “{decide.item.reason}”.
          {decide.approve && <><br />Approving posts the change immediately and records you as the approver.</>}
        </Confirm>
      )}
    </div>
  );
}

// ───────────── Notifications ─────────────

const CATEGORIES = ['RENT', 'PAYMENT', 'CONTRACT', 'MAINTENANCE', 'FINANCE', 'SYSTEM'];

export function Notifications() {
  const navigate = useNavigate();
  const [category, setCategory] = useState('');
  const [unread, setUnread] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi('/notifications', { category, unread: unread || undefined, page, pageSize: 25 });
  const read = useAction((id: string) => api.post(`/notifications/${id}/read`));
  const readAll = useAction(() => api.post('/notifications/read-all', { category }), (r: any) => `${r.marked} notification(s) marked as read.`);
  const target = (n: any): string | null => {
    switch (n.entityType) {
      case 'Tenant': return `/tenants/${n.entityId}`;
      case 'Contract': return `/contracts/${n.entityId}`;
      case 'Payment': return `/payments/${n.entityId}`;
      case 'Approval': return '/approvals';
      case 'Expense': return '/expenses';
      case 'Invoice': return '/invoices?missingEbm=true';
      case 'RentLedger': return '/rent';
      default: return null;
    }
  };
  return (
    <div className="stack">
      <PageHead title="Notifications" sub={`${list.data?.unread ?? 0} unread`}>
        <Button onClick={() => readAll.mutate(undefined as never)} disabled={!list.data?.unread}>Mark all as read{category ? ` (${label(category)})` : ''}</Button>
      </PageHead>
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <Select label="Category" value={category} onChange={(v) => { setCategory(v); setPage(1); }} all="All categories" options={CATEGORIES.map((c) => ({ value: c, label: `${label(c)}${list.data?.unreadByCategory?.[c] ? ` (${list.data.unreadByCategory[c]} unread)` : ''}` }))} />
          <Select label="Show" value={unread} onChange={(v) => { setUnread(v); setPage(1); }} all="Read and unread" options={[{ value: 'true', label: 'Unread only' }]} />
        </div>
        <Table rows={list.data?.items} empty={<Empty title="No notifications">Alerts about rent, contracts, maintenance and approvals appear here.</Empty>} columns={[
          { header: '', cell: (n: any) => (n.readAt ? <span className="sr-only">Read</span> : <span title="Unread" aria-label="Unread" style={{ color: 'var(--accent)' }}>●</span>) },
          { header: 'Notification', cell: (n: any) => <><span className={n.readAt ? '' : 'strong'}>{n.title}</span><div className="muted small">{n.body}</div></> },
          { header: 'Category', cell: (n: any) => label(n.category), hideSm: true }, { header: 'When', cell: (n: any) => <span className="nowrap">{dateTime(n.createdAt)}</span> },
          { header: '', cell: (n: any) => (
            <div className="row end">
              {target(n) && <Button size="sm" onClick={async () => { if (!n.readAt) await read.mutateAsync(n.id); navigate(target(n)!); }}>Open</Button>}
              {!n.readAt && <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>Mark as read</Button>}
            </div>) },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
    </div>
  );
}
