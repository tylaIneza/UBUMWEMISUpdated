import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useMeta } from '../auth';
import { addDaysIso, date, money, percent, tenancyPeriod } from '../format';
import { I } from '../icons';
import { DocumentsPanel, LedgerTable, PaymentsTable, TimelinePanel, useAction, useApi } from '../shared';
import { AutoForm, Badge, type FieldDef, Button, Card, Confirm, DL, Empty, enumOpts, ErrorBox, Loading, Modal, opts, PageHead, Pager, Select, Stat, Table, Tabs, TextInput, useDebounced } from '../ui';

// ───────────── Buildings ─────────────

export function Buildings() {
  const { can } = useAuth();
  const q = useApi('/buildings');
  const templates = useApi('/contract-templates');
  const [edit, setEdit] = useState<any>(null);
  const [remove, setRemove] = useState<any>(null);
  const save = useAction((v: any) => (edit?.id ? api.patch(`/buildings/${edit.id}`, v) : api.post('/buildings', v)), 'Building saved.');
  const del = useAction((id: string) => api.del(`/buildings/${id}`), 'Building deleted.');
  return (
    <div className="stack">
      <PageHead title="Buildings" sub="Every building managed by the organization. More can be added at any time.">
        {can('building.manage') && <Button variant="primary" onClick={() => setEdit({})}>Add building</Button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <Card pad={false}>
        <Table rows={q.data?.items} empty={<Empty title="No buildings yet">Add the first building to get started.</Empty>} columns={[
          { header: 'Building', cell: (b: any) => <><span className="strong">{b.name}</span><div className="muted small">{b.code}{b.address ? ` · ${b.address}` : ''}</div><div className="small" style={{ color: b.contractTemplate ? 'var(--green)' : 'var(--amber)' }}>{b.contractTemplate ? `Contract: ${b.contractTemplate}` : 'No lease contract set up yet'}</div></> },
          { header: 'Floors', num: true, cell: (b: any) => b.floorCount }, { header: 'Rooms', num: true, cell: (b: any) => b.totalRooms },
          { header: 'Occupied', num: true, cell: (b: any) => b.roomCounts.OCCUPIED }, { header: 'Vacant', num: true, cell: (b: any) => b.roomCounts.VACANT },
          { header: 'Reserved', num: true, hideSm: true, cell: (b: any) => b.roomCounts.RESERVED }, { header: 'Maintenance', num: true, hideSm: true, cell: (b: any) => b.roomCounts.MAINTENANCE },
          { header: 'Occupancy', num: true, cell: (b: any) => percent(b.totalRooms - b.roomCounts.INACTIVE > 0 ? b.roomCounts.OCCUPIED / (b.totalRooms - b.roomCounts.INACTIVE) : null) },
          { header: 'Status', cell: (b: any) => <Badge status={b.status} /> },
          { header: '', cell: (b: any) => <div className="row end" style={{ flexWrap: 'nowrap' }}>
            {can('building.manage') && <Button size="sm" onClick={() => setEdit(b)}>Edit</Button>}
            {can('data.delete') && <Button size="sm" variant="ghost" onClick={() => setRemove(b)}>Delete</Button>}
          </div> },
        ]} />
      </Card>
      {remove && (
        <Confirm title={`Delete ${remove.name}?`} danger confirmLabel="Delete permanently" onClose={() => setRemove(null)} onConfirm={() => del.mutateAsync(remove.id)}>
          This permanently removes the building with its {remove.floorCount} floor(s) and {remove.totalRooms} room(s). It is only possible if none of its rooms has ever had a contract, payment, expense or maintenance record — otherwise you will be told why, and you can set the building to Inactive instead.
        </Confirm>
      )}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add building'} onClose={() => setEdit(null)}>
          <AutoForm initial={{ code: edit.code ?? '', name: edit.name ?? '', address: edit.address ?? '', description: edit.description ?? '', status: edit.status ?? 'ACTIVE', contractTemplate: edit.contractTemplate ?? '', ...Object.fromEntries(COMPANY_FIELDS.map((f) => [f.name, edit[f.name] ?? ''])) }} onCancel={() => setEdit(null)}
            fields={[
              { name: 'code', label: 'Short code', required: true, hint: 'Unique, e.g. UBM' }, { name: 'name', label: 'Building name', required: true },
              { name: 'address', label: 'Address', full: true }, { name: 'description', label: 'Description', type: 'textarea' },
              { name: 'contractTemplate', label: 'Lease contract', type: 'select' as const, placeholder: 'None yet — no contract can be printed', full: true,
                options: (templates.data?.items ?? []).map((f: string) => ({ value: f, label: f })),
                hint: 'The Word contract given to tenants of this building. Each building has its own; never choose another building’s contract.' },
              ...COMPANY_FIELDS,
              ...(edit.id ? [{ name: 'status', label: 'Status', type: 'select' as const, options: enumOpts(['ACTIVE', 'INACTIVE']), required: true }] : []),
            ]}
            onSubmit={async (v) => { await save.mutateAsync(v); setEdit(null); }} />
        </Modal>
      )}
    </div>
  );
}

/** The company that owns the building — printed on its reports, receipts and lease contracts instead of anyone else's. */
const COMPANY_FIELDS: FieldDef[] = [
  { name: 'companyName', label: 'Company name (landlord)', hint: 'Printed on this building’s reports, receipts and contracts, e.g. UBUMWE HOUSE LTD', full: true },
  { name: 'managerName', label: 'Manager who signs contracts', hint: 'e.g. UWIMANA Annonciata' }, { name: 'tin', label: 'Company TIN' },
  { name: 'phone', label: 'Company phone' }, { name: 'email', label: 'Company e-mail' },
  { name: 'bankName', label: 'Bank', hint: 'Where tenants pay rent, e.g. BPR BANK' }, { name: 'bankAccount', label: 'Bank account number' },
  { name: 'upi', label: 'Plot number (UPI)' },
  { name: 'district', label: 'District (Akarere)' }, { name: 'sector', label: 'Sector (Umurenge)' }, { name: 'cell', label: 'Cell (Akagari)' }, { name: 'village', label: 'Village (Umudugudu)' },
];

// ───────────── Floors ─────────────

export function Floors() {
  const { can, buildingId } = useAuth();
  const meta = useMeta();
  const q = useApi('/floors', { buildingId });
  const [edit, setEdit] = useState<any>(null);
  const [remove, setRemove] = useState<any>(null);
  const save = useAction((v: any) => (edit?.id ? api.patch(`/floors/${edit.id}`, { name: v.name, level: v.level }) : api.post('/floors', v)), 'Floor saved.');
  const del = useAction((id: string) => api.del(`/floors/${id}`), 'Floor deleted.');
  return (
    <div className="stack">
      <PageHead title="Floors" sub="Floors of each building, ordered from the lowest level.">
        {can('building.manage') && <Button variant="primary" onClick={() => setEdit({ buildingId })}>Add floor</Button>}
      </PageHead>
      <ErrorBox error={q.error} />
      <Card pad={false}>
        <Table rows={q.data?.items} empty={<Empty title="No floors yet">Add floors to a building before registering rooms.</Empty>} columns={[
          { header: 'Building', cell: (f: any) => f.building.name }, { header: 'Floor', cell: (f: any) => <span className="strong">{f.name}</span> },
          { header: 'Level', num: true, cell: (f: any) => f.level }, { header: 'Rooms', num: true, cell: (f: any) => <Link to={`/rooms?floorId=${f.id}`}>{f.roomCount}</Link> },
          { header: 'Occupied', num: true, cell: (f: any) => f.occupiedCount },
          { header: '', cell: (f: any) => can('building.manage') ? <div className="row end"><Button size="sm" onClick={() => setEdit(f)}>Edit</Button>{f.roomCount === 0 && <Button size="sm" onClick={() => setRemove(f)}>Remove</Button>}</div> : null },
        ]} />
      </Card>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'Add floor'} onClose={() => setEdit(null)}>
          <AutoForm initial={{ buildingId: edit.buildingId ?? '', name: edit.name ?? '', level: edit.level ?? '' }} onCancel={() => setEdit(null)}
            fields={[
              ...(edit.id ? [] : [{ name: 'buildingId', label: 'Building', type: 'select' as const, options: opts(meta.data?.buildings), required: true }]),
              { name: 'name', label: 'Floor name', required: true, placeholder: 'e.g. Ground Floor, Basement 1' },
              { name: 'level', label: 'Level', type: 'number', required: true, hint: 'Sort order: -1 basement, 0 ground, 1 first floor…' },
            ]}
            onSubmit={async (v) => { await save.mutateAsync(v); setEdit(null); }} />
        </Modal>
      )}
      {remove && <Confirm title={`Delete ${remove.name}?`} confirmLabel="Delete permanently" danger onClose={() => setRemove(null)} onConfirm={() => del.mutateAsync(remove.id)}>{remove.roomCount ? `${remove.name} and its ${remove.roomCount} room(s) will be removed from ${remove.building.name}. This is only possible if none of the rooms has ever been let.` : `${remove.name} has no rooms and will be removed from ${remove.building.name}.`}</Confirm>}
    </div>
  );
}

// ───────────── Rooms ─────────────

const ROOM_STATUSES = ['VACANT', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE'];

export function useFloors(buildingId?: string) {
  return useApi('/floors', { buildingId }, true);
}

export function Rooms() {
  const { can, buildingId } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const status = params.get('status') ?? '';
  const floorId = params.get('floorId') ?? '';
  const q = useDebounced(search);
  const floors = useFloors(buildingId);
  const list = useApi('/rooms', { buildingId, floorId, status, q, page, pageSize: 24 });
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [formBuilding, setFormBuilding] = useState(buildingId);
  const formFloors = useFloors(formBuilding || undefined);
  const create = useAction((v: any) => api.post('/rooms', v), 'Room registered.');
  useEffect(() => setPage(1), [buildingId, floorId, status, q]);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('new'); setParams(p, { replace: true }); };
  return (
    <div className="stack">
      <PageHead title="Rooms" sub="Every rentable room with its rent, status and current tenant.">
        {can('room.manage') && <Button variant="primary" onClick={() => setCreating(true)}>Register room</Button>}
      </PageHead>
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Room number, type or description" />
          <Select label="Floor" value={floorId} onChange={(v) => set('floorId', v)} all="All floors" options={(floors.data?.items ?? []).map((f: any) => ({ value: f.id, label: `${f.building.name} — ${f.name}` }))} />
          <Select label="Status" value={status} onChange={(v) => set('status', v)} all="All statuses" options={enumOpts(ROOM_STATUSES)} />
        </div>
        <RoomGrid rooms={list.data?.items} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
      {creating && (
        <Modal title="Register room" onClose={() => setCreating(false)}>
          <AutoForm initial={{ buildingId: formBuilding, roomType: 'Shop' }} onCancel={() => setCreating(false)} submitLabel="Register room" onChange={(v) => setFormBuilding(v.buildingId)}
            fields={[
              { name: 'buildingId', label: 'Building', type: 'select', options: opts(meta.data?.buildings?.filter((b: any) => b.status === 'ACTIVE')), required: true },
              { name: 'floorId', label: 'Floor', type: 'select', required: true, options: (formFloors.data?.items ?? []).filter((f: any) => f.building.id === formBuilding).map((f: any) => ({ value: f.id, label: f.name })), placeholder: formBuilding ? 'Select floor…' : 'Choose a building first' },
              { name: 'number', label: 'Room number', required: true, placeholder: 'e.g. 101 or B1-015', hint: 'Must be unique within the building.' },
              { name: 'roomType', label: 'Room type', placeholder: 'Shop, Office, Store…' },
              { name: 'monthlyRent', label: 'Monthly rent (RWF)', type: 'money', required: true, hint: 'The standard rent. Loaded automatically when a tenant is assigned.' },
              { name: 'depositRequired', label: 'Deposit required (RWF)', type: 'money' }, { name: 'areaSqm', label: 'Area (m²)', type: 'money' },
              { name: 'description', label: 'Description', type: 'textarea' },
            ]}
            onSubmit={async (v) => { const room = await create.mutateAsync(v); setCreating(false); navigate(`/rooms/${room.id}`); }} />
        </Modal>
      )}
    </div>
  );
}

/** Rooms as cards: the room number is the link to its details; the tenant name links to the tenant. */
function RoomGrid({ rooms }: { rooms: any[] | undefined }) {
  if (!rooms) return <Loading />;
  if (!rooms.length) return <Empty title="No rooms found">Change the filters, or register a room.</Empty>;
  return (
    <ul className="room-grid">
      {rooms.map((r) => {
        const owing = Number(r.outstanding) > 0;
        return (
          <li key={r.id} className={`room-card ${r.status}`}>
            <div className="room-card-top">
              <div className="room-card-id">
                <span className="room-card-icon"><I name="door" size={18} /></span>
                <div>
                  <Link className="room-card-link" to={`/rooms/${r.id}`}>{r.number}</Link>
                  <div className="muted small">{r.roomType || 'Room'}</div>
                </div>
              </div>
              <Badge status={r.status} />
            </div>
            <div className="room-card-where"><I name="layers" size={14} />{r.building.name} · {r.floor.name}</div>
            <div className="room-card-rent"><span>{money(r.monthlyRent)}</span><small>/ month</small></div>
            <div className="room-card-foot">
              <div className="room-card-tenant">
                <I name="user" size={14} />
                {r.currentContract
                  ? <Link className="above" to={`/tenants/${r.currentContract.tenant.id}`}>{r.currentContract.tenant.fullName}</Link>
                  : <span className="muted">No tenant</span>}
              </div>
              {owing ? <span className="room-card-owing">Owes {money(r.outstanding)}</span> : r.currentContract ? <span className="room-card-clear">Paid up</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ───────────── Room details — the single source of truth for a room ─────────────

type RoomTab = 'overview' | 'ledger' | 'payments' | 'contract' | 'documents' | 'maintenance' | 'history';

export function RoomDetail() {
  const { id = '' } = useParams();
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const q = useApi(`/rooms/${id}`);
  const [tab, setTab] = useState<RoomTab>('overview');
  const [dialog, setDialog] = useState<'' | 'edit' | 'rent' | 'reserve' | 'status' | 'delete'>('');
  const maintenance = useApi('/maintenance', { roomId: id, pageSize: 50 }, tab === 'maintenance' && can('maintenance.view'));
  const edit = useAction((v: any) => api.patch(`/rooms/${id}`, v), 'Room updated.');
  const del = useAction(() => api.del(`/rooms/${id}`), 'Room deleted.');
  const roomFloors = useApi('/floors', { buildingId: q.data?.building.id }, Boolean(q.data));
  const rent = useAction((v: any) => api.post(`/rooms/${id}/rent`, v), 'Rent change recorded.');
  const reserve = useAction((v: any) => api.post('/reservations', { ...v, roomId: id }), 'Room reserved.');
  const cancelRes = useAction((rid: string) => api.post(`/reservations/${rid}/cancel`), 'Reservation cancelled.');
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const r = q.data;
  const today = me!.organization.today;
  const current = r.currentContract;
  const activeReservation = r.reservations.find((x: any) => x.status === 'ACTIVE');
  const neverLet = !r.contracts.some((c: any) => c.status !== 'DRAFT');
  return (
    <div className="stack">
      <PageHead title={<>Room {r.number} <Badge status={r.status} /></>} sub={<>{r.building.name} · {r.floor.name} · {r.roomType}</>}>
        {current && can('payment.create') && <Link className="btn primary" to={`/payments/new?contractId=${current.id}`}>Record payment</Link>}
        {r.status === 'VACANT' && can('tenant.manage') && can('contract.manage') && <Link className="btn primary" to={`/tenants/new?roomId=${r.id}`}>Register tenant here</Link>}
        {r.status === 'VACANT' && can('contract.manage') && <Link className="btn" to={`/contracts/new?roomId=${r.id}`}>Assign tenant with a contract</Link>}
        {r.status === 'RESERVED' && can('contract.manage') && <Link className="btn primary" to={`/contracts/new?roomId=${r.id}${activeReservation?.tenantId ? `&tenantId=${activeReservation.tenantId}` : ''}`}>Convert reservation to contract</Link>}
        {r.status === 'VACANT' && can('room.manage') && <Button onClick={() => setDialog('reserve')}>Reserve</Button>}
        {can('room.rent.manage') && <Button onClick={() => setDialog('rent')}>Change rent</Button>}
        {can('room.manage') && <Button onClick={() => setDialog('edit')}>Edit</Button>}
        {can('data.delete') && <Button variant="ghost" onClick={() => setDialog('delete')}>Delete</Button>}
      </PageHead>

      <div className="grid c4">
        <Stat k="Monthly rent" v={money(r.monthlyRent)} s={`Deposit required ${money(r.depositRequired)}`} />
        <Stat k="Current tenant" v={current ? <Link to={`/tenants/${current.tenant.id}`}>{current.tenant.fullName}</Link> : '—'} s={current ? current.tenant.phone : r.status === 'VACANT' ? 'Available for a new tenant' : undefined} />
        <Stat k="Contract" v={current ? <Link to={`/contracts/${current.id}`}>{current.contractNumber}</Link> : '—'} s={current ? <>{tenancyPeriod(current)} <Badge status={current.status} /></> : undefined} />
        <Stat k="Current balance" v={<span style={{ color: Number(r.financial.outstanding) > 0 ? 'var(--red)' : undefined }}>{money(r.financial.outstanding)}</span>} s={<>Overdue {money(r.financial.overdue)}{Number(r.financial.credit) > 0 && <> · advance credit {money(r.financial.credit)}</>}</>} />
      </div>

      <Card pad={false}>
        <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Overview'], ['ledger', 'Rent Ledger'], ['payments', 'Payments'], ['contract', 'Contract'], ['documents', 'Documents'], ['maintenance', 'Maintenance'], ['history', 'History']]} />
        {tab === 'overview' && (
          <div className="card-body grid c2">
            <div className="stack">
              <h3>Room details</h3>
              <DL items={[['Room number', r.number], ['Building', r.building.name], ['Floor', r.floor.name], ['Type', r.roomType], ['Area', r.areaSqm ? `${Number(r.areaSqm)} m²` : '—'], ['Description', r.description || '—'], ['Open maintenance issues', r.openMaintenance], ['Registered', date(r.createdAt)]]} />
              {activeReservation && (
                <div className="alert amber">
                  <div className="grow">Reserved for <strong>{activeReservation.prospectName}</strong>{activeReservation.prospectPhone && ` (${activeReservation.prospectPhone})`} until {date(activeReservation.expiresOn)}.{activeReservation.notes && <div className="small">{activeReservation.notes}</div>}</div>
                  {can('room.manage') && <Button size="sm" onClick={() => cancelRes.mutate(activeReservation.id)}>Cancel reservation</Button>}
                </div>
              )}
            </div>
            <div className="stack">
              <h3>Rent history</h3>
              <Table rows={r.rentRates} columns={[
                { header: 'Effective from', cell: (x: any) => date(x.effectiveFrom) }, { header: 'To', cell: (x: any) => x.effectiveTo ? date(x.effectiveTo) : 'Present' },
                { header: 'Rent', num: true, cell: (x: any) => money(x.amount) }, { header: 'Reason', cell: (x: any) => <span className="small">{x.reason}{x.createdBy && <span className="muted"> · {x.createdBy.fullName}</span>}</span>, hideSm: true },
              ]} />
              <p className="muted small">Rent history is never overwritten. A rent change closes the current rate and opens a new one.</p>
            </div>
          </div>
        )}
        {tab === 'ledger' && (can('rent.view') ? <LedgerTable params={{ roomId: id }} showTenant /> : <Empty title="You do not have access to the rent ledger" />)}
        {tab === 'payments' && (can('payment.view') ? <PaymentsTable params={{ roomId: id }} /> : <Empty title="You do not have access to payments" />)}
        {tab === 'contract' && (
          <Table rows={r.contracts} onRow={(c: any) => navigate(`/contracts/${c.id}`)} empty={<Empty title="No contracts">This room has never been let.</Empty>} columns={[
            { header: 'Contract', cell: (c: any) => c.contractNumber }, { header: 'Tenant', cell: (c: any) => c.tenant.fullName },
            { header: 'Period', cell: (c: any) => tenancyPeriod(c) }, { header: 'Rent', num: true, cell: (c: any) => money(c.monthlyRent) },
            { header: 'Status', cell: (c: any) => <Badge status={c.status} /> },
          ]} />
        )}
        {tab === 'documents' && <div className="card-body"><DocumentsPanel entityType="Room" entityId={id} defaultCategory="PHOTO" /></div>}
        {tab === 'maintenance' && (
          <Table rows={maintenance.data?.items} onRow={() => navigate(`/maintenance?roomId=${id}`)} empty={<Empty title="No maintenance recorded for this room" />} columns={[
            { header: 'No.', cell: (m: any) => m.number }, { header: 'Issue', cell: (m: any) => m.title }, { header: 'Reported', cell: (m: any) => date(m.reportedOn) },
            { header: 'Priority', cell: (m: any) => <Badge status={m.priority} /> }, { header: 'Status', cell: (m: any) => <Badge status={m.status} /> }, { header: 'Cost', num: true, cell: (m: any) => money(m.expensedCost) },
          ]} />
        )}
        {tab === 'history' && <div className="card-body"><TimelinePanel entityType="Room" entityId={id} /></div>}
      </Card>

      {dialog === 'edit' && (
        <Modal title={`Edit room ${r.number}`} onClose={() => setDialog('')}>
          <AutoForm onCancel={() => setDialog('')} initial={{ floorId: r.floor.id, number: r.number, roomType: r.roomType, depositRequired: Number(r.depositRequired), areaSqm: r.areaSqm ? Number(r.areaSqm) : '', description: r.description ?? '', status: ['VACANT', 'MAINTENANCE', 'INACTIVE'].includes(r.status) ? r.status : '' }}
            fields={[
              ...(neverLet ? [{ name: 'floorId', label: 'Floor', type: 'select' as const, required: true, options: (roomFloors.data?.items ?? []).map((f: any) => ({ value: f.id, label: f.name })) }] : []),
              { name: 'number', label: 'Room number', required: true }, { name: 'roomType', label: 'Room type' },
              { name: 'depositRequired', label: 'Deposit required (RWF)', type: 'money' }, { name: 'areaSqm', label: 'Area (m²)', type: 'money' },
              ...(['VACANT', 'MAINTENANCE', 'INACTIVE'].includes(r.status) ? [{ name: 'status', label: 'Status', type: 'select' as const, options: enumOpts(['VACANT', 'MAINTENANCE', 'INACTIVE']), hint: 'Occupied and Reserved are set by contracts and reservations.' }] : []),
              { name: 'description', label: 'Description', type: 'textarea' },
            ]}
            onSubmit={async (v) => { await edit.mutateAsync({ ...v, status: v.status || undefined, floorId: v.floorId || undefined }); setDialog(''); }}>
            <p className="muted small">Rent is changed with “Change rent”{neverLet ? '. This room has never been let, so a new rent simply replaces the old one.' : ', which keeps the rent history.'}</p>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'delete' && (
        <Confirm title={`Delete room ${r.number}?`} danger confirmLabel="Delete permanently" onClose={() => setDialog('')} onConfirm={async () => { await del.mutateAsync(undefined as never); navigate('/rooms'); }}>
          {neverLet ? `Room ${r.number} has never been let and will be removed permanently.` : `Room ${r.number} has contracts and payment history, so it cannot be deleted — you will be shown the details. To stop using it, use Edit and set its status to Inactive.`}
        </Confirm>
      )}
      {dialog === 'rent' && (
        <Modal title={`Change rent — room ${r.number}`} onClose={() => setDialog('')}>
          <AutoForm onCancel={() => setDialog('')} submitLabel={neverLet ? 'Save new rent' : 'Record rent change'} initial={{ effectiveFrom: neverLet ? today : addDaysIso(today, 1) }}
            fields={[
              { name: 'amount', label: 'New monthly rent (RWF)', type: 'money', required: true, hint: `Current rent: ${money(r.monthlyRent)}` },
              ...(neverLet ? [] : [{ name: 'effectiveFrom', label: 'Effective from', type: 'date' as const, required: true, min: today, hint: 'Cannot be in the past.' }]),
              { name: 'reason', label: 'Reason', type: 'textarea', required: true },
            ]}
            onSubmit={async (v) => { await rent.mutateAsync({ ...v, effectiveFrom: v.effectiveFrom || today }); setDialog(''); }}>
            <div className="alert blue"><div>This changes the room’s standard rent for <strong>new</strong> contracts. {current ? 'The current tenant’s contract keeps its agreed rent — change it from the contract page.' : ''} Past charges are never altered.</div></div>
          </AutoForm>
        </Modal>
      )}
      {dialog === 'reserve' && (
        <Modal title={`Reserve room ${r.number}`} onClose={() => setDialog('')}>
          <AutoForm onCancel={() => setDialog('')} submitLabel="Reserve room" initial={{ reservedOn: today, expiresOn: addDaysIso(today, 7) }}
            fields={[
              { name: 'prospectName', label: 'Prospective tenant', required: true }, { name: 'prospectPhone', label: 'Phone', type: 'tel' },
              { name: 'reservedOn', label: 'Reservation date', type: 'date', required: true }, { name: 'expiresOn', label: 'Expires on', type: 'date', required: true },
              { name: 'depositAmount', label: 'Reservation deposit (RWF)', type: 'money', hint: 'For reference only; record the money under Deposits once a contract exists.' }, { name: 'notes', label: 'Notes', type: 'textarea' },
            ]}
            onSubmit={async (v) => { await reserve.mutateAsync(v); setDialog(''); }} />
        </Modal>
      )}
    </div>
  );
}
