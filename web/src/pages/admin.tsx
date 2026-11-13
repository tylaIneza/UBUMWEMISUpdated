import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { date, dateTime, label, month } from '../format';
import { ImportPanel, useAction, useApi } from '../shared';
import { Alert, AutoForm, Badge, Button, Card, Confirm, DL, Empty, enumOpts, ErrorBox, Loading, Modal, PageHead, Pager, Select, Table, Tabs, TextInput, useDebounced, useToast } from '../ui';

// ───────────── Users & roles ─────────────

function LinkBox({ title, info, onClose }: { title: string; info: { link: string; emailed: boolean }; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title={title} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack">
        {info.emailed ? <Alert tone="green">The link was e-mailed to the user.</Alert> : <Alert tone="amber">E-mail delivery is not configured on this server, so nothing was sent. Give this link to the user yourself (it is shown only once).</Alert>}
        <textarea className="input" readOnly value={info.link} aria-label="Link" onFocus={(e) => e.target.select()} />
        <div className="row"><Button onClick={async () => { await navigator.clipboard.writeText(info.link); toast('Link copied.'); }}>Copy link</Button></div>
      </div>
    </Modal>
  );
}

function RolePermissions({ roles, catalog }: { roles: any[]; catalog: any[] }) {
  const { can } = useAuth();
  const [roleId, setRoleId] = useState(roles.find((r) => r.key !== 'SUPER_ADMIN')?.id ?? roles[0]?.id);
  const role = roles.find((r) => r.id === roleId);
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const save = useAction((permissions: string[]) => api.put(`/roles/${roleId}/permissions`, { permissions }), 'Role permissions saved. They apply immediately.');
  if (!role) return null;
  const current = draft ?? new Set<string>(role.permissions);
  const locked = role.key === 'SUPER_ADMIN' || !can('role.manage');
  const categories = [...new Set(catalog.map((p) => p.category))];
  return (
    <div className="card-body stack">
      <div className="row between">
        <Select label="Role" value={roleId} onChange={(v) => { setRoleId(v); setDraft(null); }} options={roles.map((r) => ({ value: r.id, label: `${r.name} (${r.userCount} user${r.userCount === 1 ? '' : 's'})` }))} />
        {!locked && <Button variant="primary" disabled={!draft} busy={save.isPending} onClick={async () => { await save.mutateAsync([...current]); setDraft(null); }}>Save permissions</Button>}
      </div>
      <p className="muted">{role.description}{role.key === 'SUPER_ADMIN' && ' This role always has every permission and cannot be changed.'}</p>
      <ErrorBox error={save.error} />
      <div className="grid c3">
        {categories.map((cat) => (
          <fieldset key={cat} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px' }}>
            <legend className="strong small">{cat}</legend>
            {catalog.filter((p) => p.category === cat).map((p) => (
              <label key={p.key} className="check" style={{ padding: '3px 0', alignItems: 'flex-start' }}>
                <input type="checkbox" disabled={locked} checked={current.has(p.key)} onChange={(e) => { const next = new Set(current); if (e.target.checked) next.add(p.key); else next.delete(p.key); setDraft(next); }} />
                <span className="small">{p.description}</span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </div>
  );
}

export function Users() {
  const { me } = useAuth();
  const users = useApi('/users');
  const roles = useApi('/roles');
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [edit, setEdit] = useState<any>(null);
  const [remove, setRemove] = useState<any>(null);
  const [link, setLink] = useState<{ title: string; info: any } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const roleOptions = (roles.data?.roles ?? []).map((r: any) => ({ value: r.key, label: r.name }));
  const create = useAction((v: any) => api.post('/users', { ...v, roles: [v.role] }));
  const update = useAction((v: any) => api.patch(`/users/${edit.id}`, { fullName: v.fullName, phone: v.phone, status: v.status, roles: edit.id === me?.user.id ? undefined : [v.role] }), 'User updated.');
  const del = useAction((id: string) => api.del(`/users/${id}`), 'User removed. Their history is kept.');
  const issue = async (u: any, kind: 'reset-link' | 'verification-link') => {
    setError(null);
    try { setLink({ title: kind === 'reset-link' ? `Password reset link — ${u.fullName}` : `E-mail verification link — ${u.fullName}`, info: await api.post(`/users/${u.id}/${kind}`) }); } catch (e) { setError(e); }
  };
  return (
    <div className="stack">
      <PageHead title="Users" sub="Staff accounts and what each role is allowed to do."><Button variant="primary" onClick={() => setEdit({})}>Add user</Button></PageHead>
      <ErrorBox error={users.error ?? error} />
      <Card pad={false}>
        <Tabs value={tab} onChange={setTab} tabs={[['users', 'Users'], ['roles', 'Roles & permissions']]} />
        {tab === 'users' && (
          <Table rows={users.data?.items} columns={[
            { header: 'User', cell: (u: any) => <><span className="strong">{u.fullName}</span>{u.id === me?.user.id && <span className="muted small"> (you)</span>}<div className="muted small">{u.email}</div></> },
            { header: 'Role', cell: (u: any) => u.roles.map((r: any) => r.name).join(', ') },
            { header: 'Status', cell: (u: any) => <><Badge status={u.status} />{u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge status="FAILED" text="Locked" />}</> },
            { header: 'E-mail', hideSm: true, cell: (u: any) => (u.emailVerifiedAt ? <Badge status="VERIFIED" /> : <Badge status="PENDING" text="Unverified" />) },
            { header: 'Last sign-in', hideSm: true, cell: (u: any) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never') },
            { header: '', cell: (u: any) => (
              <div className="row end">
                <Button size="sm" onClick={() => setEdit(u)}>Edit</Button><Button size="sm" onClick={() => issue(u, 'reset-link')}>Reset password</Button>
                {!u.emailVerifiedAt && <Button size="sm" variant="ghost" onClick={() => issue(u, 'verification-link')}>Verification link</Button>}
                {!u.emailVerifiedAt && <Button size="sm" variant="ghost" title="Confirm this person's e-mail address yourself, without a link" onClick={async () => { try { await api.post(`/users/${u.id}/mark-email-verified`); await users.refetch(); } catch (e) { setError(e); } }}>Mark e-mail verified</Button>}
                {u.id !== me?.user.id && <Button size="sm" variant="ghost" onClick={() => setRemove(u)}>Remove</Button>}
              </div>) },
          ]} />
        )}
        {tab === 'roles' && (roles.data ? <RolePermissions roles={roles.data.roles} catalog={roles.data.permissions} /> : <Loading />)}
      </Card>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.fullName}` : 'Add user'} onClose={() => setEdit(null)}>
          <AutoForm onCancel={() => setEdit(null)} submitLabel={edit.id ? 'Save' : 'Create user'} initial={{ fullName: edit.fullName ?? '', email: edit.email ?? '', phone: edit.phone ?? '', role: edit.roles?.[0]?.key ?? '', status: edit.status ?? 'ACTIVE' }}
            fields={[
              { name: 'fullName', label: 'Full name', required: true }, ...(edit.id ? [] : [{ name: 'email', label: 'E-mail address', type: 'email' as const, required: true }]),
              { name: 'phone', label: 'Phone', type: 'tel', hint: 'The user can sign in with this number or their e-mail. Each user needs their own number.' }, ...(edit.id === me?.user.id ? [] : [{ name: 'role', label: 'Role', type: 'select' as const, options: roleOptions, required: true }]),
              ...(edit.id ? (edit.id === me?.user.id ? [] : [{ name: 'status', label: 'Status', type: 'select' as const, options: enumOpts(['ACTIVE', 'DISABLED']), required: true }])
                : [{ name: 'password', label: 'Initial password', type: 'password' as const, required: true, full: true, hint: 'At least 8 characters with upper- and lower-case letters and a number. The user must change it at first sign-in.' }]),
            ]}
            onSubmit={async (v) => {
              if (edit.id) await update.mutateAsync(v);
              else { const created = await create.mutateAsync(v); setLink({ title: `User created — e-mail verification link for ${v.fullName}`, info: created.verification }); }
              setEdit(null);
            }} />
        </Modal>
      )}
      {remove && <Confirm title={`Remove ${remove.fullName}?`} danger confirmLabel="Remove user" onClose={() => setRemove(null)} onConfirm={() => del.mutateAsync(remove.id)}>The account will no longer be able to sign in. Payments, expenses and audit entries recorded by this user remain attributed to them.</Confirm>}
      {link && <LinkBox title={link.title} info={link.info} onClose={() => setLink(null)} />}
    </div>
  );
}

// ───────────── Settings ─────────────

function Periods() {
  const { can, me } = useAuth();
  const q = useApi('/periods');
  const [closing, setClosing] = useState(false);
  const [reopen, setReopen] = useState<any>(null);
  const close = useAction((v: any) => api.post('/periods/close', { period: `${v.period.slice(0, 7)}-01`, note: v.note }), 'Period closed.');
  const open = useAction((v: { id: string; reason: string }) => api.post(`/periods/${v.id}/reopen`, { reason: v.reason }), 'Period reopened.');
  const today = me!.organization.today;
  const prev = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  prev.setUTCDate(0);
  return (
    <div className="card-body stack">
      <div className="row between">
        <p className="muted grow">Closing a month prevents payments and expenses from being dated in it. Corrections to a closed month are posted in an open month as reversals or adjustments, and are audited.</p>
        {can('period.manage') && <Button variant="primary" onClick={() => setClosing(true)}>Close a month</Button>}
      </div>
      <ErrorBox error={q.error} />
      <Table rows={q.data?.items} empty={<Empty title="No periods have been closed">All months are open.</Empty>} columns={[
        { header: 'Period', cell: (p: any) => <span className="strong">{month(p.period)}</span> }, { header: 'Status', cell: (p: any) => <Badge status={p.status} /> },
        { header: 'Closed', cell: (p: any) => (p.closedAt ? `${dateTime(p.closedAt)} by ${p.closedBy?.fullName ?? '—'}` : '—') }, { header: 'Note', cell: (p: any) => p.note ?? '' },
        { header: '', cell: (p: any) => (can('period.manage') && p.status === 'CLOSED' ? <Button size="sm" onClick={() => setReopen(p)}>Reopen</Button> : null) },
      ]} />
      {closing && (
        <Modal title="Close an accounting period" onClose={() => setClosing(false)}>
          <AutoForm submitLabel="Close period" onCancel={() => setClosing(false)} initial={{ period: prev.toISOString().slice(0, 10) }} fields={[{ name: 'period', label: 'Any date in the month to close', type: 'date', required: true, max: prev.toISOString().slice(0, 10) }, { name: 'note', label: 'Note' }]}
            onSubmit={async (v) => { await close.mutateAsync(v); setClosing(false); }} />
        </Modal>
      )}
      {reopen && <Confirm title={`Reopen ${month(reopen.period)}?`} confirmLabel="Reopen period" reason="Reason" onClose={() => setReopen(null)} onConfirm={(reason) => open.mutateAsync({ id: reopen.id, reason })}>Entries can again be dated in this month until it is closed again.</Confirm>}
    </div>
  );
}

export function Settings() {
  const { can } = useAuth();
  const allowed = can('settings.manage');
  const q = useApi('/settings', undefined, allowed);
  const [tab, setTab] = useState<'org' | 'billing' | 'categories' | 'methods' | 'periods' | 'import' | 'integrations'>(allowed ? 'org' : can('period.manage') ? 'periods' : 'import');
  const [edit, setEdit] = useState<{ kind: 'categories' | 'payment-methods'; item: any } | null>(null);
  const org = useAction((v: any) => api.patch('/settings/organization', v), 'Settings saved.');
  const saveItem = useAction((v: any) => api.post(`/settings/${edit!.kind}`, v), 'Saved.');
  const toggle = useAction((v: { kind: string; id: string; isActive: boolean }) => api.post(`/settings/${v.kind}`, { id: v.id, isActive: v.isActive }), 'Saved.');
  const s = q.data;
  const tabs: Array<[typeof tab, string]> = [
    ...(allowed ? [['org', 'Organization'], ['billing', 'Rent & numbering'], ['categories', 'Expense categories'], ['methods', 'Payment methods']] as Array<[typeof tab, string]> : []),
    ...(can('period.manage') ? [['periods', 'Accounting periods'] as [typeof tab, string]] : []), ...(can('import.data') ? [['import', 'Import data'] as [typeof tab, string]] : []),
    ...(allowed ? [['integrations', 'Integrations'] as [typeof tab, string]] : []),
  ];
  return (
    <div className="stack">
      <PageHead title="Settings" sub="Organization details, business rules and reference lists." />
      <ErrorBox error={q.error ?? toggle.error} />
      <Card pad={false}>
        <Tabs value={tab} onChange={setTab} tabs={tabs} />
        {allowed && !s && <Loading />}
        {tab === 'org' && s && (
          <div className="card-body">
            <AutoForm key={s.organization.updatedAt} submitLabel="Save organization" initial={Object.fromEntries(['name', 'legalName', 'tin', 'address', 'phone', 'email'].map((k) => [k, s.organization[k] ?? '']))}
              fields={[{ name: 'name', label: 'Organization name', required: true, hint: 'Shown on receipts and reports.' }, { name: 'legalName', label: 'Legal name' }, { name: 'tin', label: 'TIN' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'E-mail', type: 'email' }, { name: 'address', label: 'Address' }]}
              onSubmit={(v) => org.mutateAsync(v)}>
              <DL items={[['Currency', s.organization.currency], ['Time zone', s.organization.timezone]]} />
            </AutoForm>
          </div>
        )}
        {tab === 'billing' && s && (
          <div className="card-body">
            <AutoForm key={s.organization.updatedAt} submitLabel="Save rules" initial={{ ...Object.fromEntries(['defaultDueDay', 'defaultGraceDays', 'expiringSoonDays', 'dueSoonDays', 'receiptPrefix', 'invoicePrefix', 'contractPrefix'].map((k) => [k, s.organization[k]])), proratePartialMonths: s.organization.proratePartialMonths, requirePaymentVerification: s.organization.requirePaymentVerification, notifyInApp: s.organization.notifyInApp }}
              fields={[
                { name: 'defaultDueDay', label: 'Default rent due day', type: 'number', required: true, hint: 'Day of the month; used for new contracts.' }, { name: 'defaultGraceDays', label: 'Default grace period (days)', type: 'number', required: true },
                { name: 'expiringSoonDays', label: 'Flag contracts as expiring (days before end)', type: 'number', required: true }, { name: 'dueSoonDays', label: '“Rent due soon” alert (days before due date)', type: 'number', required: true },
                { name: 'receiptPrefix', label: 'Receipt number prefix', required: true, hint: 'e.g. REC → REC-2026-000001' }, { name: 'invoicePrefix', label: 'Invoice number prefix', required: true }, { name: 'contractPrefix', label: 'Contract number prefix', required: true },
                { name: 'proratePartialMonths', label: 'Bill a partial first or last month by days', type: 'checkbox', full: true, hint: 'off = always bill the full month' },
                { name: 'requirePaymentVerification', label: 'A second person must verify each payment', type: 'checkbox', full: true, hint: 'off = a payment counts as verified as soon as it is recorded; switching it off also marks the payments waiting for verification as verified' },
                { name: 'notifyInApp', label: 'In-app notifications', type: 'checkbox', full: true },
              ]}
              onSubmit={(v) => org.mutateAsync({ ...v, defaultDueDay: Number(v.defaultDueDay), defaultGraceDays: Number(v.defaultGraceDays), expiringSoonDays: Number(v.expiringSoonDays), dueSoonDays: Number(v.dueSoonDays) })}>
              <p className="muted small">These defaults apply to new contracts and future charges. Existing contracts and past charges are not changed. Payments are always applied to the oldest unpaid month first.</p>
            </AutoForm>
          </div>
        )}
        {(tab === 'categories' || tab === 'methods') && s && (() => {
          const kind = tab === 'categories' ? 'categories' : 'payment-methods';
          const rows = tab === 'categories' ? s.categories : s.methods;
          return (
            <div className="stack">
              <div className="card-body row between" style={{ paddingBottom: 0 }}>
                <p className="muted">{tab === 'categories' ? 'Categories available when recording an expense.' : 'Methods available when recording payments. A method that requires a reference will not accept a payment without one.'} Items in use are deactivated, not deleted.</p>
                <Button variant="primary" onClick={() => setEdit({ kind, item: {} })}>Add {tab === 'categories' ? 'category' : 'payment method'}</Button>
              </div>
              <Table rows={rows} columns={[
                { header: 'Name', cell: (r: any) => <span className="strong">{r.name}</span> }, ...(tab === 'methods' ? [{ header: 'Code', cell: (r: any) => r.code }, { header: 'Reference', cell: (r: any) => (r.requiresReference ? 'Required' : 'Optional') }] : []),
                { header: 'Status', cell: (r: any) => <Badge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
                { header: '', cell: (r: any) => <div className="row end"><Button size="sm" onClick={() => setEdit({ kind, item: r })}>Edit</Button><Button size="sm" variant="ghost" onClick={() => toggle.mutate({ kind, id: r.id, isActive: !r.isActive })}>{r.isActive ? 'Deactivate' : 'Activate'}</Button></div> },
              ]} />
            </div>
          );
        })()}
        {tab === 'periods' && <Periods />}
        {tab === 'import' && <ImportPanel />}
        {tab === 'integrations' && s && (
          <div className="card-body stack">
            <p className="muted">Only integrations that are really configured on the server are active. Nothing is simulated.</p>
            <Table rows={[
              ['E-mail (SMTP)', s.integrations.email, 'Password-reset and verification e-mails, e-mailed tenant reminders. Configured by the server administrator through SMTP_* environment variables.'],
              ['RRA / EBM', s.integrations.ebm, 'Not connected. EBM references are entered by staff on each invoice.'],
              ['SMS', s.integrations.sms, 'Not connected. Tenant messages are generated for you to copy and send.'],
              ['WhatsApp', s.integrations.whatsapp, 'Not connected. Tenant messages are generated for you to copy and send.'],
              ['Mobile Money / bank APIs', false, 'Not connected. Payments are recorded by staff with their transaction reference.'],
            ]} rowKey={(r) => String(r[0])} columns={[
              { header: 'Integration', cell: (r: any) => <span className="strong">{r[0]}</span> }, { header: 'Status', cell: (r: any) => <Badge status={r[1] ? 'ACTIVE' : 'INACTIVE'} text={r[1] ? 'Configured' : 'Not configured'} /> }, { header: 'Notes', cell: (r: any) => <span className="small">{r[2]}</span> },
            ]} />
          </div>
        )}
      </Card>
      {edit && (
        <Modal title={edit.item.id ? `Edit ${edit.item.name}` : 'Add'} onClose={() => setEdit(null)}>
          <AutoForm onCancel={() => setEdit(null)} initial={{ name: edit.item.name ?? '', requiresReference: edit.item.requiresReference ?? false }}
            fields={[{ name: 'name', label: 'Name', required: true, full: true }, ...(edit.kind === 'payment-methods' ? [{ name: 'requiresReference', label: 'Require a transaction reference', type: 'checkbox' as const, full: true }] : [])]}
            onSubmit={async (v) => { await saveItem.mutateAsync({ id: edit.item.id, ...v }); setEdit(null); }} />
        </Modal>
      )}
    </div>
  );
}

// ───────────── Audit log ─────────────

export function AuditLogs() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<any>(null);
  const q = useDebounced(search);
  const list = useApi('/audit-logs', { q, action, from, to, page, pageSize: 50 });
  return (
    <div className="stack">
      <PageHead title="Audit Logs" sub="A permanent record of who did what and when. Entries cannot be edited or deleted." />
      <ErrorBox error={list.error} />
      <Card pad={false}>
        <div className="filters no-print">
          <TextInput wide label="Search" value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Description or user" />
          <Select label="Action" value={action} onChange={(v) => { setAction(v); setPage(1); }} all="All actions" options={(list.data?.actions ?? []).map((a: string) => ({ value: a, label: label(a) }))} />
          <TextInput label="From" type="date" value={from} onChange={(v) => { setFrom(v); setPage(1); }} /><TextInput label="To" type="date" value={to} onChange={(v) => { setTo(v); setPage(1); }} />
        </div>
        <Table rows={list.data?.items} onRow={setOpen} empty={<Empty title="No audit entries match" />} columns={[
          { header: 'When', cell: (l: any) => <span className="nowrap">{dateTime(l.createdAt)}</span> }, { header: 'User', cell: (l: any) => l.userLabel?.replace(/ <.*>$/, '') ?? 'System' },
          { header: 'Action', cell: (l: any) => label(l.action) }, { header: 'Description', cell: (l: any) => <span className="small">{l.summary}</span> }, { header: 'Record', cell: (l: any) => l.entityType, hideSm: true },
        ]} />
        <Pager data={list.data} onPage={setPage} />
      </Card>
      {open && (
        <Modal title={label(open.action)} wide onClose={() => setOpen(null)} footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
          <div className="stack">
            <DL items={[['When', dateTime(open.createdAt)], ['User', open.userLabel ?? 'System'], ['Record', `${open.entityType}${open.entityId ? ` · ${open.entityId}` : ''}`], ['Description', open.summary ?? '—'], ['IP address', open.ip ?? '—'], ['Device', open.userAgent ?? '—'], ['Date', date(open.createdAt)]]} />
            {open.oldValue && <><h3>Old value</h3><pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--surface-2)', padding: 8, borderRadius: 6, margin: 0 }}>{JSON.stringify(open.oldValue, null, 2)}</pre></>}
            {open.newValue && <><h3>New value</h3><pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--surface-2)', padding: 8, borderRadius: 6, margin: 0 }}>{JSON.stringify(open.newValue, null, 2)}</pre></>}
          </div>
        </Modal>
      )}
    </div>
  );
}
