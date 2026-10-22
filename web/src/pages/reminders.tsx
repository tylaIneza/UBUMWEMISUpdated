import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { date, dateTime, money, phone, smsLink } from '../format';
import { useAction, useApi } from '../shared';
import { Alert, Badge, Button, Card, Confirm, Empty, ErrorBox, Loading, PageHead, Select, useToast } from '../ui';

/** Payment reminders for every tenant whose rent has fallen due and is not fully paid. */
export function Reminders() {
  const { buildingId } = useAuth();
  const toast = useToast();
  const [overdueOnly, setOverdueOnly] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<any>(null);
  const q = useApi('/messages/reminders', { buildingId, overdueOnly: overdueOnly || undefined });
  const log = useAction((v: { tenantId: string; contractId: string }) => api.post('/messages', { ...v, template: 'PAYMENT_REMINDER', channel: 'COPY' }));
  const send = useAction((contractIds: string[]) => api.post('/messages/reminders/send', { contractIds }));
  const items: any[] = q.data?.items ?? [];
  const configured = Boolean(q.data?.smsConfigured);
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.contractId));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const total = items.reduce((a, i) => a + i.balance, 0);

  return (
    <div className="stack">
      <PageHead title="Payment reminders" sub="Tenants whose rent has fallen due and is not fully paid. Each reminder is written from the tenant’s real balance.">
        {configured && <Button variant="primary" disabled={!selected.size} onClick={() => setConfirm(true)}>Send SMS to {selected.size || 'selected'} tenant{selected.size === 1 ? '' : 's'}</Button>}
      </PageHead>
      {!configured && q.data && (
        <Alert tone="blue">
          <strong>No SMS provider is connected yet, so the system cannot send SMS by itself.</strong> “Open in SMS app” opens your phone’s messaging app with the number and message already filled in — you press send. On a computer this works only if it is linked to your phone; otherwise use “Copy”.
        </Alert>
      )}
      {result && <Alert tone={result.failed ? 'amber' : 'green'}>{result.sent} SMS sent{result.failed ? `, ${result.failed} could not be sent (see each tenant’s Communication tab)` : ''}.</Alert>}
      <ErrorBox error={q.error ?? send.error} />
      <Card pad={false} title={q.data ? `${items.length} tenant${items.length === 1 ? '' : 's'} owing · ${money(total)}` : 'Tenants owing'} actions={
        <Select label="Show" value={overdueOnly} onChange={(v) => { setOverdueOnly(v); setSelected(new Set()); }} options={[{ value: '', label: 'All rent that has fallen due' }, { value: 'true', label: 'Overdue only (grace period passed)' }]} />
      }>
        {!q.data ? <Loading /> : items.length === 0 ? <Empty title="Nobody owes rent right now">Everyone has paid what has fallen due.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {configured && <th scope="col"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.contractId)))} /></th>}
                  <th scope="col">Tenant</th><th scope="col">Phone</th><th scope="col" className="hide-sm">Room</th><th scope="col" className="num">Owes</th><th scope="col">Status</th><th scope="col" className="hide-sm">Last reminder</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <Fragment key={i.contractId}>
                    <tr>
                      {configured && <td><input type="checkbox" aria-label={`Select ${i.fullName}`} checked={selected.has(i.contractId)} onChange={() => toggle(i.contractId)} /></td>}
                      <td><Link to={`/tenants/${i.tenantId}`} className="strong">{i.fullName}</Link><div className="muted small">{i.months} month{i.months === 1 ? '' : 's'} · since {date(i.oldestDue)}</div></td>
                      <td className="nowrap">{phone(i.phone)}</td>
                      <td className="hide-sm">{i.room} · {i.building}</td>
                      <td className="num strong">{money(i.balance)}</td>
                      <td><Badge status={i.overdue ? 'OVERDUE' : 'UNPAID'} text={i.overdue ? 'Overdue' : 'Due'} /></td>
                      <td className="hide-sm small">{i.lastRemindedAt ? dateTime(i.lastRemindedAt) : <span className="muted">Never</span>}</td>
                      <td>
                        <div className="row end" style={{ flexWrap: 'nowrap' }}>
                          <Button size="sm" variant="ghost" onClick={() => setOpen(open === i.contractId ? null : i.contractId)} aria-expanded={open === i.contractId}>{open === i.contractId ? 'Hide' : 'Message'}</Button>
                          {i.phone && <a className="btn sm" href={smsLink(i.phone, i.message)} onClick={() => log.mutate({ tenantId: i.tenantId, contractId: i.contractId })}>Open in SMS app</a>}
                          <Button size="sm" onClick={async () => { await navigator.clipboard.writeText(i.message); log.mutate({ tenantId: i.tenantId, contractId: i.contractId }); toast('Message copied.'); }}>Copy</Button>
                        </div>
                      </td>
                    </tr>
                    {open === i.contractId && <tr><td colSpan={configured ? 8 : 7} style={{ background: 'var(--surface-2)' }}><span className="small">{i.message}</span> <span className="muted small">({i.message.length} characters)</span></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="muted small">“Last reminder” shows when a reminder was last sent by SMS, e-mailed, opened in the SMS app or copied for this tenant.</p>
      {confirm && (
        <Confirm title={`Send SMS reminders to ${selected.size} tenant${selected.size === 1 ? '' : 's'}?`} confirmLabel="Send SMS now" onClose={() => setConfirm(false)}
          onConfirm={async () => { setResult(await send.mutateAsync([...selected])); setSelected(new Set()); }}>
          Each tenant receives their own reminder at the phone number on file. SMS charges from your provider apply.
        </Confirm>
      )}
    </div>
  );
}
