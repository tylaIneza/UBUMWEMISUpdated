import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { date, label } from '../format';
import { Alert, AutoForm, Card, DL, ErrorBox, PageHead, useToast } from '../ui';

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <div className="card">
        <div className="card-head"><h1>{title}</h1></div>
        <div className="card-body stack">{children}</div>
      </div>
    </div>
  );
}

export function ForgotPassword() {
  const [message, setMessage] = useState('');
  return (
    <AuthCard title="Reset your password">
      {message ? <Alert tone="blue">{message}</Alert> : (
        <AutoForm submitLabel="Request reset link" fields={[{ name: 'email', label: 'E-mail address', type: 'email', required: true, full: true }]}
          onSubmit={async (v) => setMessage((await api.post('/auth/forgot-password', v)).message)} />
      )}
      <Link to="/login" className="small">Back to sign in</Link>
    </AuthCard>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  const token = params.get('token') ?? '';
  return (
    <AuthCard title="Choose a new password">
      {done ? <Alert tone="green">Your password has been changed. <Link to="/login">Sign in</Link></Alert> : !token ? <Alert>This reset link is incomplete. Request a new one.</Alert> : (
        <AutoForm submitLabel="Set new password" fields={[
          { name: 'newPassword', label: 'New password', type: 'password', required: true, full: true, hint: 'At least 8 characters with an uppercase letter, a lowercase letter and a number.' },
          { name: 'confirm', label: 'Repeat new password', type: 'password', required: true, full: true },
        ]} onSubmit={async (v) => {
          if (v.newPassword !== v.confirm) throw new Error('mismatch');
          await api.post('/auth/reset-password', { token, newPassword: v.newPassword });
          setDone(true);
        }} />
      )}
    </AuthCard>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const [state, setState] = useState<{ ok?: boolean; error?: unknown }>({});
  const sent = useRef('');
  useEffect(() => {
    // Send each link once, even when React runs the effect twice in development.
    const token = params.get('token') ?? '';
    if (sent.current === token) return;
    sent.current = token;
    api.post('/auth/verify-email', { token }).then(() => setState({ ok: true })).catch((error) => setState((s) => (s.ok ? s : { error })));
  }, [params]);
  return (
    <AuthCard title="E-mail verification">
      {state.ok && <Alert tone="green">Your e-mail address is confirmed. <Link to="/login">Continue</Link></Alert>}
      <ErrorBox error={state.error} />
      {!state.ok && !state.error && <p className="muted">Verifying…</p>}
    </AuthCard>
  );
}

export function Account() {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const [mismatch, setMismatch] = useState(false);
  if (!me) return null;
  return (
    <div className="stack">
      <PageHead title="Your account" />
      <div className="grid c2">
        <Card title="Profile">
          <DL items={[['Name', me.user.name], ['E-mail', me.user.email], ['E-mail verified', me.user.emailVerifiedAt ? date(me.user.emailVerifiedAt) : 'Not yet verified'], ['Roles', me.user.roles.map(label).join(', ')], ['Organization', me.organization.name]]} />
        </Card>
        <Card title="Change password">
          {mismatch && <Alert>The two new passwords do not match.</Alert>}
          <AutoForm submitLabel="Change password" fields={[
            { name: 'currentPassword', label: 'Current password', type: 'password', required: true, full: true },
            { name: 'newPassword', label: 'New password', type: 'password', required: true, full: true, hint: 'At least 8 characters with an uppercase letter, a lowercase letter and a number.' },
            { name: 'confirm', label: 'Repeat new password', type: 'password', required: true, full: true },
          ]} onSubmit={async (v) => {
            setMismatch(v.newPassword !== v.confirm);
            if (v.newPassword !== v.confirm) return;
            await api.post('/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
            await refresh();
            toast('Password changed. Other devices have been signed out.');
          }} />
        </Card>
      </div>
    </div>
  );
}
