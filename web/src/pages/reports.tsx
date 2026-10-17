import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import '../report.css';
import { I, type IconName } from '../icons';
import { api, type Query } from '../api';
import { useAuth, useMeta } from '../auth';
import { amount, date, dateTime, label, monthRange, percent } from '../format';
import { useApi } from '../shared';
import { Alert, Badge, Button, Card, Empty, enumOpts, ErrorBox, Loading, opts, PageHead, Select, TextInput } from '../ui';

type ColType = 'text' | 'money' | 'number' | 'date' | 'datetime' | 'percent' | 'status';

function cell(value: unknown, type: ColType, totals = false) {
  if (totals && typeof value === 'string' && !/^-?\d/.test(value)) return value;
  if (value === null || value === undefined || value === '') return type === 'text' || type === 'status' || type === 'date' ? '' : '—';
  switch (type) {
    case 'money': return amount(value);
    case 'number': return Number(value).toLocaleString('en-US');
    case 'percent': return percent(value);
    case 'date': return date(value);
    case 'datetime': return dateTime(value);
    case 'status': return <Badge status={String(value)} />;
    default: return String(value);
  }
}
const isNum = (t: ColType) => t === 'money' || t === 'number' || t === 'percent';

type Tone = 'navy' | 'green' | 'amber' | 'red';
const TONE_COLOR: Record<Tone, string> = { navy: '#14304f', green: '#11845b', amber: '#b26b00', red: '#c0392b' };
/** Colour of a summary figure, from what it measures — the same rule as the PDF export. */
function toneOf(text: string): Tone {
  if (/partial|only part/i.test(text)) return 'amber';
  if (/outstanding|owed|owing|unpaid|arrears|overdue|did not pay|still to|vacant|reversed|failed/i.test(text)) return 'red';
  if (/expense|maintenance|waived/i.test(text)) return 'amber';
  if (/collected|received|paid|net income|collection rate|occupancy|occupied/i.test(text)) return 'green';
  return 'navy';
}
function statusTone(v: string): Tone | null {
  if (/^(PAID|VERIFIED|ISSUED|ACTIVE|COMPLETED|OCCUPIED|APPROVED|POSTED)$/.test(v)) return 'green';
  if (/^(PARTIAL|PENDING|EXPIRING|RESERVED|IN_PROGRESS|SUBMITTED|GENERATED|MAINTENANCE)$/.test(v)) return 'amber';
  if (/^(UNPAID|OVERDUE|EXPIRED|TERMINATED|REVERSED|REVERSAL|FAILED|CANCELLED|VACANT|REJECTED)$/.test(v)) return 'red';
  return null;
}
const initials = (name: string) => name.replace(/\b(LTD|LIMITED|LLC|SARL|CO)\b\.?/gi, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'R';

function sheetCell(value: unknown, type: ColType, totals = false) {
  if (type === 'status' && !totals && value) {
    const tone = statusTone(String(value));
    return <span className={`rpt-pill ${tone ?? ''}`}>{label(String(value))}</span>;
  }
  return cell(value, type === 'status' ? 'text' : type, totals);
}

/**
 * Renders the neutral report structure — the same structure the PDF and Excel exports are produced from —
 * as a printed sheet under the letterhead of the company that owns the building.
 */
export function ReportView({ report }: { report: any }) {
  const issuer = report.issuer ?? { name: report.organization };
  const contact = [issuer.tin && `TIN ${issuer.tin}`, issuer.phone && `Tel ${issuer.phone}`, issuer.email].filter(Boolean);
  return (
    <article className="rpt" aria-label={`${report.title} — ${report.period}`}>
      <header className="rpt-head">
        <div className="rpt-brand">
          {issuer.logo ? <img className="rpt-logo" src={issuer.logo} alt={`${issuer.name} logo`} /> : <div className="rpt-mono" aria-hidden="true">{initials(issuer.name)}</div>}
          <div style={{ minWidth: 0 }}>
            <div className="rpt-company">{issuer.name}</div>
            {contact.length > 0 && <div className="rpt-contact">{contact.map((c: string) => <span key={c}>{c}</span>)}</div>}
            {issuer.address && <div className="rpt-contact">{issuer.address}</div>}
          </div>
        </div>
        <div className="rpt-title">
          <h2>{report.title}</h2>
          <span className="rpt-period">{report.period}</span>
          {issuer.building && <div className="rpt-building">Building: <strong>{issuer.building}</strong></div>}
        </div>
      </header>
      <div className="rpt-rule" /><div className="rpt-rule2" />
      <dl className="rpt-meta">
        <div><dt>Property</dt><dd>{report.scope || 'All buildings'}</dd></div>
        <div><dt>Reporting period</dt><dd>{report.period}</dd></div>
        <div><dt>Generated</dt><dd>{dateTime(report.generatedAt)}</dd></div>
        <div><dt>Prepared by</dt><dd>{report.preparedBy} · {report.currency}</dd></div>
      </dl>
      {report.isDemoData && <p className="rpt-demo">DEMO DATA — generated from sample records, not real business data.</p>}
      {report.warnings.map((w: string) => <div key={w} className="rpt-warn" role="alert">⚠ {w}</div>)}
      {report.summary.length > 0 && (
        <section className="rpt-kpis" aria-label="Summary">
          {report.summary.map((s: any) => (
            <div key={s.label} className="rpt-kpi" style={{ ['--tone' as string]: TONE_COLOR[toneOf(s.label)] }}>
              <div className="rpt-kpi-label">{s.label}</div>
              <div className="rpt-kpi-value">{cell(s.value, s.type)}{s.type === 'money' && s.value != null && <small>{report.currency}</small>}</div>
            </div>
          ))}
        </section>
      )}
      {report.tables.map((t: any) => (
        <section key={t.title} className="rpt-section" aria-label={t.title}>
          <h3>{t.title} <small>{t.rows.length} row{t.rows.length === 1 ? '' : 's'}</small></h3>
          {t.rows.length === 0 ? <div className="rpt-empty">No records for the selected filters.</div> : (
            <div className="rpt-tablewrap">
              <table className={`rpt-table ${t.columns.length > 9 ? 'dense' : ''}`}>
                <thead><tr>{t.columns.map((c: any) => <th key={c.key} scope="col" className={isNum(c.type) ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {t.rows.map((r: any, i: number) => <tr key={i}>{t.columns.map((c: any) => <td key={c.key} className={isNum(c.type) ? 'num' : ''}>{sheetCell(r[c.key], c.type)}</td>)}</tr>)}
                </tbody>
                {t.totals && <tfoot><tr>{t.columns.map((c: any) => <td key={c.key} className={isNum(c.type) && !(typeof t.totals[c.key] === 'string' && !/^-?\d/.test(t.totals[c.key])) ? 'num' : ''}>{t.totals[c.key] === undefined ? '' : sheetCell(t.totals[c.key], c.type, true)}</td>)}</tr></tfoot>}
              </table>
            </div>
          )}
        </section>
      ))}
      {report.notes.length > 0 && <div className="rpt-notes"><b>NOTES</b>{report.notes.map((n: string) => <p key={n}>• {n}</p>)}</div>}
      {report.signatures && (
        <div className="rpt-sign">
          {['Prepared by', 'Checked by', 'Approved by'].map((who, i) => <div key={who}>{who}{i === 0 ? `: ${report.preparedBy}` : ''}<span>Name, signature and date</span></div>)}
        </div>
      )}
      <footer className="rpt-foot"><span>{issuer.name} — {report.title} — {report.period}</span><span>Amounts in {report.currency}</span></footer>
    </article>
  );
}

/** Which filters each report actually uses, so the screen only offers ones that have an effect. */
const USES: Record<string, string[]> = {
  building: ['period', 'building!', 'floor', 'room', 'groupBy'], consolidated: ['period'], 'monthly-rent': ['period', 'building'], 'building-monthly': ['month', 'building'], 'daily-collection': ['day', 'building', 'floor', 'tenant', 'method'],
  arrears: ['building', 'floor', 'tenant', 'paymentStatus', 'contractStatus', 'sort'], occupancy: ['building', 'floor'], payments: ['period', 'building', 'floor', 'room', 'tenant', 'method'],
  'rent-ledger': ['period', 'building', 'floor', 'room', 'tenant', 'paymentStatus', 'contractStatus'], expenses: ['period', 'building', 'floor', 'room'], maintenance: ['period', 'building', 'floor', 'room'],
  'late-payers': ['period', 'building'], tenants: ['building'], rooms: ['building', 'floor'], contracts: ['building', 'floor', 'tenant', 'contractStatus'],
};
/** The report list, grouped by what the reports are for. */
const GROUPS = [
  { title: 'Money', types: ['building-monthly', 'monthly-rent', 'daily-collection', 'payments', 'arrears', 'late-payers', 'rent-ledger', 'expenses'] },
  { title: 'Buildings', types: ['building', 'consolidated', 'occupancy', 'maintenance'] },
  { title: 'Lists', types: ['tenants', 'rooms', 'contracts'] },
];
const ICON: Record<string, IconName> = {
  'building-monthly': 'calendar', 'monthly-rent': 'trend', 'daily-collection': 'coin', payments: 'wallet', arrears: 'alert', 'late-payers': 'clock', 'rent-ledger': 'list',
  expenses: 'receipt', building: 'building', consolidated: 'chart', occupancy: 'door', maintenance: 'wrench', tenants: 'users', rooms: 'layers', contracts: 'file',
};
const SHORT: Record<string, string> = {
  'building-monthly': 'Who paid and who did not, per building', 'monthly-rent': 'Expected vs collected, month by month', 'daily-collection': 'Every payment of one day',
  payments: 'All payments with receipts and EBM', arrears: 'Tenants who owe rent', 'late-payers': 'Tenants who often pay late', 'rent-ledger': 'Every monthly rent charge',
  expenses: 'Spending by building and category', building: 'One building in detail', consolidated: 'All buildings side by side', occupancy: 'Occupied and vacant rooms',
  maintenance: 'Repairs and their cost', tenants: 'Tenants with rooms and balances', rooms: 'Rooms with rent and tenant', contracts: 'Contracts and end dates',
};
const DESCRIPTIONS: Record<string, string> = {
  building: 'One building: occupancy, expected, collected, outstanding, expenses and net — by floor and by room.',
  consolidated: 'All buildings side by side with totals, occupancy, arrears, payment methods, expenses, maintenance and EBM status.',
  'building-monthly': 'One month for each building: every room and tenant with rent, amount paid, balance, payment dates, receipts and “paid until”, plus the building’s totals and expenses.',
  'monthly-rent': 'Expected vs collected per month, with paid / partial / unpaid tenant counts, compared across buildings.',
  'daily-collection': 'Every payment of the day with totals for cash, bank, mobile money and other methods.',
  arrears: 'Tenants who owe rent, by month, with days overdue and phone numbers.', occupancy: 'Occupied, vacant, reserved and maintenance rooms by building, floor and room.',
  payments: 'Detailed payment listing with allocation, verification and EBM status.', 'rent-ledger': 'Every rent charge with amounts due, paid and outstanding.',
  expenses: 'Approved expenses by building and category with the full list of entries.', maintenance: 'Maintenance requests with status and cost.',
  'late-payers': 'Tenants who paid late (or still owe) for two or more months in the period.', tenants: 'Tenant list with room, rent and balance.', rooms: 'Room list with status, rent and tenant.', contracts: 'Contract list with end dates and renewal rate.',
};

export function Reports() {
  const { me, can, buildingId: globalBuilding } = useAuth();
  const meta = useMeta();
  const [params, setParams] = useSearchParams();
  const catalog = useApi('/reports');
  const today = me!.organization.today;
  const type = params.get('type') ?? '';
  const uses = USES[type] ?? [];
  const month = monthRange(today);
  const [f, setF] = useState<Record<string, string>>({ from: month.from, to: month.to, buildingId: globalBuilding });
  const [applied, setApplied] = useState<Query | null>(null);
  useEffect(() => { setF((x) => ({ ...x, buildingId: globalBuilding, floorId: '', roomId: '' })); setApplied(null); }, [globalBuilding]);
  useEffect(() => {
    setApplied(null);
    setF((x) => (type === 'daily-collection' ? { ...x, from: today, to: today } : x.from === x.to ? { ...x, ...month } : x));
  }, [type]);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v, ...(k === 'buildingId' ? { floorId: '', roomId: '' } : {}), ...(k === 'floorId' ? { roomId: '' } : {}) }));
  const floors = useApi('/floors', { buildingId: f.buildingId }, uses.includes('floor') && Boolean(f.buildingId));
  const rooms = useApi('/rooms', { floorId: f.floorId, pageSize: 200 }, uses.includes('room') && Boolean(f.floorId));
  const report = useApi(`/reports/${type}`, applied ?? undefined, Boolean(type && applied));
  // Bring the finished report into view (on phones it is below the filters).
  useEffect(() => {
    if (report.data && applied) document.querySelector('.rpt')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [report.data]);

  const query = (): Query => {
    const q: Query = {};
    if (uses.includes('period')) { q.from = f.from; q.to = f.to; }
    if (uses.includes('day')) { q.from = f.from; q.to = f.from; }
    if (uses.includes('month')) Object.assign(q, monthRange(`${(f.from ?? today).slice(0, 7)}-01`));
    for (const [key, name] of [['building', 'buildingId'], ['building!', 'buildingId'], ['floor', 'floorId'], ['room', 'roomId'], ['method', 'methodId'], ['paymentStatus', 'paymentStatus'], ['contractStatus', 'contractStatus'], ['groupBy', 'groupBy'], ['sort', 'sort']] as const) {
      if (uses.includes(key) && f[name]) q[name] = f[name];
    }
    return q;
  };
  const needsBuilding = uses.includes('building!') && !f.buildingId;
  const items: any[] = catalog.data?.items ?? [];
  const lastMonth = () => { const d = new Date(`${month.from}T00:00:00Z`); d.setUTCDate(0); return monthRange(d.toISOString().slice(0, 10)); };

  return (
    <div className="stack">
      <PageHead title="Reports" sub="Every figure is calculated from the database when the report is generated. Each generation is recorded in the audit log." />
      <ErrorBox error={catalog.error} />
      <div className="grid report-grid no-print" style={{ gridTemplateColumns: 'minmax(220px, 300px) 1fr', alignItems: 'start' }}>
        <Card title="Reports" pad={false}>
          <div role="listbox" aria-label="Choose a report" className="rpt-picker">
            {GROUPS.map((g) => {
              const inGroup = items.filter((r) => g.types.includes(r.type));
              return inGroup.length ? (
                <div key={g.title}>
                  <div className="rpt-picker-group">{g.title}</div>
                  {inGroup.map((r) => (
                    <button key={r.type} type="button" role="option" aria-selected={type === r.type} onClick={() => setParams({ type: r.type })} className="rpt-picker-item">
                      <span className="rpt-picker-icon"><I name={ICON[r.type] ?? 'file'} size={16} /></span>
                      <span><b>{r.title}</b><small>{SHORT[r.type]}</small></span>
                    </button>
                  ))}
                </div>
              ) : null;
            })}
            {catalog.data && items.length === 0 && <Empty title="No reports available to your role" />}
          </div>
        </Card>
        <Card title={type ? items.find((r) => r.type === type)?.title ?? 'Report' : 'Choose a report'}>
          {!type ? <p className="muted">Select a report on the left, set its filters, then generate it.</p> : (
            <div className="stack">
              <p className="muted">{DESCRIPTIONS[type]}</p>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                {uses.includes('period') && <>
                  <TextInput label="From" type="date" value={f.from ?? ''} onChange={(v) => set('from', v)} /><TextInput label="To" type="date" value={f.to ?? ''} onChange={(v) => set('to', v)} />
                  <Button size="sm" onClick={() => setF({ ...f, ...month })}>This month</Button><Button size="sm" onClick={() => setF({ ...f, ...lastMonth() })}>Last month</Button>
                  <Button size="sm" onClick={() => setF({ ...f, from: `${today.slice(0, 4)}-01-01`, to: today })}>This year</Button>
                </>}
                {uses.includes('month') && <>
                  <TextInput label="Month" type="month" value={(f.from ?? today).slice(0, 7)} onChange={(v) => v && setF({ ...f, ...monthRange(`${v}-01`) })} />
                  <Button size="sm" onClick={() => setF({ ...f, ...month })}>This month</Button><Button size="sm" onClick={() => setF({ ...f, ...lastMonth() })}>Last month</Button>
                </>}
                {uses.includes('day') && <TextInput label="Date" type="date" value={f.from ?? ''} onChange={(v) => set('from', v)} />}
              </div>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                {(uses.includes('building') || uses.includes('building!')) && <Select label={uses.includes('building!') ? 'Building *' : 'Building'} value={f.buildingId ?? ''} onChange={(v) => set('buildingId', v)} all={uses.includes('building!') ? 'Select building…' : 'ALL BUILDINGS'} options={opts(meta.data?.buildings)} />}
                {uses.includes('floor') && <Select label="Floor" value={f.floorId ?? ''} onChange={(v) => set('floorId', v)} all={f.buildingId ? 'All floors' : 'Select a building first'} options={(floors.data?.items ?? []).map((x: any) => ({ value: x.id, label: x.name }))} />}
                {uses.includes('room') && <Select label="Room" value={f.roomId ?? ''} onChange={(v) => set('roomId', v)} all={f.floorId ? 'All rooms' : 'Select a floor first'} options={(rooms.data?.items ?? []).map((x: any) => ({ value: x.id, label: x.number }))} />}
                {uses.includes('method') && <Select label="Payment method" value={f.methodId ?? ''} onChange={(v) => set('methodId', v)} all="All methods" options={opts(meta.data?.paymentMethods)} />}
                {uses.includes('paymentStatus') && <Select label="Payment status" value={f.paymentStatus ?? ''} onChange={(v) => set('paymentStatus', v)} all="All" options={enumOpts(type === 'arrears' ? ['UNPAID', 'PARTIAL', 'OVERDUE'] : ['UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED'])} />}
                {uses.includes('contractStatus') && <Select label="Contract status" value={f.contractStatus ?? ''} onChange={(v) => set('contractStatus', v)} all="All" options={enumOpts(['ACTIVE', 'EXPIRING', 'EXPIRED', 'TERMINATED', 'RENEWED'])} />}
                {uses.includes('groupBy') && <Select label="Break down by" value={f.groupBy ?? ''} onChange={(v) => set('groupBy', v)} options={[{ value: '', label: 'Floor and room' }, { value: 'room', label: 'Room only' }]} />}
                {uses.includes('sort') && <Select label="Sort by" value={f.sort ?? ''} onChange={(v) => set('sort', v)} options={[{ value: '', label: 'Highest balance' }, { value: 'oldest', label: 'Oldest debt' }, { value: 'days', label: 'Days overdue' }, { value: 'building', label: 'Building' }, { value: 'floor', label: 'Floor' }]} />}
              </div>
              {uses.includes('tenant') && <p className="muted small">To report on one tenant, open the tenant’s profile — its Payments and Rent Ledger tabs show the same records.</p>}
              {needsBuilding && <Alert tone="blue">Select a building for this report. For all buildings together, use the Consolidated Report.</Alert>}
              <div className="row">
                <Button variant="primary" disabled={needsBuilding} onClick={() => setApplied({ ...query(), _t: Date.now() })}>Generate report</Button>
                {applied && report.data && <>
                  <Button onClick={() => window.print()}>Print</Button>
                  {catalog.data?.canExport ? <>
                    <a className="btn" href={api.url(`/reports/${type}/export`, { ...query(), format: 'pdf' })}>Export PDF</a>
                    <a className="btn" href={api.url(`/reports/${type}/export`, { ...query(), format: 'xlsx' })}>Export Excel</a>
                  </> : <span className="muted small">Your role cannot export reports.</span>}
                </>}
              </div>
            </div>
          )}
        </Card>
      </div>
      {type && applied && (report.error ? <ErrorBox error={report.error} /> : report.isFetching && !report.data ? <Loading what="Generating report" /> : report.data ? <ReportView report={report.data} /> : null)}
      {!can('report.financial') && <p className="muted small no-print">Financial reports are not available to your role.</p>}
      {type && !applied && <p className="muted no-print">Set the filters and press “Generate report”. {label(type)} has not been generated yet.</p>}
    </div>
  );
}
