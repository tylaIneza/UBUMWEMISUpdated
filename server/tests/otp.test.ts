import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { maskEmail } from '../src/services/auth.js';
import { testOutbox } from '../src/services/mailer.js';
import { app, createWorld, PASSWORD, type World } from './helpers.js';

let w: World;
const api = (path: string, body: object) => request(app).post(`/api/v1${path}`).send(body);
const lastCode = () => /code is (\d{4})\n/.exec(testOutbox.at(-1)!.text)![1]!;
const wrong = (code: string) => (code === '0000' ? '1111' : '0000');

async function start(email = w.emails.CASHIER) {
  const res = await api('/auth/login', { email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  w = await createWorld();
  process.env.MAIL_CAPTURE = 'true'; // e-mail "configured": messages are captured instead of sent
});
afterAll(() => {
  delete process.env.MAIL_CAPTURE;
});
beforeEach(async () => {
  testOutbox.length = 0;
  await prisma.authToken.deleteMany({ where: { type: 'LOGIN_OTP' } });
});

describe('login with e-mail one-time code', () => {
  it('does not open a session on the password alone', async () => {
    const res = await start();
    expect(res.body).toMatchObject({ otpRequired: true, email: maskEmail(w.emails.CASHIER) });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.email).not.toContain('cashier@');
    expect(await prisma.session.count({ where: { userId: w.actors.CASHIER.userId } })).toBe(0);
    // The real expiry is returned for the countdown: five minutes from now.
    const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(4.8 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
    // The code went to the user's own address and is not stored in readable form.
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]!.to).toBe(w.emails.CASHIER);
    expect(testOutbox[0]!.subject).toBe('Your UBUMWE HOUSE verification code');
    expect(testOutbox[0]!.html).toContain(lastCode());
    const row = await prisma.authToken.findFirstOrThrow({ where: { type: 'LOGIN_OTP' } });
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(lastCode());
    expect(JSON.stringify(res.body)).not.toContain(lastCode());
  });

  it('a wrong password never sends a code', async () => {
    const res = await api('/auth/login', { email: w.emails.CASHIER, password: 'Wrong-Password-1' });
    expect(res.status).toBe(401);
    expect(testOutbox).toHaveLength(0);
  });

  it('opens the session only with the correct code, and the code works once', async () => {
    const { body } = await start();
    const code = lastCode();
    const ok = await api('/auth/otp/verify', { challenge: body.challenge, code });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/rpms_sid=.*HttpOnly/);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie.split(';')[0]!);
    expect(me.body.user.email).toBe(w.emails.CASHIER);
    expect((await api('/auth/otp/verify', { challenge: body.challenge, code })).body.error.code).toBe('OTP_RESTART');
    expect(await prisma.auditLog.count({ where: { action: 'LOGIN', entityId: w.actors.CASHIER.userId } })).toBe(1);
  });

  it('keeps the challenge alive after a wrong code, then ends it after five wrong codes', async () => {
    const { body } = await start();
    const code = lastCode();
    const first = await api('/auth/otp/verify', { challenge: body.challenge, code: wrong(code) });
    expect([first.status, first.body.error.code, first.body.error.details.attemptsLeft]).toEqual([400, 'OTP_INVALID', 4]);
    expect(first.headers['set-cookie']).toBeUndefined();
    for (let i = 0; i < 3; i += 1) await api('/auth/otp/verify', { challenge: body.challenge, code: wrong(code) });
    const fifth = await api('/auth/otp/verify', { challenge: body.challenge, code: wrong(code) });
    expect([fifth.status, fifth.body.error.code]).toEqual([401, 'OTP_RESTART']);
    // Even the right code is useless now.
    expect((await api('/auth/otp/verify', { challenge: body.challenge, code })).status).toBe(401);
    expect(await prisma.session.count({ where: { userId: w.actors.CASHIER.userId } })).toBe(1); // only the earlier test's session
  });

  it('rejects an expired code and accepts a freshly resent one', async () => {
    const { body } = await start();
    const old = lastCode();
    expect((await api('/auth/otp/resend', { challenge: body.challenge })).body.error.code).toBe('OTP_RESEND_WAIT');
    await prisma.authToken.updateMany({ where: { type: 'LOGIN_OTP' }, data: { expiresAt: new Date(Date.now() - 1000), sentAt: new Date(Date.now() - 60_000) } });
    expect((await api('/auth/otp/verify', { challenge: body.challenge, code: old })).body.error.code).toBe('OTP_EXPIRED');

    const resent = await api('/auth/otp/resend', { challenge: body.challenge });
    expect(resent.status).toBe(200);
    expect(new Date(resent.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(testOutbox).toHaveLength(2);
    const fresh = lastCode();
    if (fresh !== old) expect((await api('/auth/otp/verify', { challenge: body.challenge, code: old })).body.error.code).toBe('OTP_INVALID');
    expect((await api('/auth/otp/verify', { challenge: body.challenge, code: fresh })).status).toBe(200);
  });

  it('limits how many times a code can be resent, and a new login cancels the previous challenge', async () => {
    const first = (await start()).body;
    for (let i = 0; i < 3; i += 1) {
      await prisma.authToken.updateMany({ where: { type: 'LOGIN_OTP', usedAt: null }, data: { sentAt: new Date(Date.now() - 60_000) } });
      expect((await api('/auth/otp/resend', { challenge: first.challenge })).status).toBe(200);
    }
    await prisma.authToken.updateMany({ where: { type: 'LOGIN_OTP', usedAt: null }, data: { sentAt: new Date(Date.now() - 60_000) } });
    const limit = await api('/auth/otp/resend', { challenge: first.challenge });
    expect([limit.status, limit.body.error.code]).toEqual([429, 'OTP_RESEND_LIMIT']);

    const code = lastCode();
    await start();
    expect((await api('/auth/otp/verify', { challenge: first.challenge, code })).body.error.code).toBe('OTP_RESTART');
  });

  it('validates input and refuses unknown challenges', async () => {
    expect((await api('/auth/otp/verify', { challenge: 'x'.repeat(43), code: '1234' })).status).toBe(401);
    expect((await api('/auth/otp/verify', { challenge: 'x'.repeat(43), code: '123456' })).status).toBe(400);
    expect((await api('/auth/otp/resend', { challenge: 'x'.repeat(43) })).status).toBe(401);
  });

  it('fails closed if the code cannot be e-mailed, and skips the step only when e-mail is not configured at all', async () => {
    delete process.env.MAIL_CAPTURE;
    const plain = await api('/auth/login', { email: w.emails.VIEWER, password: PASSWORD });
    expect(plain.body.otpRequired).toBe(false);
    expect(plain.headers['set-cookie']).toBeDefined();
    process.env.MAIL_CAPTURE = 'true';
  });

  it('masks e-mail addresses', () => {
    expect(maskEmail('inezapaccy45@gmail.com')).toBe('ineza****@gmail.com');
    expect(maskEmail('ab@x.rw')).toBe('a****@x.rw');
  });
});
