import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, newSubmissionKey } from '../api';
import { useAuth, useMeta } from '../auth';
import { date, dateTime, label, money, monthRange, parsePhone, phone, smsLink } from '../format';
import { DocumentsPanel, LedgerTable, PaymentsTable, TimelinePanel, useAction, useApi } from '../shared';
import { Alert, AutoForm, Badge, Button, Card, Confirm, DL, Empty, enumOpts, ErrorBox, Field, Loading, Modal, opts, PageHead, Pager, Select, Stat, Table, Tabs, TextInput, useDebounced, useToast, type FieldDef } from '../ui';

const TENANT_FIELDS: FieldDef[] = [
  { name: 'fullName', label: 'Full name', required: true }, { name: 'phone', label: 'Phone number', type: 'tel', required: true, placeholder: '078 812 3456', hint: 'Rwandan number (078…, 079…, 072…, 073…), or + and country code for other countries.' },
  { name: 'idType', label: 'ID type', type: 'select', options: enumOpts(['NATIONAL_ID', 'PASSPORT', 'OTHER']) }, { name: 'idNumber', label: 'ID / passport number', required: true },
  { name: 'email', label: 'E-mail', type: 'email' }, { name: 'businessName', label: 'Business / company name' },
  { name: 'tin', label: 'TIN number', required: true, hint: '9 digits, from the RDB certificate. One TIN can belong to only one tenant.' },
  { name: 'district', label: 'District (Akarere)', required: true }, { name: 'sector', label: 'Sector (Umurenge)', required: true }, { name: 'cell', label: 'Cell (Akagari)', required: true }, { name: 'village', label: 'Village (Umudugudu)', required: true },
  { name: 'address', label: 'Address', full: true }, { name: 'emergencyContactName', label: 'Emergency contact name' }, { name: 'emergencyContactPhone', label: 'Emergency contact phone', type: 'tel', placeholder: '078 812 3456' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
];

export function Tenants() {
  const { can, buildingId } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const status = params.get('status') ?? '';
  const withArrears = params.get('withArrears') === 'true';
  const q = useDebounced(search);
  const list = useApi('/tenants', { q, status, buildingId, withArrears: withArrears || undefined, page, pageSize: 25 });
  useEffect(() => setPage(1), [q, status, buildingId, withArrears]);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  return (
    <div className="stack">
      <PageHead title="Tenants" sub="Current and former tenants. Former tenants are kept, never deleted.">
        {can('tenant.manage') && <Link to="/tenants/new" className="btn primary">Add tenant</Link>}
      </PageHead>
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={setSearch} placeholder="Name, phone, ID number, business" />
          <Select label="Status" value={status} onChange={(v) => set('status', v)} all="All statuses" options={enumOpts(['ACTIVE', 'INACTIVE', 'FORMER', 'BLACKLISTED'])} />
          <Select label="Balance" value={withArrears ? 'true' : ''} onChange={(v) => set('withArrears', v)} all="Any" options={[{ value: 'true', label: 'Owing rent' }]} />
        </div>
        <Table rows={list.data?.items} onRow={(t: any) => navigate(`/tenants/${t.id}`)} empty={<Empty title="No tenants found" />} columns={[
          { header: 'Tenant', cell: (t: any) => <><span className="strong">{t.fullName}</span><div className="muted small">{t.businessName ?? ''}</div></> },
          { header: 'Phone', cell: (t: any) => <span className="nowrap">{phone(t.phone)}</span> }, { header: 'ID number', cell: (t: any) => t.idNumber, hideSm: true },
          { header: 'Room', cell: (t: any) => t.currentContracts.length ? t.currentContracts.map((c: any) => `${c.room.number} · ${c.building.name}`).join('; ') : <span className="muted">—</span> },
          { header: 'Monthly rent', num: true, hideSm: true, cell: (t: any) => t.currentContracts.length ? money(t.currentContracts.reduce((a: number, c: any) => a + Number(c.monthlyRent), 0)) : '—' },
          { header: 'Outstanding', num: true, cell: (t: any) => Number(t.outstanding) > 0 ? <span className="strong">{money(t.outstanding)}</span> : <span className="muted">0</span> },
          { header: 'Status', cell: (t: any) => <Badge status={t.status} /> },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
    </div>
  );
}

type TenantTab = 'overview' | 'payments' | 'ledger' | 'contract' | 'documents' | 'communication' | 'history';

function Communication({ tenant }: { tenant: any }) {
  const { can } = useAuth();
  const meta = useMeta();
  const toast = useToast();
  const log = useApi(`/tenants/${tenant.id}/messages`);
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState<unknown>(null);
  const create = useAction((v: any) => api.post('/messages', { tenantId: tenant.id, ...v }));
  const channels = meta.data?.channels ?? {};
  const generate = async (template: string, channel = 'COPY') => {
    setError(null);
    try { setDraft(await create.mutateAsync({ template, channel })); } catch (e) { setError(e); }
  };
  return (
    <div className="card-body stack">
      {can('message.create') && (
        <div className="row">
          <Button onClick={() => generate('PAYMENT_REMINDER')}>Generate payment reminder</Button>
          <Button disabled={!channels.SMS?.available} title={channels.SMS?.available ? '' : channels.SMS?.note} onClick={() => generate('PAYMENT_REMINDER', 'SMS')}>Send reminder by SMS</Button>
          <Button onClick={() => generate('CONTRACT_EXPIRY')}>Generate contract-expiry notice</Button>
          <Button disabled={!channels.EMAIL?.available || !tenant.email} title={!channels.EMAIL?.available ? channels.EMAIL?.note : !tenant.email ? 'This tenant has no e-mail address.' : ''} onClick={() => generate('PAYMENT_REMINDER', 'EMAIL')}>E-mail reminder</Button>
        </div>
      )}
      <p className="muted small">Messages are written from the tenant’s live balance. {channels.SMS?.available ? 'SMS is sent through your SMS provider.' : 'No SMS provider is connected: use “Open in SMS app” or copy the text and send it from your phone.'} {channels.EMAIL?.available ? 'E-mail is sent through the configured mail server.' : 'E-mail delivery is not configured on this server.'}</p>
      <ErrorBox error={error} />
      {draft && (
        <div className="alert blue">
          <div className="grow stack tight">
            <strong>{draft.status === 'SENT' ? `Sent to ${draft.email && draft.channel !== 'SMS' ? draft.email : phone(draft.phone)}` : draft.status === 'FAILED' ? `Could not be sent: ${draft.error}` : 'Message ready to copy or open in your SMS app'}</strong>
            <div>{draft.body}</div>
            <div className="row">
              <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(draft.body); toast('Message copied.'); }}>Copy message</Button>
              {draft.status === 'GENERATED' && <a className="btn sm" href={smsLink(draft.phone, draft.body)}>Open in SMS app</a>}
              <span className="small">To: {phone(draft.phone)}</span>
            </div>
          </div>
        </div>
      )}
      <Table rows={log.data?.items} empty={<Empty title="No messages yet" />} columns={[
        { header: 'When', cell: (m: any) => dateTime(m.createdAt) }, { header: 'Type', cell: (m: any) => label(m.template) }, { header: 'Channel', cell: (m: any) => label(m.channel) },
        { header: 'Status', cell: (m: any) => <Badge status={m.status} text={m.status === 'GENERATED' ? 'Generated (not sent by system)' : undefined} /> },
        { header: 'Message', cell: (m: any) => <span className="small">{m.body}</span>, hideSm: true }, { header: 'By', cell: (m: any) => m.createdBy.fullName, hideSm: true },
      ]} />
    </div>
  );
}

export function TenantDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const q = useApi(`/tenants/${id}`);
  const [tab, setTab] = useState<TenantTab>('overview');
  const [dialog, setDialog] = useState<'' | 'edit' | 'blacklist' | 'unblacklist' | 'delete'>('');
  const save = useAction((v: any) => api.patch(`/tenants/${id}`, v), 'Tenant updated.');
  const status = useAction((v: any) => api.post(`/tenants/${id}/status`, v), 'Tenant status changed.');
  const del = useAction(() => api.del(`/tenants/${id}`), 'Tenant deleted.');
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const t = q.data;
  const current = t.currentContracts[0];
  const payable = t.contracts.filter((c: any) => c.status !== 'DRAFT' && (c.billable || Number(c.outstanding) > 0));
  return (
    <div className="stack">
      <PageHead title={<>{t.fullName} <Badge status={t.status} /></>} sub={<>{t.businessName ? `${t.businessName} · ` : ''}{phone(t.phone)} · ID {t.idNumber}</>}>
        {can('payment.create') && payable.length > 0 && <Link className="btn primary" to={`/payments/new?contractId=${(payable.find((c: any) => Number(c.outstanding) > 0) ?? payable[0]).id}`}>Record payment</Link>}
        {can('contract.manage') && t.status !== 'BLACKLISTED' && <Link className="btn" to={`/contracts/new?tenantId=${t.id}`}>New contract</Link>}
        {can('tenant.manage') && <Button onClick={() => setDialog('edit')}>Edit</Button>}
        {can('data.delete') && <Button variant="ghost" onClick={() => setDialog('delete')}>Delete</Button>}
        {can('tenant.blacklist') && (t.status === 'BLACKLISTED' ? <Button onClick={() => setDialog('unblacklist')}>Remove from blacklist</Button> : <Button onClick={() => setDialog('blacklist')}>Blacklist</Button>)}
      </PageHead>
      {t.phoneProblem && <Alert tone="amber"><strong>This tenant’s phone number ({t.phone}) is not valid:</strong> {t.phoneProblem} Reminders cannot reach them by SMS. {can('tenant.manage') && 'Press Edit to correct it.'}</Alert>}
      {t.idNumberProblem && <Alert tone="amber"><strong>This tenant’s ID number ({t.idNumber}) is not valid:</strong> {t.idNumberProblem} {can('tenant.manage') && 'Press Edit to correct it.'}</Alert>}
      {t.status === 'BLACKLISTED' && <Alert>Blacklisted{t.statusReason ? `: ${t.statusReason}` : ''}. This tenant cannot be given a new contract.</Alert>}

      <div className="grid c4">
        <Stat k="Outstanding balance" v={<span style={{ color: Number(t.financial.outstanding) > 0 ? 'var(--red)' : undefined }}>{money(t.financial.outstanding)}</span>} s={`Overdue ${money(t.financial.overdue)}`} />
        <Stat k="Monthly rent" v={money(t.financial.monthlyRent)} s={current ? `Contract ends ${date(current.endDate)}` : 'No current contract'} />
        <Stat k="Total paid to date" v={money(t.financial.totalPaid)} s={t.financial.lastPayment ? `Last payment ${date(t.financial.lastPayment.paidAt)} · ${money(t.financial.lastPayment.amount)}` : 'No payments yet'} />
        <Stat k="Advance credit" v={money(t.financial.credit)} s="Paid but not yet applied to a month" />
      </div>

      <Card pad={false}>
        <Tabs value={tab} onChange={setTab} tabs={[['overview', 'Overview'], ['payments', 'Payments'], ['ledger', 'Rent Ledger'], ['contract', 'Contract'], ['documents', 'Documents'], ['communication', 'Communication'], ['history', 'History']]} />
        {tab === 'overview' && (
          <div className="card-body grid c2">
            <div className="stack">
              <h3>Tenant profile</h3>
              <DL items={[['Full name', t.fullName], ['Phone', phone(t.phone)], [label(t.idType), t.idNumber], ['E-mail', t.email || '—'], ['Business', t.businessName || '—'], ['TIN', t.tin || '—'], ['Lives in', [t.village && `Umudugudu ${t.village}`, t.cell && `Akagari ${t.cell}`, t.sector && `Umurenge ${t.sector}`, t.district && `Akarere ${t.district}`].filter(Boolean).join(', ') || '—'], ['Address', t.address || '—'], ['Emergency contact', t.emergencyContactName ? `${t.emergencyContactName} · ${phone(t.emergencyContactPhone)}` : '—'], ['Notes', t.notes || '—'], ['Registered', date(t.createdAt)]]} />
            </div>
            <div className="stack">
              <h3>Current occupancy</h3>
              {t.currentContracts.length === 0 ? <Empty title="No current room">This tenant has no active contract.</Empty> : t.currentContracts.map((c: any) => (
                <DL key={c.id} items={[
                  ['Building', c.building.name], ['Floor', c.floor.name], ['Room', <Link to={`/rooms/${c.room.id}`}>{c.room.number}</Link>], ['Monthly rent', money(c.monthlyRent)],
                  ['Contract', <><Link to={`/contracts/${c.id}`}>{c.contractNumber}</Link> <Badge status={c.status} /></>], ['Period', `${date(c.startDate)} – ${date(c.endDate)}`],
                ]} />
              ))}
            </div>
          </div>
        )}
        {tab === 'payments' && (can('payment.view') ? <PaymentsTable params={{ tenantId: id }} showTenant={false} /> : <Empty title="You do not have access to payments" />)}
        {tab === 'ledger' && (can('rent.view') ? <LedgerTable params={{ tenantId: id }} /> : <Empty title="You do not have access to the rent ledger" />)}
        {tab === 'contract' && (
          <Table rows={t.contracts} onRow={(c: any) => navigate(`/contracts/${c.id}`)} empty={<Empty title="No contracts" />} columns={[
            { header: 'Contract', cell: (c: any) => c.contractNumber }, { header: 'Room', cell: (c: any) => `${c.room.number} · ${c.building.name}` },
            { header: 'Period', cell: (c: any) => `${date(c.startDate)} – ${date(c.terminatedOn ?? c.endDate)}` }, { header: 'Rent', num: true, cell: (c: any) => money(c.monthlyRent) },
            { header: 'Outstanding', num: true, cell: (c: any) => money(c.outstanding) }, { header: 'Status', cell: (c: any) => <Badge status={c.status} /> },
          ]} />
        )}
        {tab === 'documents' && <div className="card-body"><DocumentsPanel entityType="Tenant" entityId={id} defaultCategory="ID_DOCUMENT" /></div>}
        {tab === 'communication' && <Communication tenant={t} />}
        {tab === 'history' && <div className="card-body"><TimelinePanel entityType="Tenant" entityId={id} /></div>}
      </Card>

      {dialog === 'edit' && (
        <Modal title="Edit tenant" wide onClose={() => setDialog('')}>
          <AutoForm fields={TENANT_FIELDS} initial={Object.fromEntries(TENANT_FIELDS.map((f) => [f.name, t[f.name] ?? '']))} onCancel={() => setDialog('')} onSubmit={async (v) => { await save.mutateAsync(v); setDialog(''); }} />
        </Modal>
      )}
      {dialog === 'delete' && (
        <Confirm title={`Delete ${t.fullName}?`} danger confirmLabel="Delete permanently" onClose={() => setDialog('')} onConfirm={async () => { await del.mutateAsync(undefined as never); navigate('/tenants'); }}>
          {t.contracts.some((c: any) => c.status !== 'DRAFT') ? `${t.fullName} has contracts, so their rent and payment records must be kept and they cannot be deleted — you will be shown the details. If they have left, terminate the contract and they will be listed as Former.` : `${t.fullName} has no contracts or payments and will be removed permanently, with their documents.`}
        </Confirm>
      )}
      {dialog === 'blacklist' && <Confirm title={`Blacklist ${t.fullName}?`} confirmLabel="Blacklist tenant" danger reason="Reason (kept on record)" onClose={() => setDialog('')} onConfirm={(reason) => status.mutateAsync({ status: 'BLACKLISTED', reason })}>A blacklisted tenant cannot be given a new contract or have one renewed. This action is recorded in the audit log.</Confirm>}
      {dialog === 'unblacklist' && <Confirm title="Remove from blacklist?" confirmLabel="Remove from blacklist" reason="Reason" onClose={() => setDialog('')} onConfirm={(reason) => status.mutateAsync({ status: t.currentContracts.length ? 'BLACKLISTED' : 'FORMER', reason })}>{t.fullName} will be able to receive contracts again.</Confirm>}
    </div>
  );
}

// ───────────── Onboarding wizard (also used for "Create contract" with an existing tenant) ─────────────

/** Default contract end: the last day of the 12th month, so exactly twelve calendar months are billed. */
function defaultEnd(start: string): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + 12, 0)).toISOString().slice(0, 10);
}

/** Last day of the calendar month that is `months - 1` months after the start month. */
function lastDayAfterMonths(start: string, months: number): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + months, 0)).toISOString().slice(0, 10);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const STEPS = ['Tenant', 'Building', 'Floor', 'Room', 'Rent', 'Contract', 'Deposit', 'Documents', 'Review'];

export function Onboarding({ existing }: { existing?: boolean }) {
  const { can, me } = useAuth();
  const meta = useMeta();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const today = me!.organization.today;
  const [step, setStep] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [tenant, setTenant] = useState<Record<string, any>>({});
  const [tenantId, setTenantId] = useState(params.get('tenantId') ?? '');
  const [tenantSearch, setTenantSearch] = useState('');
  const [buildingId, setBuildingId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [roomId, setRoomId] = useState(params.get('roomId') ?? '');
  const [terms, setTerms] = useState<Record<string, any>>({ startDate: '', endDate: '', paymentDueDay: '', graceDays: '', specialTerms: '', customRent: false, monthlyRent: '', rentOverrideReason: '', paidNow: '', methodId: '', reference: '', manualEnd: false, remainder: 'credit' });
  const [deposit, setDeposit] = useState<Record<string, any>>({ depositAmount: '', payNow: false, paidAmount: '', methodId: '', reference: '' });
  const [files, setFiles] = useState<Array<{ file: File; category: string }>>([]);

  const phoneCheck = parsePhone(String(tenant.phone ?? ''));
  const idType = tenant.idType ?? 'NATIONAL_ID';
  const idTyped = useDebounced(String(tenant.idNumber ?? '').trim(), 350);
  const idQuery = useApi('/tenants/check-id', { idType, idNumber: idTyped }, !existing && idTyped.length > 0);
  const idCheck: { ok: boolean; message: string; existing: any } = !idTyped || !idQuery.data || idQuery.data.normalized !== idTyped.replace(/[\s\-./]/g, '').toUpperCase()
    ? { ok: false, message: '', existing: null }
    : idQuery.data.problem ? { ok: false, message: idQuery.data.problem, existing: null }
      : idQuery.data.existing ? { ok: false, message: `Already registered to ${idQuery.data.existing.fullName}.`, existing: idQuery.data.existing }
        : { ok: true, message: 'Valid and not registered yet', existing: null };
  const tinTyped = useDebounced(String(tenant.tin ?? '').trim(), 350);
  const tinQuery = useApi('/tenants/check-tin', { tin: tinTyped }, !existing && tinTyped.length > 0);
  const tinCheck: { ok: boolean; message: string; existing: any } = !tinTyped || !tinQuery.data || tinQuery.data.normalized !== tinTyped.replace(/[\s\-./]/g, '')
    ? { ok: false, message: '', existing: null }
    : tinQuery.data.problem ? { ok: false, message: tinQuery.data.problem, existing: null }
      : tinQuery.data.existing ? { ok: false, message: `Already registered to ${tinQuery.data.existing.fullName}.`, existing: tinQuery.data.existing }
        : { ok: true, message: 'Valid and not registered yet', existing: null };
  const missingAddress = ([['tin', 'TIN number'], ['district', 'district'], ['sector', 'sector'], ['cell', 'cell'], ['village', 'village']] as const).filter(([k]) => !String(tenant[k] ?? '').trim()).map(([, l]) => l);
  const term = useDebounced(tenantSearch);
  const [tenantPage, setTenantPage] = useState(1);
  useEffect(() => setTenantPage(1), [term]);
  const found = useApi('/tenants', { q: term, page: tenantPage, pageSize: 10 }, existing === true && !tenantId);
  const chosenTenant = useApi(`/tenants/${tenantId}`, undefined, Boolean(tenantId));
  const floors = useApi('/floors', { buildingId });
  const roomMap = useApi('/rooms/map', { buildingId });
  const [roomSearch, setRoomSearch] = useState('');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const preset = useApi(`/rooms/${roomId}`, undefined, Boolean(roomId));
  const room = preset.data;
  useEffect(() => {
    if (room && !buildingId) setBuildingId(room.building.id);
    if (room) setDeposit((d) => ({ ...d, depositAmount: d.depositAmount === '' ? String(Number(room.depositRequired)) : d.depositAmount }));
  }, [room]);
  useEffect(() => {
    if (meta.data) setTerms((t) => ({ ...t, paymentDueDay: t.paymentDueDay || meta.data.organization.defaultDueDay, graceDays: t.graceDays === '' ? meta.data.organization.defaultGraceDays : t.graceDays, endDate: t.endDate || defaultEnd(today) }));
  }, [meta.data]);

  const depositPaid = deposit.payNow ? Number(String(deposit.paidAmount).replace(/,/g, '')) || 0 : 0;
  const depositLeft = (Number(String(deposit.depositAmount).replace(/,/g, '')) || 0) - depositPaid;
  const rent = terms.customRent && terms.monthlyRent ? terms.monthlyRent : room ? Number(room.monthlyRent) : 0;
  // ── End date from the money paid: each full month's rent buys one calendar month, starting with the start month.
  const paidNow = Number(String(terms.paidNow ?? '').replace(/[,\s]/g, '')) || 0;
  const rentNum = Number(rent) || 0;
  const fullMonths = rentNum > 0 ? Math.floor(paidNow / rentNum) : 0;
  const leftOver = paidNow - fullMonths * rentNum;
  const coveredMonths = fullMonths + (leftOver > 0 && (terms.remainder === 'extend' || fullMonths < 1) ? 1 : 0);
  const canTakeRent = can('payment.create');
  const autoEnd = !terms.manualEnd && paidNow > 0 && coveredMonths > 0 && terms.startDate ? lastDayAfterMonths(terms.startDate, coveredMonths) : '';
  const endDate = terms.manualEnd || paidNow <= 0 ? terms.endDate : autoEnd;
  const paidMethod = (meta.data?.paymentMethods ?? []).find((m: any) => m.id === terms.methodId);
  const tenantName = existing ? chosenTenant.data?.fullName : tenant.fullName;
  const blockers: Array<string | false> = [
    existing ? !tenantId && 'Choose the tenant.' : (!tenant.fullName || !tenant.phone || !tenant.idNumber) ? 'Enter the tenant’s name, phone and ID number.' : phoneCheck.problem ? `Phone number: ${phoneCheck.problem}` : tenant.emergencyContactPhone && parsePhone(tenant.emergencyContactPhone).problem ? `Emergency contact phone: ${parsePhone(tenant.emergencyContactPhone).problem}` : !idCheck.ok ? (idCheck.message || 'Checking the ID number…')
      : missingAddress.length ? `Enter the tenant’s ${missingAddress.join(', ')} — they are printed on the contract.` : !tinCheck.ok && `TIN number: ${tinCheck.message || 'checking…'}`,
    false, false, !roomId && 'Select an available room.',
    terms.customRent && (!terms.monthlyRent || !terms.rentOverrideReason) && 'Enter the tenant-specific rent and the reason for it.',
    !terms.startDate ? 'Enter the day the tenant starts working.'
        : paidNow > 0 && coveredMonths > 1 && !can('payment.advance') ? 'Only a manager or accountant can record rent paid for more than one month in advance.'
        : paidNow > 0 && !terms.methodId ? 'Choose how the tenant paid.'
          : paidNow > 0 && paidMethod?.requiresReference && !String(terms.reference ?? '').trim() ? `Enter the ${paidMethod.name} transaction reference.`
            : (!endDate || endDate < terms.startDate) ? 'Enter the amount the tenant is paying, or set an end date after the start date.' : false,
    deposit.payNow && (depositPaid <= 0 ? 'Enter how much of the deposit was paid now.' : depositLeft < 0 ? 'The amount paid now is more than the deposit required.' : !deposit.methodId && 'Choose how the deposit was paid.'), false, false,
  ];
  const next = () => { if (blockers[step]) { setError(new Error()); return; } setError(null); setStep(step === 2 && roomId ? 4 : step + 1); };
  const prev = () => setStep(step === 4 ? 2 : step - 1);

  /** Registers just the tenant (no room, no contract). A room can be assigned later from the tenant's page. */
  async function saveTenantOnly() {
    if (blockers[0]) { setError(new Error()); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await api.post('/tenants', tenant);
      await qc.invalidateQueries();
      toast(`${created.fullName} registered. Assign a room with “New contract” when ready.`);
      navigate(`/tenants/${created.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const [paymentKey] = useState(() => newSubmissionKey());

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      let id = tenantId;
      if (!existing && !id) {
        id = (await api.post('/tenants', tenant)).id;
        setTenantId(id); // if a later step fails, a retry reuses this tenant instead of creating a duplicate
      }
      const contract = await api.post('/contracts', {
        tenantId: id, roomId, startDate: terms.startDate, endDate, paymentDueDay: terms.paymentDueDay || undefined, graceDays: terms.graceDays === '' ? undefined : terms.graceDays,
        specialTerms: terms.specialTerms, depositAmount: deposit.depositAmount === '' ? undefined : deposit.depositAmount, activate: true,
        ...(terms.customRent ? { monthlyRent: terms.monthlyRent, rentOverrideReason: terms.rentOverrideReason } : {}),
      });
      const problems: string[] = [];
      if (paidNow > 0) {
        // Applied month by month from the start month; anything beyond the last month stays as visible credit.
        await api.post('/payments', {
          contractId: contract.id, amount: paidNow, methodId: terms.methodId, reference: String(terms.reference ?? '').trim(), overpayment: 'ADVANCE',
          idempotencyKey: paymentKey, notes: 'Paid when the contract was created',
        }).catch((e) => problems.push(`Rent payment not recorded: ${e.message} Record it from the contract page.`));
      }
      if (deposit.payNow && depositPaid > 0) {
        await api.post(`/contracts/${contract.id}/deposits`, { amount: depositPaid, methodId: deposit.methodId, reference: deposit.reference }).catch((e) => problems.push(`Deposit not recorded: ${e.message}`));
      }
      for (const f of files) {
        const form = new FormData();
        form.set('entityType', f.category === 'CONTRACT' ? 'Contract' : 'Tenant');
        form.set('entityId', f.category === 'CONTRACT' ? contract.id : id);
        form.set('category', f.category);
        form.set('file', f.file);
        await api.post('/documents', form).catch((e) => problems.push(`${f.file.name}: ${e.message}`));
      }
      toast(problems.length ? `Contract ${contract.contractNumber} created, but: ${problems.join(' ')}` : `Contract ${contract.contractNumber} created. ${tenantName} now occupies room ${room?.number}.`, problems.length ? 'error' : 'ok');
      await qc.invalidateQueries();
      navigate(`/contracts/${contract.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const input = (obj: Record<string, any>, set: (v: Record<string, any>) => void, name: string, text: string, type = 'text', extra: Record<string, any> = {}) => (
    <Field label={text} required={extra.required} hint={extra.hint}>
      {(fid) => <input id={fid} className="input" type={type === 'money' ? 'text' : type} inputMode={type === 'money' ? 'decimal' : undefined} value={obj[name] ?? ''} onChange={(e) => set({ ...obj, [name]: e.target.value })} {...(extra.min ? { min: extra.min } : {})} />}
    </Field>
  );

  const roomList = (step === 2 || step === 3) && (() => {
            const term = roomSearch.trim().toLowerCase();
            const groups = (roomMap.data?.buildings ?? []).flatMap((b: any) => b.floors.filter((f: any) => !floorId || f.id === floorId).map((f: any) => ({
              building: b, floor: f,
              rooms: f.rooms.filter((r: any) => (!term || r.number.toLowerCase().includes(term)) && (!onlyAvailable || r.status === 'VACANT' || r.id === roomId)),
            }))).filter((g: any) => g.rooms.length > 0);
            const all = (roomMap.data?.buildings ?? []).flatMap((b: any) => b.floors.flatMap((f: any) => f.rooms));
            return (
              <div className="stack tight">
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <TextInput label="Find a room number" value={roomSearch} onChange={setRoomSearch} placeholder="e.g. B3 01" />
                  <label className="check" style={{ paddingBottom: 8 }}><input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} /> Show available rooms only</label>
                  <span className="muted small" style={{ marginLeft: 'auto', paddingBottom: 8 }}>{all.filter((r: any) => r.status === 'VACANT').length} available of {all.length} rooms</span>
                </div>
                <p className="muted small">{step === 2 ? 'Choose a floor to narrow the list, or pick a room straight away. ' : ''}All rooms are listed with their number, rent and status. Only vacant rooms can be chosen; occupied ones show who is in them.</p>
                {!roomMap.data ? <Loading /> : groups.length === 0 ? <Empty title="No rooms match">Change the search, or go back and choose another building or floor.</Empty> : (
                  <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 12, maxHeight: 420, overflowY: 'auto' }}>
                    <table className="table">
                      <thead><tr><th scope="col">Room</th><th scope="col" className="num">Monthly rent</th><th scope="col">Status</th><th scope="col">Current tenant</th><th scope="col"><span className="sr-only">Choose</span></th></tr></thead>
                      {groups.map((g: any) => (
                        <tbody key={g.floor.id}>
                          <tr><th colSpan={5} scope="colgroup" style={{ textAlign: 'left' }}>{g.building.name} — {g.floor.name}</th></tr>
                          {g.rooms.map((r: any) => {
                            const ok = r.status === 'VACANT' || (r.status === 'RESERVED' && r.id === roomId);
                            const chosen = roomId === r.id;
                            const pick = () => { setBuildingId(g.building.id); setRoomId(r.id); setDeposit({ ...deposit, depositAmount: '' }); };
                            return (
                              <tr key={r.id} className={ok ? 'click' : ''} onClick={ok ? pick : undefined} aria-selected={chosen} style={{ background: chosen ? 'var(--accent-soft)' : undefined, opacity: ok ? 1 : 0.6 }}>
                                <td className="strong">{r.number}</td>
                                <td className="num">{money(r.monthlyRent)}</td>
                                <td><Badge status={r.status} /></td>
                                <td>{r.tenantName ?? <span className="muted">—</span>}</td>
                                <td className="num">{ok ? <Button size="sm" variant={chosen ? 'primary' : undefined} onClick={(e) => { e.stopPropagation(); pick(); }} aria-pressed={chosen}>{chosen ? '✓ Selected' : 'Select'}</Button> : <span className="muted small">Not available</span>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      ))}
                    </table>
                  </div>
                )}
              </div>
            );
          })();

  return (
    <div className="stack">
      <PageHead title={existing ? 'Create contract' : 'Add tenant'} sub="Step-by-step registration: tenant, room, contract, deposit and documents." />
      <ol className="steps" aria-label="Progress">
        {STEPS.map((s, i) => <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</li>)}
      </ol>
      {step < STEPS.length - 1 && (
        <Alert tone="blue"><strong>Nothing is saved yet.</strong> The {existing ? 'contract is' : 'tenant and contract are'} created only when you press “{existing ? 'Create contract' : 'Create tenant and contract'}” on the last step (step {STEPS.length}).</Alert>
      )}
      <Card title={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}>
        <div className="stack">
          {error instanceof Error && !(error as any).status && blockers[step] ? <Alert>{blockers[step]}</Alert> : <ErrorBox error={(error as any)?.message ? error : null} />}
          {step === 0 && (existing ? (
            <div className="stack">
              {tenantId && chosenTenant.data ? (
                <div className="alert green"><div className="grow">Tenant: <strong>{chosenTenant.data.fullName}</strong> · {chosenTenant.data.phone} · ID {chosenTenant.data.idNumber} <Badge status={chosenTenant.data.status} /></div><Button size="sm" onClick={() => setTenantId('')}>Change</Button></div>
              ) : null}
              {tenantId && chosenTenant.data && ['tin', 'district', 'sector', 'cell', 'village'].some((k) => !chosenTenant.data[k]) ? (
                <div className="alert amber"><div className="grow">This tenant has no {['tin', 'district', 'sector', 'cell', 'village'].filter((k) => !chosenTenant.data[k]).map((k) => (k === 'tin' ? 'TIN number' : k)).join(', ')} yet, so the contract will show dotted lines there. Add them on the tenant page (Edit) before printing.</div><Link className="btn sm" to={`/tenants/${tenantId}`}>Open tenant</Link></div>
              ) : null}
              {tenantId && chosenTenant.data ? null : (
                <>
                  <div className="row" style={{ alignItems: 'flex-end' }}>
                    <TextInput wide label="Search tenants" value={tenantSearch} onChange={setTenantSearch} placeholder="Name, phone, ID number or business" />
                    <span className="muted small" style={{ paddingBottom: 8 }}>{found.data ? `${found.data.total} tenant${found.data.total === 1 ? '' : 's'}${term ? ' found' : ' registered'}` : ''}</span>
                    {can('tenant.manage') && <Link to="/tenants/new" className="btn" style={{ marginLeft: 'auto' }}>Register a new tenant</Link>}
                  </div>
                  <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                    <Table rows={found.data?.items} onRow={(t: any) => { if (t.status !== 'BLACKLISTED') setTenantId(t.id); }}
                      empty={<Empty title={term ? `No tenant matches “${term}”` : 'No tenants registered yet'}>{can('tenant.manage') && <Link to="/tenants/new">Register a new tenant</Link>}</Empty>} columns={[
                        { header: 'Tenant', cell: (t: any) => <><span className="strong">{t.fullName}</span>{t.businessName && <div className="muted small">{t.businessName}</div>}</> },
                        { header: 'Phone', cell: (t: any) => <span className="nowrap">{phone(t.phone)}</span> }, { header: 'ID number', cell: (t: any) => t.idNumber, hideSm: true },
                        { header: 'Current room', cell: (t: any) => t.currentContracts.length ? t.currentContracts.map((c: any) => `${c.room.number} · ${c.building.name}`).join('; ') : <span className="muted">None</span> },
                        { header: 'Status', cell: (t: any) => <Badge status={t.status} /> },
                        { header: '', cell: (t: any) => t.status === 'BLACKLISTED' ? <span className="muted small">Blacklisted</span> : <Button size="sm" onClick={(e) => { e.stopPropagation(); setTenantId(t.id); }}>Select</Button> },
                      ]} />
                    <Pager data={found.data} onPage={setTenantPage} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="form-grid">
              {input(tenant, setTenant, 'fullName', 'Full name', 'text', { required: true })}
              <Field label="Phone number" required error={tenant.phone && phoneCheck.problem ? phoneCheck.problem : undefined} hint={phoneCheck.e164 ? <span style={{ color: 'var(--green)' }}>✓ Will be saved as {phone(phoneCheck.e164)}</span> : 'Rwandan number such as 078 812 3456, or + and country code for other countries.'}>
                {(fid) => <input id={fid} className={`input ${tenant.phone && phoneCheck.problem ? 'invalid' : ''}`} type="tel" inputMode="tel" placeholder="078 812 3456" value={tenant.phone ?? ''} onChange={(e) => setTenant({ ...tenant, phone: e.target.value })} aria-invalid={Boolean(tenant.phone && phoneCheck.problem)} />}
              </Field>
              <Select label="ID type" value={tenant.idType ?? 'NATIONAL_ID'} onChange={(v) => setTenant({ ...tenant, idType: v })} options={enumOpts(['NATIONAL_ID', 'PASSPORT', 'OTHER'])} />
              <Field label="ID / passport number" required error={idCheck.message && !idCheck.ok ? idCheck.message : undefined}
                hint={idCheck.ok ? <span style={{ color: 'var(--green)' }}>✓ {idCheck.message}</span> : idType === 'NATIONAL_ID' ? '16-digit Rwandan national ID, e.g. 1 1990 8 0012345 6 78' : 'Passport number as printed in the passport'}>
                {(fid) => <input id={fid} className={`input ${idCheck.message && !idCheck.ok ? 'invalid' : ''}`} value={tenant.idNumber ?? ''} inputMode={idType === 'NATIONAL_ID' ? 'numeric' : undefined} autoComplete="off"
                  onChange={(e) => setTenant({ ...tenant, idNumber: e.target.value })} aria-invalid={Boolean(idCheck.message && !idCheck.ok)} />}
              </Field>
              {idCheck.existing && <div className="full alert red"><div className="grow"><strong>{idCheck.existing.fullName}</strong> is already registered with this ID number. One ID number can belong to only one tenant.</div><Link className="btn sm" to={`/tenants/${idCheck.existing.id}`}>Open {idCheck.existing.fullName}</Link></div>}{input(tenant, setTenant, 'email', 'E-mail', 'email')}{input(tenant, setTenant, 'businessName', 'Business / company name')}
              <Field label="TIN number" required error={tinCheck.message && !tinCheck.ok ? tinCheck.message : undefined}
                hint={tinCheck.ok ? <span style={{ color: 'var(--green)' }}>✓ {tinCheck.message}</span> : '9 digits, from the RDB certificate. One TIN can belong to only one tenant.'}>
                {(fid) => <input id={fid} className="input" inputMode="numeric" value={tenant.tin ?? ''} onChange={(e) => setTenant({ ...tenant, tin: e.target.value })} />}
              </Field>
              {tinCheck.existing && <div className="full alert red"><div className="grow"><strong>{tinCheck.existing.fullName}</strong> is already registered with this TIN. One TIN can belong to only one tenant.</div><Link className="btn sm" to={`/tenants/${tinCheck.existing.id}`}>Open {tinCheck.existing.fullName}</Link></div>}
              {input(tenant, setTenant, 'district', 'District (Akarere)', 'text', { required: true })}{input(tenant, setTenant, 'sector', 'Sector (Umurenge)', 'text', { required: true })}{input(tenant, setTenant, 'cell', 'Cell (Akagari)', 'text', { required: true })}{input(tenant, setTenant, 'village', 'Village (Umudugudu)', 'text', { required: true })}{input(tenant, setTenant, 'address', 'Address (optional)')}{input(tenant, setTenant, 'emergencyContactName', 'Emergency contact name')}{input(tenant, setTenant, 'emergencyContactPhone', 'Emergency contact phone (optional)', 'tel', { hint: tenant.emergencyContactPhone && parsePhone(tenant.emergencyContactPhone).problem ? parsePhone(tenant.emergencyContactPhone).problem : undefined })}
            </div>
          ))}
          {step === 1 && <Select label="Building" value={buildingId} onChange={(v) => { setBuildingId(v); setFloorId(''); setRoomId(''); }} all="All buildings" options={opts(meta.data?.buildings?.filter((b: any) => b.status === 'ACTIVE'))} />}
          {step === 2 && (
            <div className="stack">
              <Select label="Floor" value={floorId} onChange={(v) => { setFloorId(v); setRoomId(''); }} all="All floors" options={(floors.data?.items ?? []).map((f: any) => ({ value: f.id, label: `${buildingId ? '' : `${f.building.name} — `}${f.name} — ${f.roomCount - f.occupiedCount} of ${f.roomCount} rooms not occupied` }))} />
              {roomList}
            </div>
          )}
          {step === 3 && roomList}
          {step === 4 && room && (
            <div className="stack">
              <DL items={[['Room', `${room.number} — ${room.floor.name}, ${room.building.name}`], ['Standard monthly rent', <span className="big-amount">{money(room.monthlyRent)}</span>]]} />
              <p className="muted">The rent is taken from the room automatically. You do not need to type it.</p>
              {can('contract.rent.override') && (
                <>
                  <label className="check"><input type="checkbox" checked={terms.customRent} onChange={(e) => setTerms({ ...terms, customRent: e.target.checked })} /> Use a different rent for this tenant (requires a reason; recorded in the audit log)</label>
                  {terms.customRent && <div className="form-grid">{input(terms, setTerms, 'monthlyRent', 'Tenant-specific monthly rent (RWF)', 'money', { required: true })}{input(terms, setTerms, 'rentOverrideReason', 'Reason', 'text', { required: true })}</div>}
                </>
              )}
            </div>
          )}
          {step === 5 && (
            <div className="stack">
              <div className="form-grid">
                {input(terms, setTerms, 'startDate', 'Day the tenant starts working', 'date', { required: true, hint: 'Rent and the contract (Ingingo 8) are counted from this day — not from the day the payment is recorded.' })}
                {canTakeRent ? input(terms, setTerms, 'paidNow', 'Rent the tenant is paying now (RWF)', 'money', { hint: `Monthly rent ${money(rentNum)}. The end date is worked out from this amount.` }) : <p className="muted small">Rent payments are recorded by finance staff after the contract is created.</p>}
                {paidNow > 0 && <>
                  <Select label="Paid by *" value={terms.methodId} onChange={(v) => setTerms({ ...terms, methodId: v })} all="Select…" options={opts(meta.data?.paymentMethods?.filter((m: any) => m.isActive))} />
                  {input(terms, setTerms, 'reference', `Transaction reference${paidMethod?.requiresReference ? ' *' : ''}`, 'text')}
                </>}
              </div>

              {paidNow > 0 && !terms.manualEnd && (coveredMonths >= 1 ? (
                <div className="alert green">
                  <div className="grow stack tight">
                    <span><strong>{money(paidNow)}</strong> ÷ {money(rentNum)} a month = <strong>{fullMonths} month{fullMonths === 1 ? '' : 's'}</strong>{leftOver > 0 ? <> and {money(leftOver)} more</> : ''}.</span>
                    <span>Contract: <strong>{date(terms.startDate)} – {date(autoEnd)}</strong> ({monthName(terms.startDate)}{coveredMonths > 1 ? ` – ${monthName(autoEnd)}` : ''}, {coveredMonths} month{coveredMonths === 1 ? '' : 's'}).</span>
                  </div>
                </div>
              ) : <Alert>{money(paidNow)} is less than one month’s rent ({money(rentNum)}).</Alert>)}

              {paidNow > 0 && !terms.manualEnd && leftOver > 0 && fullMonths >= 0 && (
                <fieldset className="stack tight" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: '10px 14px' }}>
                  <legend className="small strong">The extra {money(leftOver)} is not a full month. What should happen?</legend>
                  {fullMonths >= 1 && <label className="check"><input type="radio" name="remainder" checked={terms.remainder === 'credit'} onChange={() => setTerms({ ...terms, remainder: 'credit' })} /> End after {fullMonths} month{fullMonths === 1 ? '' : 's'}; keep {money(leftOver)} as credit for the tenant</label>}
                  <label className="check"><input type="radio" name="remainder" checked={terms.remainder === 'extend' || fullMonths < 1} onChange={() => setTerms({ ...terms, remainder: 'extend' })} /> Run {fullMonths + 1} month{fullMonths + 1 === 1 ? '' : 's'}; the last month is part-paid and {money(rentNum - leftOver)} is still owed</label>
                </fieldset>
              )}

              <label className="check"><input type="checkbox" checked={terms.manualEnd} onChange={(e) => setTerms({ ...terms, manualEnd: e.target.checked, endDate: terms.endDate || autoEnd || defaultEnd(terms.startDate || today) })} /> Set the end date myself</label>
              {(terms.manualEnd || paidNow <= 0) && <div className="form-grid">{input(terms, setTerms, 'endDate', 'End date', 'date', { required: true, min: terms.startDate, hint: paidNow <= 0 ? 'No payment entered, so choose the end date.' : undefined })}</div>}

              <div className="form-grid">
                {input(terms, setTerms, 'paymentDueDay', 'Rent due on day of month', 'number', { hint: '1–31' })}{input(terms, setTerms, 'graceDays', 'Grace period (days)', 'number', { hint: 'Days after the due date before rent counts as overdue.' })}
                <Field label="Special terms" full>{(fid) => <textarea id={fid} className="input" value={terms.specialTerms} onChange={(e) => setTerms({ ...terms, specialTerms: e.target.value })} />}</Field>
              </div>
            </div>
          )}
          {step === 6 && (
            <div className="stack">
              <Alert tone="blue"><strong>This step is for the security deposit only — it is not rent.</strong> A deposit is money held for the tenant and returned when they leave. Rent payments (full or partial) are recorded after the contract is created, with “Record payment”.</Alert>
              <div className="form-grid">{input(deposit, setDeposit, 'depositAmount', 'Security deposit required (RWF)', 'money', { hint: 'The total deposit this tenant must pay. Leave 0 if there is no deposit.' })}</div>
              {can('deposit.manage') && Number(deposit.depositAmount) > 0 && (
                <>
                  <label className="check"><input type="checkbox" checked={deposit.payNow} onChange={(e) => setDeposit({ ...deposit, payNow: e.target.checked, paidAmount: e.target.checked && deposit.paidAmount === '' ? deposit.depositAmount : deposit.paidAmount })} /> The tenant is paying some or all of the deposit now</label>
                  {deposit.payNow && <div className="form-grid">
                    {input(deposit, setDeposit, 'paidAmount', 'Deposit amount paid now (RWF)', 'money', { required: true, hint: depositLeft > 0 ? `Partial: ${money(depositLeft)} of the deposit will still be owed.` : depositLeft < 0 ? 'This is more than the deposit required.' : 'The deposit is paid in full.' })}
                    <Select label="Payment method" value={deposit.methodId} onChange={(v) => setDeposit({ ...deposit, methodId: v })} all="Select…" options={opts(meta.data?.paymentMethods?.filter((m: any) => m.isActive))} />
                    {input(deposit, setDeposit, 'reference', 'Transaction reference')}
                  </div>}
                </>
              )}
            </div>
          )}
          {step === 7 && (
            <div className="stack">
              <p className="muted">Optional. Attach the tenant’s ID and the signed contract (PDF, JPG, PNG — max 10 MB each). They are uploaded when the tenant is created.</p>
              {['ID_DOCUMENT', 'CONTRACT', 'PHOTO'].map((category) => (
                <Field key={category} label={label(category)}>{(fid) => <input id={fid} type="file" className="input" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" onChange={(e) => { const file = e.target.files?.[0]; setFiles((fs) => [...fs.filter((f) => f.category !== category), ...(file ? [{ file, category }] : [])]); }} />}</Field>
              ))}
            </div>
          )}
          {step === 8 && (
            <div className="stack">
              <DL items={[
                ['Tenant', <strong>{tenantName}</strong>], ['Room', room ? `${room.number} — ${room.floor.name}, ${room.building.name}` : '—'],
                ['Monthly rent', <strong>{money(rent)}</strong>], ...(terms.customRent ? [['Rent differs from room rent', `${money(room?.monthlyRent)} → ${money(rent)} (${terms.rentOverrideReason})`] as [string, string]] : []),
                ['Contract period', `${date(terms.startDate)} – ${date(endDate)}`], ['Rent paid now', paidNow > 0 ? `${money(paidNow)} by ${paidMethod?.name ?? '—'}${terms.reference ? ` (ref. ${terms.reference})` : ''} — covers ${fullMonths} full month${fullMonths === 1 ? '' : 's'}${leftOver > 0 ? ` + ${money(leftOver)}` : ''}` : 'Nothing — record payments after creating the contract'], ['Rent due', `Day ${terms.paymentDueDay} of each month, ${terms.graceDays} day(s) grace`],
                ['Security deposit required', money(deposit.depositAmount || 0)],
                ...(Number(deposit.depositAmount) > 0 ? [['Deposit paid now', depositPaid <= 0 ? 'Nothing yet' : depositLeft > 0 ? <><strong>{money(depositPaid)}</strong> — partial, {money(depositLeft)} still to pay</> : <><strong>{money(depositPaid)}</strong> — paid in full</>] as [string, any]] : []),
                ['Rent paid', 'None recorded here. Record the first rent payment (full or partial) after creating the contract.'], ['Documents', files.length ? files.map((f) => f.file.name).join(', ') : 'None'],
              ]} />
              <div className="alert blue"><div>Creating the contract will mark room {room?.number} as <strong>Occupied</strong> and generate rent charges from {date(terms.startDate)}{terms.startDate < monthRange(today).from ? ' (including past months, which will show as owing)' : ''}.</div></div>
            </div>
          )}
          <div className="row between">
            <Button onClick={() => (step === 0 ? navigate(-1) : prev())} disabled={busy}>{step === 0 ? 'Cancel' : 'Back'}</Button>
            {step === 0 && !existing && can('tenant.manage') && (
              <Button busy={busy} style={{ marginLeft: 'auto' }} title="Register the tenant now and assign a room later" onClick={saveTenantOnly}>Save tenant only (no room yet)</Button>
            )}
            {step < STEPS.length - 1 ? <Button variant="primary" onClick={next}>Continue</Button> : <Button variant="primary" busy={busy} onClick={finish}>{existing ? 'Create contract' : 'Create tenant and contract'}</Button>}
          </div>
        </div>
      </Card>
    </div>
  );
}
