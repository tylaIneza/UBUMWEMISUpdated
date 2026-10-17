import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useAuth, useMeta } from './auth';
import { label } from './format';
import { I, type IconName } from './icons';
import { Badge, Button, useDebounced } from './ui';

interface NavItem {
  to: string;
  text: string;
  perm: string[];
  icon: IconName;
  count?: number;
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const term = useDebounced(q.trim(), 250);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const results = useQuery({ queryKey: ['search', term], queryFn: () => api.get('/search', { q: term }), enabled: term.length >= 2 });
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const items: any[] = results.data?.items ?? [];
  return (
    <div className="search" ref={box} role="search">
      <label className="sr-only" htmlFor="global-search">Search tenants, rooms, contracts, receipts</label>
      <span className="search-icon"><I name="search" size={16} /></span>
      <input id="global-search" className="input" type="search" placeholder="Search tenant, phone, ID, room, contract, receipt, reference…" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && items[0]) { navigate(items[0].href); setOpen(false); setQ(''); } }} />
      {open && term.length >= 2 && (
        <div className="search-results">
          {results.isLoading && <div className="empty">Searching…</div>}
          {!results.isLoading && items.length === 0 && <div className="empty">Nothing found for “{term}”.</div>}
          {items.map((hit) => (
            <Link key={hit.type + hit.id} to={hit.href} onClick={() => { setOpen(false); setQ(''); }}>
              <div className="row between">
                <span><span className="muted small">{label(hit.type)} · </span><strong>{hit.title}</strong></span>
                {hit.badge && <Badge status={hit.badge} />}
              </div>
              <div className="small muted">{hit.context}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { me, can, buildingId, setBuildingId, refresh } = useAuth();
  const meta = useMeta();
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [logo, setLogo] = useState(true);
  useEffect(() => setMenu(false), [location.pathname]);
  const unread = useQuery({ queryKey: ['unread'], queryFn: () => api.get('/notifications/unread-count'), refetchInterval: 60_000 });
  const pending = useQuery({ queryKey: ['pending-approvals'], queryFn: () => api.get('/approvals', { status: 'SUBMITTED', pageSize: 1 }), enabled: can('approval.decide'), refetchInterval: 120_000 });
  if (!me) return null;

  const groups: Array<[string, NavItem[]]> = [
    ['Overview', [
      { to: '/', icon: 'dashboard', text: 'Dashboard', perm: ['dashboard.view'] },
      { to: '/daily', icon: 'clock', text: 'Daily Operations', perm: ['dashboard.view'] },
    ]],
    ['Property', [
      { to: '/buildings', icon: 'building', text: 'Buildings', perm: ['building.view'] },
      { to: '/floors', icon: 'layers', text: 'Floors', perm: ['building.view'] },
      { to: '/rooms', icon: 'door', text: 'Rooms', perm: ['room.view'] },
      { to: '/tenants', icon: 'users', text: 'Tenants', perm: ['tenant.view'] },
      { to: '/contracts', icon: 'file', text: 'Contracts', perm: ['contract.view'] },
      { to: '/maintenance', icon: 'wrench', text: 'Maintenance', perm: ['maintenance.view'] },
    ]],
    ['Finance', [
      { to: '/rent', icon: 'calendar', text: 'Rent', perm: ['rent.view'] },
      { to: '/unpaid', icon: 'alert', text: 'Unpaid & overdue', perm: ['rent.view'] },
      { to: '/payments', icon: 'wallet', text: 'Payments', perm: ['payment.view'] },
      { to: '/invoices', icon: 'receipt', text: 'Invoices / EBM', perm: ['invoice.view'] },
      { to: '/deposits', icon: 'shield', text: 'Deposits', perm: ['deposit.view'] },
      { to: '/expenses', icon: 'card', text: 'Expenses', perm: ['expense.view'] },
      { to: '/reminders', icon: 'bell', text: 'Reminders', perm: ['message.create'] },
      { to: '/approvals', icon: 'check', text: 'Approvals', perm: ['approval.view', 'approval.decide'], count: pending.data?.total },
      { to: '/reports', icon: 'chart', text: 'Reports', perm: ['report.view', 'report.financial'] },
    ]],
    ['Administration', [
      { to: '/notifications', icon: 'bell', text: 'Notifications', perm: [], count: unread.data?.unread },
      { to: '/users', icon: 'user', text: 'Users', perm: ['user.manage'] },
      { to: '/settings', icon: 'sliders', text: 'Settings', perm: ['settings.manage', 'period.manage', 'import.data'] },
      { to: '/audit', icon: 'list', text: 'Audit Logs', perm: ['audit.view'] },
    ]],
  ];

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    await refresh();
    navigate('/login');
  };

  return (
    <div className="shell">
      <aside className={`sidebar no-print ${menu ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">{logo && <img src="/brand/logo.png" alt="" onError={() => setLogo(false)} />}<span><b>UBUMWE</b>HOUSE</span></div>
          <small>Shops • Offices • Your Business Home</small>
        </div>
        <nav className="nav">
          {groups.map(([group, items]) => {
            const visible = items.filter((i) => i.perm.length === 0 || can(...i.perm));
            if (!visible.length) return null;
            return (
              <div key={group}>
                <div className="nav-group">{group}</div>
                {visible.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                    <span className="nav-label"><I name={i.icon} />{i.text}</span>
                    {Boolean(i.count) && <span className="count" aria-label={`${i.count} waiting`}>{i.count}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="main">
        {me.organization.isDemo && <div className="demo-banner screen" role="note">DEMO DATA — sample records for demonstration and training. Not real business data.</div>}
        <header className="topbar no-print">
          <Button className="menu-btn" onClick={() => setMenu(!menu)} aria-label="Open menu" aria-expanded={menu}>☰</Button>
          <label className="sr-only" htmlFor="building-filter">Property filter</label>
          <select id="building-filter" className="input" style={{ width: 'auto', maxWidth: 220, fontWeight: 600 }} value={buildingId} onChange={(e) => setBuildingId(e.target.value)} title="Property filter: applies to dashboards, lists and reports">
            <option value="">ALL BUILDINGS</option>
            {(meta.data?.buildings ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <GlobalSearch />
          <div className="row user-area" style={{ marginLeft: 'auto', flexWrap: 'nowrap' }}>
            <Link to="/notifications" className="icon-btn" aria-label={`Notifications${unread.data?.unread ? `, ${unread.data.unread} unread` : ''}`} title="Notifications">
              <I name="bell" />{Boolean(unread.data?.unread) && <span className="dot" aria-hidden="true" />}
            </Link>
            <Link to="/account" className="user-chip" title="Your account">
              <span className="avatar" aria-hidden="true">{me.user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
              <span className="hide-sm"><span className="user-name">{me.user.name}</span><span className="user-role">{me.user.roles.map(label).join(', ')}</span></span>
            </Link>
            <Button size="sm" onClick={logout} className="signout"><I name="logout" size={15} /><span>Sign out</span></Button>
          </div>
        </header>
        <main className="content">
          {me.user.mustChangePassword && location.pathname !== '/account' && (
            <div className="alert amber" style={{ marginBottom: 16 }}>
              <strong aria-hidden="true">!</strong>
              <div>Your password was set by an administrator. <Link to="/account">Choose your own password</Link> before continuing.</div>
            </div>
          )}
          <div key={location.pathname} className="page-enter"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
