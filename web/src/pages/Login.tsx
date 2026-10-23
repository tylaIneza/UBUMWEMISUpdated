import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api';
import { useAuth } from '../auth';
import './login.css';

/**
 * Sign-in experience: LOGIN → OTP VERIFICATION → SUCCESS → dashboard.
 * Presentation only — every decision (password check, code check, expiry, resend limits,
 * session) is made by the server through /auth/login, /auth/otp/verify and /auth/otp/resend.
 */

type Step = 'login' | 'otp' | 'success';
const LEN = 4;

interface Challenge {
  challenge: string;
  email: string;
  /** Local deadlines (ms since epoch), derived from the server's "seconds from now". */
  expiresAt: number;
  resendAt: number | null;
}

const toChallenge = (r: any): Challenge => ({
  challenge: r.challenge, email: r.email, expiresAt: Date.now() + r.expiresInSeconds * 1000,
  resendAt: r.resendInSeconds === null ? null : Date.now() + r.resendInSeconds * 1000,
});

const Icon = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d} /></svg>
);
const ICONS = {
  mail: 'M4 6h16v12H4z M4 7l8 6 8-6',
  lock: 'M6 11h12v9H6z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z',
  eyeOff: 'M3 3l18 18 M10.6 5.7A10.6 10.6 0 0 1 12 5.5C18.4 5.5 22 12 22 12a17 17 0 0 1-3 3.7 M6.5 7.4A16.5 16.5 0 0 0 2 12s3.6 6.5 10 6.5c1.5 0 2.8-.3 4-.8 M9.9 9.9a2.8 2.8 0 0 0 4 4',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 8v5 M12 16.5v.01 M12 3l9.5 17H2.5z',
};

function Brand({ compact }: { compact?: boolean }) {
  const [logo, setLogo] = useState(true);
  return (
    <div className={`ax-wordmark ${compact ? 'compact' : ''}`}>
      {/* The organization's real logo is used when it has been added to /brand; otherwise the name is set in type. */}
      {logo && <img src="/brand/logo.png" alt="" onError={() => setLogo(false)} />}
      <span><b>UBUMWE</b>HOUSE</span>
    </div>
  );
}

function BrandPanel() {
  return (
    <aside className="ax-brand" aria-label="UBUMWE HOUSE">
      <div className="ax-glow one" /><div className="ax-glow two" />
      <div className="ax-brand-top ax-rise" style={{ animationDelay: '0ms' }}><Brand /></div>
      <div className="ax-visual ax-rise" style={{ animationDelay: '80ms' }}>
        <img src="/brand/kcc.jpg" alt="Aerial photo of the Kigali Convention Centre" />
        <div className="ax-visual-shade" />
        <p className="ax-visual-caption">More Than Just a Building</p>
      </div>
      <div className="ax-brand-foot ax-rise" style={{ animationDelay: '160ms' }}>
        <p className="ax-tagline">Shops <i>•</i> Offices <i>•</i> Your Business Home</p>
      </div>
    </aside>
  );
}

function Field({ id, label, icon, error, children }: { id: string; label: string; icon: string; error?: string; children: ReactNode }) {
  return (
    <div className={`ax-field ${error ? 'invalid' : ''}`}>
      <span className="ax-field-icon"><Icon d={icon} /></span>
      {children}
      <label htmlFor={id}>{label}</label>
      {error && <p className="ax-field-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

function Spinner() {
  return <span className="ax-spinner" aria-hidden="true" />;
}

// ───────────── Step 1: login ─────────────

function LoginStep({ notice, onOtp, onDone }: { notice: string; onOtp: (c: Challenge) => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice);
  // The sign-in name is the e-mail address or the phone number on the account (078 812 3456 or +250…).
  const problem = (v: string) => (!v ? 'Enter your e-mail address or phone number.'
    : v.includes('@') ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? '' : 'This does not look like an e-mail address.')
    : /^\+?[\d\s\-().]{9,}$/.test(v) ? '' : 'Enter an e-mail address, or a phone number such as 078 812 3456.');
  const emailError = touched.email ? problem(email.trim()) : '';
  const passwordError = touched.password && !password ? 'Enter your password.' : '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (busy || !password || problem(email.trim())) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/auth/login', { login: email.trim(), password });
      if (result.otpRequired) onOtp(toChallenge(result));
      else onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="ax-form" onSubmit={submit} noValidate aria-labelledby="ax-login-title">
      <div className="ax-rise" style={{ animationDelay: '40ms' }}>
        <h1 id="ax-login-title">Welcome back</h1>
        <p className="ax-sub">Log in to manage your buildings, tenants and rent.</p>
      </div>
      {error && <div className="ax-alert" role="alert"><Icon d={ICONS.alert} />{error}</div>}
      <div className="ax-rise" style={{ animationDelay: '100ms' }}>
        <Field id="ax-email" label="E-mail or phone number" icon={ICONS.mail} error={emailError}>
          <input id="ax-email" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder=" " value={email} autoFocus
            onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, email: true }))} aria-invalid={Boolean(emailError)} aria-describedby={emailError ? 'ax-email-error' : undefined} />
        </Field>
      </div>
      <div className="ax-rise" style={{ animationDelay: '150ms' }}>
        <Field id="ax-password" label="Password" icon={ICONS.lock} error={passwordError}>
          <input id="ax-password" type={show ? 'text' : 'password'} autoComplete="current-password" placeholder=" " value={password}
            onChange={(e) => setPassword(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, password: true }))} aria-invalid={Boolean(passwordError)} aria-describedby={passwordError ? 'ax-password-error' : undefined} />
          <button type="button" className="ax-eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            <span key={String(show)} className="ax-eye-icon"><Icon d={show ? ICONS.eyeOff : ICONS.eye} /></span>
          </button>
        </Field>
      </div>
      <div className="ax-row ax-rise" style={{ animationDelay: '190ms' }}>
        <span />
        <Link to="/forgot-password">Forgot password?</Link>
      </div>
      <div className="ax-rise" style={{ animationDelay: '230ms' }}>
        <button type="submit" className="ax-cta" disabled={busy} aria-busy={busy}>
          {busy ? <><Spinner />Checking…</> : <>Log In <Icon d={ICONS.arrow} /></>}
        </button>
      </div>
      <p className="ax-fine ax-rise" style={{ animationDelay: '270ms' }}>Accounts are created by your administrator.</p>
    </form>
  );
}

// ───────────── Step 2: one-time code ─────────────

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function OtpStep({ challenge, onChallenge, onDone, onRestart }: { challenge: Challenge; onChallenge: (c: Challenge) => void; onDone: () => void; onRestart: (message: string) => void }) {
  const [digits, setDigits] = useState<string[]>(() => Array(LEN).fill(''));
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [shake, setShake] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [now, setNow] = useState(Date.now());
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => boxes.current[0]?.focus(), []);

  const expired = now >= challenge.expiresAt;
  const canResend = challenge.resendAt !== null && now >= challenge.resendAt;
  const code = digits.join('');
  // Auto-verify: as soon as the 4th digit is typed (or the code is pasted / filled in from the e-mail), check it —
  // once per code, so a rejected code is not sent again until it is changed.
  const tried = useRef('');
  useEffect(() => {
    if (code.length === LEN && code !== tried.current) void verify();
    if (code.length < LEN) tried.current = '';
  }, [code]);

  const fill = (from: number, text: string) => {
    const clean = text.replace(/\D/g, '').slice(0, LEN - from);
    if (!clean) return;
    const next = [...digits];
    for (let i = 0; i < clean.length; i += 1) next[from + i] = clean[i]!;
    setDigits(next);
    setError('');
    boxes.current[Math.min(from + clean.length, LEN - 1)]?.focus();
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) next[i] = '';
      else if (i > 0) { next[i - 1] = ''; boxes.current[i - 1]?.focus(); }
      setDigits(next);
    } else if (e.key === 'ArrowLeft' && i > 0) boxes.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < LEN - 1) boxes.current[i + 1]?.focus();
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/\D/g, '');
    fill(text.length >= LEN ? 0 : i, text);
  };
  const reject = (message: string) => {
    setError(message);
    setShake((n) => n + 1);
    setDigits(Array(LEN).fill(''));
    boxes.current[0]?.focus();
  };

  async function verify(e?: FormEvent) {
    e?.preventDefault();
    if (busy || accepted || code.length !== LEN || expired) return; // one submission at a time
    tried.current = code;
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await api.post('/auth/otp/verify', { challenge: challenge.challenge, code });
      // Let the boxes turn green one after another before moving on.
      setAccepted(true);
      setTimeout(onDone, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 620);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === 'OTP_RESTART') onRestart(err.message);
      else reject(errorMessage(err));
    }
  }
  async function resend() {
    if (resending || !canResend) return;
    setResending(true);
    setError('');
    try {
      onChallenge(toChallenge(await api.post('/auth/otp/resend', { challenge: challenge.challenge })));
      setDigits(Array(LEN).fill(''));
      setInfo('A new code has been sent.');
      boxes.current[0]?.focus();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'OTP_RESTART' || err.code === 'OTP_RESEND_LIMIT')) onRestart(err.message);
      else setError(errorMessage(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <form className="ax-form" onSubmit={verify} noValidate aria-labelledby="ax-otp-title">
      <ol className="ax-steps" aria-label="Sign-in progress">
        <li className="done"><span className="ax-dot"><Icon d={ICONS.check} size={13} /></span>Login<span className="sr-only"> — completed</span></li>
        <li className="ax-line" aria-hidden="true" />
        <li className="current" aria-current="step"><span className="ax-dot">2</span>OTP Verification</li>
      </ol>
      <div>
        <h1 id="ax-otp-title">Verify Your Account</h1>
        <p className="ax-sub">We’ve sent a 4-digit code to <strong>{challenge.email}</strong></p>
      </div>
      {error && <div className="ax-alert" role="alert"><Icon d={ICONS.alert} />{error}</div>}
      {info && !error && <div className="ax-alert ok" role="status"><Icon d={ICONS.check} />{info}</div>}
      <div key={shake} className={`ax-otp ${shake ? 'shake' : ''} ${error ? 'invalid' : ''} ${accepted ? 'accepted' : ''}`} role="group" aria-label="4-digit verification code">
        {digits.map((dgt, i) => (
          <div key={i} className={`ax-otp-cell ${dgt ? 'filled' : ''}`} style={{ animationDelay: `${90 + i * 70}ms`, ['--i' as string]: i }}>
            <input ref={(el) => { boxes.current[i] = el; }} value={dgt} inputMode="numeric" pattern="[0-9]*" maxLength={1} autoComplete={i === 0 ? 'one-time-code' : 'off'}
              aria-label={`Digit ${i + 1} of ${LEN}`} aria-invalid={Boolean(error)} disabled={busy || expired || accepted}
              onChange={(e) => fill(i, e.target.value)} onKeyDown={(e) => onKey(i, e)} onPaste={(e) => onPaste(i, e)} onFocus={(e) => e.target.select()} />
            {/* Re-mounted on every new digit so the pop-in animation replays. */}
            {dgt && <span key={dgt + i} className="ax-otp-ring" aria-hidden="true" />}
            <span className="ax-otp-bar" aria-hidden="true" />
          </div>
        ))}
      </div>
      <div className="ax-otp-progress" aria-hidden="true"><span style={{ width: `${(code.length / LEN) * 100}%` }} /></div>
      <p className={`ax-timer ${expired ? 'expired' : ''}`} aria-live="polite">
        {expired ? 'Code expired' : <>Code expires in <b>{mmss(challenge.expiresAt - now)}</b></>}
      </p>
      <button type="submit" className={`ax-cta ${accepted ? 'done' : ''}`} disabled={busy || accepted || code.length !== LEN || expired} aria-busy={busy}>
        {accepted ? <><Icon d={ICONS.check} />Verified</> : busy ? <><Spinner />Verifying…</> : <>Verify &amp; Continue <Icon d={ICONS.arrow} /></>}
      </button>
      <div className="ax-row center">
        {challenge.resendAt === null ? <span className="ax-fine">No more codes can be sent for this login.</span> : (
          <span className="ax-fine">Didn’t get it?{' '}
            <button type="button" className="ax-link" onClick={resend} disabled={!canResend || resending}>
              {resending ? 'Sending…' : canResend ? 'Resend Code' : `Resend in ${mmss(challenge.resendAt - now)}`}
            </button>
          </span>
        )}
      </div>
      <div className="ax-row center"><button type="button" className="ax-link quiet" onClick={() => onRestart('')}>← Back to login</button></div>
    </form>
  );
}

// ───────────── Step 3: success ─────────────

function SuccessStep({ verified }: { verified: boolean }) {
  return (
    <div className="ax-form ax-success" role="status" aria-live="polite">
      <div className="ax-check"><svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24" /><path d="M15 27l7.5 7.5L38 19" /></svg></div>
      <h1>{verified ? 'Verification Successful' : 'Login Successful'}</h1>
      <p className="ax-sub">You’re all set. Welcome back!</p>
      <p className="ax-fine">Opening your dashboard…</p>
    </div>
  );
}

export function Login() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('login');
  const [leaving, setLeaving] = useState(false);
  const [back, setBack] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [notice, setNotice] = useState('');
  const [verified, setVerified] = useState(false);
  const signedInHere = useRef(false);

  // Slide the current step out, then bring the next one in: one continuous flow rather than a page change.
  const go = useCallback((next: Step, backwards = false) => {
    setBack(backwards);
    setLeaving(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => { setStep(next); setLeaving(false); }, reduce ? 0 : 170);
  }, []);

  const finish = useCallback((viaOtp: boolean) => {
    signedInHere.current = true;
    setVerified(viaOtp);
    go('success');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The session cookie is already set by the server; load the user and continue to the existing dashboard route.
    setTimeout(async () => { await refresh(); navigate('/', { replace: true }); }, reduce ? 500 : 1350);
  }, [go, navigate, refresh]);

  if (me && !signedInHere.current) return <Navigate to="/" replace />;

  return (
    <div className="ax">
      <BrandPanel />
      <main className="ax-panel">
        <div className="ax-card">
          <div className="ax-card-brand"><Brand compact /></div>
          <div key={step} className={`ax-stage ${leaving ? (back ? 'out-back' : 'out') : back ? 'in-back' : 'in'}`}>
            {step === 'login' && <LoginStep notice={notice} onOtp={(c) => { setChallenge(c); setNotice(''); go('otp'); }} onDone={() => finish(false)} />}
            {step === 'otp' && challenge && <OtpStep challenge={challenge} onChallenge={setChallenge} onDone={() => finish(true)} onRestart={(message) => { setNotice(message); setChallenge(null); go('login', true); }} />}
            {step === 'success' && <SuccessStep verified={verified} />}
          </div>
        </div>
        <p className="ax-foot">© {new Date().getFullYear()} UBUMWE HOUSE · Secure sign-in</p>
        {/* The KCC photo's licence (CC BY-SA 4.0) requires this credit somewhere in the app; it is kept here, off the picture. */}
        <p className="ax-foot ax-credit">KCC photo: <a href="https://commons.wikimedia.org/wiki/File:An_aerial_of_Kigali_Convention_Center_on_June_19,_2019._Photo_by_Emmanuel_Kwizera.jpg" target="_blank" rel="noreferrer">Emmanuel Kwizera</a>, CC BY-SA 4.0</p>
      </main>
    </div>
  );
}
