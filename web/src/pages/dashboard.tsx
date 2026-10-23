import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { date, dateTime, money, percent, phone, tenancyPeriod } from '../format';
import { useApi } from '../shared';
import { I, type IconName } from '../icons';
import { Alert, Badge, Button, Card, DL, Empty, ErrorBox, Loading, Modal, PageHead, Stat, Table } from '../ui';

export function QuickActions() {
  const { can } = useAuth();
  const actions: Array<[string, string, string]> = [
    ['Record Payment', '/payments/new', 'payment.create'], ['Add Tenant', '/tenants/new', 'tenant.manage'], ['Create Contract', '/contracts/new', 'contract.manage'],
    ['Add Expense', '/expenses?new=1', 'expense.create'], ['Add Maintenance Request', '/maintenance?new=1', 'maintenance.manage'],
    ['Register Room', '/rooms?new=1', 'room.manage'], ['Generate Report', '/reports', 'report.view'],
  ];
  const allowed = actions.filter(([, , p]) => can(p) || (p === 'report.view' && can('report.financial')));
  if (!allowed.length) return null;
  return (
    <div className="row no-print" aria-label="Quick actions">
      {allowed.map(([text, to], i) => <Link key={to} to={to} className={`btn ${i === 0 ? 'primary' : ''}`}>{text}</Link>)}
    </div>
  );
}

function RoomPopup({ room, onClose }: { room: any; onClose: () => void }) {
  const q = useApi(`/rooms/${room.id}`);
  const navigate = useNavigate();
  const r = q.data;
  return (
    <Modal title={`Room ${room.number}`} onClose={onClose} footer={<>
      <Button onClick={onClose}>Close</Button>
      <Button variant="primary" onClick={() => navigate(`/rooms/${room.id}`)}>Open room page</Button>
    </>}>
      {!r ? <Loading /> : (
        <DL items={[
          ['Building', r.building.name], ['Floor', r.floor.name], ['Status', <Badge status={r.status} />], ['Monthly rent', money(r.monthlyRent)],
          ['Current tenant', r.currentContract ? <Link to={`/tenants/${r.currentContract.tenant.id}`}>{r.currentContract.tenant.fullName}</Link> : 'None'],
          ['Contract', r.currentContract ? <>{r.currentContract.contractNumber} · {tenancyPeriod(r.currentContract)} <Badge status={r.currentContract.status} /></> : '—'],
          ['Outstanding balance', <span className={Number(r.financial.outstanding) > 0 ? 'strong' : ''}>{money(r.financial.outstanding)}</span>],
          ['Of which overdue', money(r.financial.overdue)], ['Open maintenance', r.openMaintenance],
          ['Previous occupants', r.contracts.filter((c: any) => c.id !== r.currentContract?.id).length],
        ]} />
      )}
    </Modal>
  );
}

/** Visual room-status map. Status is written on every tile; colour only reinforces it. */
export function RoomMap() {
  const { buildingId } = useAuth();
  const q = useApi('/rooms/map', { buildingId });
  const [selected, setSelected] = useState<any>(null);
  const short: Record<string, string> = { OCCUPIED: 'Occupied', VACANT: 'Vacant', RESERVED: 'Reserved', MAINTENANCE: 'Maint.', INACTIVE: 'Inactive' };
  return (
    <Card title="Room map" actions={
      <div className="legend">
        {['OCCUPIED', 'VACANT', 'RESERVED', 'MAINTENANCE'].map((s) => <Badge key={s} status={s} />)}
        <span><span aria-hidden="true" style={{ borderBottom: '3px solid var(--red)', padding: '0 6px' }}>&nbsp;</span> rent owing</span>
      </div>}>
      <ErrorBox error={q.error} />
      {!q.data ? <Loading /> : q.data.buildings.length === 0 ? <Empty title="No buildings yet">Register a building, its floors and rooms to see them here.</Empty> : (
        <div className="stack">
          {q.data.buildings.map((b: any) => (
            <div key={b.id}>
              <h3 style={{ marginBottom: 4 }}>{b.name}</h3>
              {b.floors.map((f: any) => (
                <div className="map-floor" key={f.id}>
                  <div className="muted small strong">{f.name}</div>
                  <div className="map-rooms">
                    {f.rooms.length === 0 && <span className="muted small">No rooms</span>}
                    {f.rooms.map((r: any) => (
                      <button type="button" key={r.id} className={`room-chip ${r.status} ${Number(r.outstanding) > 0 ? 'owing' : ''}`} onClick={() => setSelected(r)}
                        title={`${r.tenantName ?? 'No tenant'} · rent ${money(r.monthlyRent)}${Number(r.outstanding) > 0 ? ` · owes ${money(r.outstanding)}` : ''}`}>
                        <b>{r.number}</b>{short[r.status]}{Number(r.outstanding) > 0 && <span className="sr-only"> — rent owing</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {selected && <RoomPopup room={selected} onClose={() => setSelected(null)} />}
    </Card>
  );
}

/** "1 room", "3 rooms". */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type Tone = 'red' | 'amber' | 'purple' | 'cyan' | 'blue';

/** An operational alert. Zero is a calm, neutral state — the status colour appears only when something is waiting. */
function AlertTile({ n, text, to, tone, icon }: { n: number; text: string; to: string; tone: Tone; icon: IconName }) {
  const navigate = useNavigate();
  return <Stat icon={<I name={icon} />} tone={n === 0 ? undefined : tone} k={text} v={<span className={n === 0 ? 'zero' : 'alert-n'}>{n}</span>} s={n === 0 ? 'Nothing waiting' : 'View →'} onClick={() => navigate(to)} />;
}

export function Dashboard() {
  const { buildingId, me, can } = useAuth();
  const q = useApi('/dashboard', { buildingId });
  const navigate = useNavigate();
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading what="Loading dashboard" />;
  const d = q.data;
  const f = d.financial;
  const failing = (d.reconciliation ?? []).filter((c: any) => !c.ok);
  return (
    <div className="stack">
      {/* Aerial photo of the Kigali Convention Centre behind the whole dashboard (credited on the sign-in page). */}
      <div className="dash-wallpaper" aria-hidden="true" />
      <PageHead title="Dashboard" sub={`${d.month} · as of ${date(d.today)}`}><QuickActions /></PageHead>

      {failing.length > 0 && (
        <Alert>
          <strong>Reconciliation warning.</strong> The figures below may not be reliable until this is investigated:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{failing.map((c: any) => <li key={c.name}>{c.detail}</li>)}</ul>
        </Alert>
      )}

      <section aria-label="Property overview" className="grid c4">
        <Stat icon={<I name="building" />} k="Buildings" v={d.property.buildings} s={`${count(d.property.floors, 'floor')} in total`} onClick={() => navigate('/buildings')} />
        <Stat icon={<I name="door" />} k="Rooms" v={d.property.rooms}
          s={d.property.reserved || d.property.maintenance ? `${count(d.property.reserved, 'room')} reserved · ${count(d.property.maintenance, 'room')} under maintenance` : 'None reserved or under maintenance'}
          onClick={() => navigate('/rooms')} />
        <Stat icon={<I name="half" />} k="Rooms rented" v={`${d.property.occupied} of ${d.property.rooms}`}
          s={`${percent(d.property.occupancyRate)} rented · ${d.property.vacant ? `${count(d.property.vacant, 'room')} empty — view →` : 'no empty rooms'}`}
          onClick={() => navigate('/rooms?status=VACANT')} />
        <Stat icon={<I name="users" />} k="Tenants with a current contract" v={d.property.tenants} onClick={() => navigate('/tenants?status=ACTIVE')} />
      </section>

      {f && (
        <>
          <section aria-label="Financial overview" className="grid c4">
            <Stat icon={<I name="coin" />} k={`Expected rent — ${d.month}`} v={money(f.expected)} s={`Next month (forecast): ${money(f.expectedNextMonth)}`} />
            <Stat icon={<I name="wallet" />} tone="teal" k="Collected towards this month" v={money(f.collected)} s={`Collection rate ${percent(f.collectionRate)}`} />
            <Stat icon={<I name="clock" />} tone={Number(f.outstanding) > 0 ? 'amber' : undefined} k="Outstanding for this month" v={money(f.outstanding)} s={`All overdue rent: ${money(f.totalOverdue)}${f.averageDaysOverdue != null ? ` · avg ${f.averageDaysOverdue} days` : ''}`} />
            <Stat icon={<I name="trend" />} k="Expenses · net income" v={money(f.net)} s={`Approved expenses ${money(f.expenses)}`} />
          </section>
          <section aria-label="Collections" className="grid c3">
            <Stat icon={<I name="calendar" />} k="Collected yesterday" v={money(f.collectedYesterday)} s={f.paymentsYesterday ? `${f.paymentsYesterday} transaction(s)` : 'No transactions'} />
            <Stat icon={<I name="wallet" />} tone="teal" k="Collected today" v={money(f.collectedToday)} s={f.paymentsToday ? `${f.paymentsToday} transaction(s)` : 'No transactions yet'} onClick={() => navigate('/daily')} />
            <Stat icon={<I name="clock" />} k="Falling due today" v={money(f.dueToday)} s={f.dueTodayCount ? `${f.dueTodayCount} charge(s)` : 'Nothing due today'} />
          </section>
          <Card title={`Collection by building — ${d.month}`} actions={can('report.financial') ? <Link to="/reports?type=consolidated" className="btn sm">Consolidated report</Link> : undefined}>
            {f.byBuilding.every((b: any) => Number(b.expected) === 0) && (
              <div className="empty soft"><span className="stat-icon" aria-hidden="true"><I name="chart" /></span><strong>No collection data available yet</strong>Rent billed and collected for {d.month} will appear here, building by building.</div>
            )}
            {f.byBuilding.some((b: any) => Number(b.expected) > 0) && f.byBuilding.map((b: any) => {
              const share = Number(b.expected) > 0 ? Math.min(100, (Number(b.collected) / Number(b.expected)) * 100) : 0;
              return (
                <div className="meter-row" key={b.id}>
                  <div className="strong">{b.name}<div className="muted small" style={{ fontWeight: 400 }}>{b.occupancy.occupied}/{b.occupancy.total} rooms occupied</div></div>
                  <div className="meter" role="img" aria-label={`${b.name}: ${money(b.collected)} collected of ${money(b.expected)} expected`} title={`${money(b.collected)} of ${money(b.expected)}`}><span style={{ width: `${share}%` }} /></div>
                  <div className="num small"><span className="strong">{money(b.collected)}</span> of {money(b.expected)} · {percent(b.collectionRate)}</div>
                </div>
              );
            })}
            <p className="muted small" style={{ marginTop: 8 }}>Bar = rent collected as a share of rent expected for the month. Exact figures are on the right.</p>
          </Card>
        </>
      )}

      <section aria-label="Alerts">
        <h2 style={{ marginBottom: 8 }}>Needs attention</h2>
        <div className="grid c4">
          <AlertTile n={d.alerts.overdueTenants} text="Overdue rent charges" to="/rent?overdueOnly=true" tone="red" icon="alert" />
          <AlertTile n={d.alerts.partialPayments} text="Partial payments" to="/rent?status=PARTIAL" tone="amber" icon="half" />
          <AlertTile n={d.alerts.contractsExpiring} text="Contracts expiring or expired" to="/contracts?status=EXPIRING" tone="purple" icon="file" />
          <AlertTile n={d.alerts.missingEbm} text="Payments with no EBM/invoice reference" to="/invoices?missingEbm=true" tone="cyan" icon="receipt" />
          <AlertTile n={d.alerts.openMaintenance} text={`Open maintenance issues${d.alerts.criticalMaintenance ? ` (${d.alerts.criticalMaintenance} critical)` : ''}`} to="/maintenance?status=OPEN" tone={d.alerts.criticalMaintenance ? 'red' : 'amber'} icon="wrench" />
          <AlertTile n={d.alerts.vacantRooms} text="Vacant rooms" to="/rooms?status=VACANT" tone="blue" icon="door" />
          {can('payment.verify') && <AlertTile n={d.alerts.unverifiedPayments} text="Payments awaiting verification" to="/payments?verified=false" tone="amber" icon="check" />}
          {can('approval.decide', 'expense.approve') && <AlertTile n={d.alerts.pendingApprovals + d.alerts.pendingExpenses} text="Approvals and expenses awaiting decision" to="/approvals" tone="purple" icon="check" />}
        </div>
      </section>

      {can('room.view') && <RoomMap />}

      <section className="grid c2" aria-label="Recent activity">
        {can('payment.view') && (
          <Card title="Latest payments" pad={false} actions={<Link to="/payments" className="btn sm">All payments</Link>}>
            <Table rows={d.recent.payments} onRow={(p: any) => navigate(`/payments/${p.id}`)} columns={[
              { header: 'When', cell: (p: any) => dateTime(p.paidAt) }, { header: 'Tenant', cell: (p: any) => `${p.tenant.fullName} · ${p.room.number}` },
              { header: 'Amount', num: true, cell: (p: any) => money(p.amount) },
            ]} />
          </Card>
        )}
        {can('contract.view') && (
          <Card title="New contracts" pad={false}>
            <Table rows={d.recent.contracts} onRow={(c: any) => navigate(`/contracts/${c.id}`)} columns={[
              { header: 'Contract', cell: (c: any) => c.contractNumber }, { header: 'Tenant', cell: (c: any) => `${c.tenant.fullName} · ${c.room.number}` }, { header: 'Status', cell: (c: any) => <Badge status={c.status} /> },
            ]} />
          </Card>
        )}
        {can('tenant.view') && (
          <Card title="New tenants" pad={false}>
            <Table rows={d.recent.tenants} onRow={(t: any) => navigate(`/tenants/${t.id}`)} columns={[
              { header: 'Tenant', cell: (t: any) => t.fullName }, { header: 'Registered', cell: (t: any) => dateTime(t.createdAt) }, { header: 'Status', cell: (t: any) => <Badge status={t.status} /> },
            ]} />
          </Card>
        )}
        {can('expense.view') && (
          <Card title="Latest expenses" pad={false}>
            <Table rows={d.recent.expenses} onRow={() => navigate('/expenses')} columns={[
              { header: 'Expense', cell: (e: any) => <>{e.description}<div className="muted small">{e.category.name} · {date(e.expenseDate)}</div></> },
              { header: 'Amount', num: true, cell: (e: any) => money(e.amount) }, { header: 'Status', cell: (e: any) => <Badge status={e.status} /> },
            ]} />
          </Card>
        )}
        {can('maintenance.view') && (
          <Card title="Maintenance updates" pad={false}>
            <Table rows={d.recent.maintenance} onRow={() => navigate('/maintenance')} columns={[
              { header: 'Issue', cell: (m: any) => <>{m.title}<div className="muted small">{m.building.name}{m.room ? ` · room ${m.room.number}` : ''}</div></> },
              { header: 'Priority', cell: (m: any) => <Badge status={m.priority} /> }, { header: 'Status', cell: (m: any) => <Badge status={m.status} /> },
            ]} />
          </Card>
        )}
      </section>
      <p className="muted small">Signed in to {me?.organization.name}. Every figure on this page is calculated from the records in the database at the moment the page loads.</p>
    </div>
  );
}

/** One screen answering "what needs doing today?" */
export function DailyOperations() {
  const { buildingId, can } = useAuth();
  const q = useApi('/dashboard/daily', { buildingId });
  const navigate = useNavigate();
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const seesMoney = can('payment.view');
  return (
    <div className="stack">
      <PageHead title="Daily Operations" sub={`Today, ${date(d.today)}`}><QuickActions /></PageHead>
      <div className="grid c4">
        {seesMoney && <Stat icon={<I name="wallet" />} tone="teal" k="Collected today" v={money(d.collectedToday)} s={d.byMethod.map((m: any) => `${m.method} ${money(m.amount)}`).join(' · ') || 'No payments yet today'} />}
        <Stat k={`Not fully paid — ${d.month}`} v={d.unpaidThisMonth.length} s={seesMoney ? money(d.unpaidThisMonthTotal) : undefined} />
        <Stat k="Overdue charges" v={d.overdue.length} s={seesMoney ? money(d.overdueTotal) : undefined} />
        <Stat k="Awaiting verification" v={d.pendingVerification.length} />
      </div>
      <div className="grid c2">
        {seesMoney && (
          <Card title="Who paid today" pad={false} actions={can('report.financial') ? <Link className="btn sm" to="/reports?type=daily-collection">Daily collection report</Link> : undefined}>
            <Table rows={d.paidToday} onRow={(p: any) => navigate(`/payments/${p.id}`)} empty={<Empty title="No payments recorded today" />} columns={[
              { header: 'Tenant', cell: (p: any) => <>{p.tenant.fullName}<div className="muted small">Room {p.room.number} · {p.building.name}</div></> },
              { header: 'Method', cell: (p: any) => p.method.name, hideSm: true }, { header: 'Amount', num: true, cell: (p: any) => money(p.amount) },
            ]} />
          </Card>
        )}
        <Card title={`Who has not paid — ${d.month}`} pad={false} actions={can('message.create') ? <Link className="btn sm" to="/reminders">Send reminders</Link> : undefined}>
          <Table rows={d.unpaidThisMonth} onRow={(c: any) => navigate(can('payment.create') ? `/payments/new?contractId=${c.contract.id}` : `/tenants/${c.tenant.id}`)} empty={<Empty title="Everyone has paid this month" />} columns={[
            { header: 'Tenant', cell: (c: any) => <>{c.tenant.fullName}<div className="muted small">Room {c.room.number} · {c.building.name} · {phone(c.tenant.phone)}</div></> },
            { header: 'Balance', num: true, cell: (c: any) => money(c.balance) }, { header: 'Status', cell: (c: any) => <Badge status={c.isOverdue ? 'OVERDUE' : c.status} /> },
          ]} />
        </Card>
        <Card title="Overdue tenants" pad={false}>
          <Table rows={d.overdue} onRow={(c: any) => navigate(`/tenants/${c.tenant.id}`)} empty={<Empty title="No overdue rent" />} columns={[
            { header: 'Tenant', cell: (c: any) => <>{c.tenant.fullName}<div className="muted small">Room {c.room.number} · {phone(c.tenant.phone)}</div></> },
            { header: 'Days', num: true, cell: (c: any) => c.daysOverdue }, { header: 'Balance', num: true, cell: (c: any) => money(c.balance) },
          ]} />
        </Card>
        {seesMoney && (
          <Card title="Payments pending verification" pad={false}>
            <Table rows={d.pendingVerification} onRow={(p: any) => navigate(`/payments/${p.id}`)} empty={<Empty title="All payments are verified" />} columns={[
              { header: 'Receipt', cell: (p: any) => <>{p.receipt?.receiptNumber}<div className="muted small">{p.tenant.fullName} · {p.method.name}</div></> },
              { header: 'Recorded by', cell: (p: any) => p.recordedBy.fullName, hideSm: true }, { header: 'Amount', num: true, cell: (p: any) => money(p.amount) },
            ]} />
          </Card>
        )}
        <Card title="Contracts expiring" pad={false}>
          <Table rows={d.contractsExpiring} onRow={(c: any) => navigate(`/contracts/${c.id}`)} empty={<Empty title="No contracts expiring soon" />} columns={[
            { header: 'Tenant', cell: (c: any) => <>{c.tenant.fullName}<div className="muted small">{c.contractNumber} · room {c.room.number}</div></> },
            { header: 'Ends', cell: (c: any) => date(c.endDate) }, { header: '', cell: (c: any) => <Badge status={c.status} text={c.daysLeft < 0 ? `Expired ${-c.daysLeft} d ago` : `${c.daysLeft} days left`} /> },
          ]} />
        </Card>
        <Card title="Vacant rooms" pad={false}>
          <Table rows={d.vacantRooms} onRow={(r: any) => navigate(`/rooms/${r.id}`)} empty={<Empty title="No vacant rooms" />} columns={[
            { header: 'Room', cell: (r: any) => <>{r.number}<div className="muted small">{r.building.name} · {r.floor.name}</div></> }, { header: 'Monthly rent', num: true, cell: (r: any) => money(r.monthlyRent) },
          ]} />
        </Card>
        <Card title="Open maintenance issues" pad={false}>
          <Table rows={d.openMaintenance} onRow={() => navigate('/maintenance?status=OPEN')} empty={<Empty title="No open maintenance issues" />} columns={[
            { header: 'Issue', cell: (m: any) => <>{m.title}<div className="muted small">{m.building.name}{m.room ? ` · room ${m.room.number}` : ''} · since {date(m.reportedOn)}</div></> },
            { header: 'Priority', cell: (m: any) => <Badge status={m.priority} /> }, { header: 'Status', cell: (m: any) => <Badge status={m.status} /> },
          ]} />
        </Card>
        {can('invoice.view') && (
          <Card title="Missing invoice / EBM references" pad={false}>
            <Table rows={d.missingEbm} onRow={() => navigate('/invoices?missingEbm=true')} empty={<Empty title="Every payment has an EBM reference" />} columns={[
              { header: 'Invoice', cell: (i: any) => <>{i.invoiceNumber}<div className="muted small">{i.tenant.fullName} · {i.payment.receipt?.receiptNumber}</div></> },
              { header: 'Date', cell: (i: any) => date(i.issueDate), hideSm: true }, { header: 'Amount', num: true, cell: (i: any) => money(i.amount) },
            ]} />
          </Card>
        )}
      </div>
    </div>
  );
}
