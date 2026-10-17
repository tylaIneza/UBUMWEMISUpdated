import { config } from '../config.js';
import { inTransaction, prisma } from '../db.js';
import { AppError, badRequest, unauthorized } from '../errors.js';
import type { Actor } from '../http/context.js';
import { logger } from '../logger.js';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword, passwordProblem, randomToken, sha256, verifyPassword } from '../auth/passwords.js';
import { parsePhone } from '../lib/phone.js';
import { audit } from './audit.js';
import { isEmailConfigured, sendMail } from './mailer.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 60;
const VERIFY_TTL_HOURS = 72;

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

async function permissionsOf(userId: string): Promise<{ roles: string[]; permissions: Set<string> }> {
  const roles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const permissions = new Set<string>();
  for (const ur of roles) for (const rp of ur.role.permissions) permissions.add(rp.permission.key);
  return { roles: roles.map((r) => r.role.key), permissions };
}

/** The account a sign-in name belongs to: an e-mail address, or the phone number on the account (078…, +250…). */
async function findLoginUser(login: string) {
  const value = login.trim();
  if (value.includes('@')) return prisma.user.findUnique({ where: { email: value.toLowerCase() } });
  const phone = parsePhone(value).e164;
  if (!phone) return null;
  const matches = await prisma.user.findMany({ where: { phone, deletedAt: null }, take: 2 });
  // A number shared by two accounts identifies neither; those users sign in with their e-mail.
  return matches.length === 1 ? matches[0]! : null;
}

export async function login(emailOrPhone: string, password: string, client: ClientInfo) {
  const generic = unauthorized('The e-mail address, phone number or password is incorrect.');
  const user = await findLoginUser(emailOrPhone);
  if (!user || user.deletedAt) {
    // Spend comparable time so response timing does not reveal whether the account exists.
    await hashPassword(password);
    throw generic;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'This account is temporarily locked after too many failed sign-in attempts. Try again in a few minutes.');
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null },
    });
    await audit(prisma, null, {
      action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id,
      summary: `Failed sign-in for ${user.email}${lock ? ' — account locked' : ''} (${client.ip ?? 'unknown IP'})`,
    }, user.orgId);
    logger.warn({ userId: user.id, ip: client.ip }, 'failed login');
    throw generic;
  }
  if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact your administrator.');

  // Second factor: when e-mail delivery is configured, the password alone does not open a session.
  if (isEmailConfigured()) return { otp: await startLoginOtp(user, client) };
  return { session: await openSession(user, client) };
}

type UserRow = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;

/** Creates the server-side session after every authentication step has passed. */
async function openSession(user: UserRow, client: ClientInfo) {
  const token = randomToken(32);
  const csrfToken = sha256(randomToken(32));
  await prisma.session.create({
    data: {
      userId: user.id, tokenHash: sha256(token), csrfToken,
      ip: client.ip?.slice(0, 64), userAgent: client.userAgent?.slice(0, 255),
      expiresAt: new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000),
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const { roles, permissions } = await permissionsOf(user.id);
  const actor: Actor = { userId: user.id, orgId: user.orgId, name: user.fullName, email: user.email, roles, permissions, ...client };
  await audit(prisma, actor, { action: 'LOGIN', entityType: 'User', entityId: user.id, summary: `${user.fullName} signed in` });
  logger.info({ userId: user.id }, 'login');
  return { token, mustChangePassword: user.mustChangePassword };
}

// ───────────── Login one-time code (e-mail OTP) ─────────────

const OTP_TTL_SECONDS = 5 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS = 4;
const OTP_RESEND_SECONDS = 30;

/** "ineza****@gmail.com" */
export function maskEmail(email: string): string {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, Math.min(5, Math.max(1, name.length - 2)))}****@${domain}`;
}

// The code is only ever stored hashed, bound to its challenge and to the server secret.
const otpHash = (challenge: string, code: string) => sha256(`${config.SESSION_SECRET}:${challenge}:${code}`);
export const OTP_LENGTH = 4;
const newCode = () => String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

export interface OtpChallenge {
  challenge: string;
  email: string;
  expiresAt: string;
  resendAvailableAt: string | null;
  /** The same two moments as seconds from now, so the countdown does not depend on the device clock. */
  expiresInSeconds: number;
  resendInSeconds: number | null;
}

async function mailCode(user: UserRow, code: string): Promise<void> {
  const minutes = OTP_TTL_SECONDS / 60;
  const result = await sendMail({
    to: user.email, subject: 'Your UBUMWE HOUSE verification code',
    text: `UBUMWE HOUSE\n\nYour verification code is ${code}\n\nIt expires in ${minutes} minutes. If you did not try to sign in, change your password.\n\nUBUMWE HOUSE — Shops • Offices • Your Business Home`,
    html: `<div style="background:#f3f6fc;padding:32px 12px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0e1b33">
  <table role="presentation" align="center" width="100%" style="max-width:440px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e1e8f5" cellpadding="0" cellspacing="0">
    <tr><td style="background:#0c2146;padding:22px 28px;color:#ffffff;font-size:17px;letter-spacing:4px"><b style="letter-spacing:2px">UBUMWE</b>&nbsp; HOUSE</td></tr>
    <tr><td style="padding:28px">
      <p style="margin:0 0 6px;font-size:18px;font-weight:700">Verify your account</p>
      <p style="margin:0 0 20px;font-size:14px;color:#51607a">Use this code to finish signing in.</p>
      <p style="margin:0 0 20px;font-size:38px;font-weight:800;letter-spacing:14px;color:#1746d1;background:#eef3ff;border-radius:14px;padding:16px 0 16px 14px;text-align:center">${code}</p>
      <p style="margin:0;font-size:13px;color:#51607a">The code expires in ${minutes} minutes. If you did not try to sign in, change your password.</p>
    </td></tr>
    <tr><td style="padding:14px 28px;background:#f7f9fd;font-size:12px;color:#8492aa">UBUMWE HOUSE &middot; Shops &bull; Offices &bull; Your Business Home</td></tr>
  </table>
</div>`,
  });
  if (!result.sent) throw new AppError(502, 'OTP_NOT_SENT', 'We could not send your verification code by e-mail. Nothing was signed in. Please try again in a moment.');
}

function describe(challenge: string, user: UserRow, row: { expiresAt: Date; sentAt: Date | null; sendCount: number }): OtpChallenge {
  const resendAt = row.sendCount < OTP_MAX_SENDS ? (row.sentAt ?? new Date()).getTime() + OTP_RESEND_SECONDS * 1000 : null;
  const seconds = (at: number) => Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return {
    challenge, email: maskEmail(user.email), expiresAt: row.expiresAt.toISOString(), expiresInSeconds: seconds(row.expiresAt.getTime()),
    resendAvailableAt: resendAt ? new Date(resendAt).toISOString() : null, resendInSeconds: resendAt ? seconds(resendAt) : null,
  };
}

async function startLoginOtp(user: UserRow, client: ClientInfo): Promise<OtpChallenge> {
  const challenge = randomToken(32);
  const code = newCode();
  await mailCode(user, code);
  await prisma.authToken.updateMany({ where: { userId: user.id, type: 'LOGIN_OTP', usedAt: null }, data: { usedAt: new Date() } });
  const row = await prisma.authToken.create({
    data: { userId: user.id, type: 'LOGIN_OTP', tokenHash: sha256(challenge), codeHash: otpHash(challenge, code), expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000), sentAt: new Date(), sendCount: 1 },
  });
  await audit(prisma, null, { action: 'LOGIN_OTP_SENT', entityType: 'User', entityId: user.id, summary: `Verification code e-mailed to ${maskEmail(user.email)} (${client.ip ?? 'unknown IP'})` }, user.orgId);
  return describe(challenge, user, row);
}

const restart = () => new AppError(401, 'OTP_RESTART', 'This verification has ended. Please log in again.');

async function loadChallenge(challenge: string) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: sha256(challenge) }, include: { user: true } });
  if (!row || row.type !== 'LOGIN_OTP' || row.usedAt || row.user.deletedAt || row.user.status !== 'ACTIVE') throw restart();
  return row;
}

export async function resendLoginOtp(challenge: string): Promise<OtpChallenge> {
  const row = await loadChallenge(challenge);
  if (row.sendCount >= OTP_MAX_SENDS) throw new AppError(429, 'OTP_RESEND_LIMIT', 'The code has been sent the maximum number of times. Please log in again.');
  const wait = OTP_RESEND_SECONDS * 1000 - (Date.now() - (row.sentAt?.getTime() ?? 0));
  if (wait > 0) throw new AppError(429, 'OTP_RESEND_WAIT', `Please wait ${Math.ceil(wait / 1000)} seconds before asking for another code.`);
  const code = newCode();
  await mailCode(row.user, code);
  // A new code replaces the old one and gets a fresh expiry; wrong-guess count is kept.
  const updated = await prisma.authToken.update({ where: { id: row.id }, data: { codeHash: otpHash(challenge, code), expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000), sentAt: new Date(), sendCount: { increment: 1 } } });
  return describe(challenge, row.user, updated);
}

export async function verifyLoginOtp(challenge: string, code: string, client: ClientInfo) {
  const row = await loadChallenge(challenge);
  if (row.expiresAt <= new Date()) throw new AppError(400, 'OTP_EXPIRED', 'This code has expired. Request a new code.');
  // Count the attempt first (atomically), so parallel guesses cannot exceed the limit.
  const counted = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
  if (counted.count === 0) {
    await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    throw restart();
  }
  const expected = Buffer.from(row.codeHash ?? '');
  const given = Buffer.from(otpHash(challenge, code));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    const left = OTP_MAX_ATTEMPTS - (row.attempts + 1);
    await audit(prisma, null, { action: 'LOGIN_OTP_FAILED', entityType: 'User', entityId: row.userId, summary: `Wrong verification code for ${row.user.email} (${client.ip ?? 'unknown IP'})` }, row.user.orgId);
    if (left <= 0) {
      await prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
      throw new AppError(401, 'OTP_RESTART', 'Too many incorrect codes. Please log in again.');
    }
    throw new AppError(400, 'OTP_INVALID', `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.`, { attemptsLeft: left });
  }
  // Single use: only the request that flips usedAt opens the session.
  const used = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (used.count === 0) throw restart();
  return openSession(row.user, client);
}

/** Resolves a session cookie to the acting user, or null if the session is not valid. */
export async function resolveSession(token: string, client: ClientInfo) {
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  const user = session.user;
  if (user.deletedAt || user.status !== 'ACTIVE') return null;
  // Touch at most once a minute to avoid a write on every request.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  const { roles, permissions } = await permissionsOf(user.id);
  const actor: Actor = { userId: user.id, orgId: user.orgId, name: user.fullName, email: user.email, roles, permissions, ...client };
  return { actor, sessionId: session.id, csrfToken: session.csrfToken, user };
}

export async function logout(sessionId: string, actor: Actor) {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  await audit(prisma, actor, { action: 'LOGOUT', entityType: 'User', entityId: actor.userId, summary: `${actor.name} signed out` });
}

export async function changePassword(actor: Actor, sessionId: string, currentPassword: string, newPassword: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw badRequest('Your current password is incorrect.', 'WRONG_PASSWORD');
  const problem = passwordProblem(newPassword);
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
  if (await verifyPassword(newPassword, user.passwordHash)) throw badRequest('The new password must be different from the current one.', 'WEAK_PASSWORD');
  const passwordHash = await hashPassword(newPassword);
  await inTransaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
    // Sign out every other device.
    await tx.session.updateMany({ where: { userId: user.id, id: { not: sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, actor, { action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id, summary: `${user.fullName} changed their password` });
  });
}

async function createToken(userId: string, type: 'PASSWORD_RESET' | 'EMAIL_VERIFY', ttlMs: number): Promise<string> {
  const token = randomToken(32);
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

export function resetLink(token: string): string {
  return `${config.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
}

export function verifyLink(token: string): string {
  return `${config.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Self-service "forgot password". Always resolves without revealing whether the address
 * exists. The link is e-mailed only if SMTP is configured; otherwise an administrator
 * must issue a reset link from the Users screen.
 */
export async function requestPasswordReset(email: string, client: ClientInfo): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || user.deletedAt || user.status !== 'ACTIVE') return;
  const token = await createToken(user.id, 'PASSWORD_RESET', RESET_TTL_MINUTES * 60_000);
  await audit(prisma, null, { action: 'PASSWORD_RESET_REQUESTED', entityType: 'User', entityId: user.id, summary: `Password reset requested for ${user.email} (${client.ip ?? 'unknown IP'})` }, user.orgId);
  if (isEmailConfigured()) {
    await sendMail({
      to: user.email,
      subject: 'Reset your password',
      text: `Hello ${user.fullName},\n\nUse this link to choose a new password. It expires in ${RESET_TTL_MINUTES} minutes.\n\n${resetLink(token)}\n\nIf you did not ask for this, you can ignore this e-mail.`,
    });
  } else {
    logger.warn({ userId: user.id }, 'password reset requested but e-mail is not configured; an administrator must issue a reset link');
  }
}

/** Administrator-issued reset link (works without e-mail). */
export async function issueResetLink(actor: Actor, userId: string): Promise<{ link: string; emailed: boolean }> {
  const user = await prisma.user.findFirst({ where: { id: userId, orgId: actor.orgId, deletedAt: null } });
  if (!user) throw badRequest('User not found.');
  const token = await createToken(user.id, 'PASSWORD_RESET', RESET_TTL_MINUTES * 60_000);
  const link = resetLink(token);
  const mail = await sendMail({ to: user.email, subject: 'Reset your password', text: `Hello ${user.fullName},\n\nAn administrator created a password reset link for you. It expires in ${RESET_TTL_MINUTES} minutes.\n\n${link}` });
  await audit(prisma, actor, { action: 'PASSWORD_RESET_ISSUED', entityType: 'User', entityId: user.id, summary: `Reset link issued for ${user.email}` });
  return { link, emailed: mail.sent };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const problem = passwordProblem(newPassword);
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD');
  const record = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!record || record.type !== 'PASSWORD_RESET' || record.usedAt || record.expiresAt <= new Date() || record.user.deletedAt) {
    throw badRequest('This reset link is invalid or has expired. Please request a new one.', 'INVALID_TOKEN');
  }
  const passwordHash = await hashPassword(newPassword);
  await inTransaction(async (tx) => {
    await tx.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: record.userId }, data: { passwordHash, mustChangePassword: false, failedLogins: 0, lockedUntil: null } });
    await tx.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, null, { action: 'PASSWORD_RESET', entityType: 'User', entityId: record.userId, summary: `Password reset completed for ${record.user.email}` }, record.user.orgId);
  });
}

export async function issueVerification(userId: string): Promise<{ link: string; emailed: boolean }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const token = await createToken(user.id, 'EMAIL_VERIFY', VERIFY_TTL_HOURS * 3_600_000);
  const link = verifyLink(token);
  const mail = await sendMail({ to: user.email, subject: 'Confirm your e-mail address', text: `Hello ${user.fullName},\n\nPlease confirm your e-mail address:\n\n${link}` });
  return { link, emailed: mail.sent };
}

/** An administrator confirms a user's e-mail address directly — no link needed (e.g. the person cannot open it). */
export async function markEmailVerified(actor: Actor, userId: string): Promise<void> {
  await inTransaction(async (tx) => {
    const user = await tx.user.findFirstOrThrow({ where: { id: userId, orgId: actor.orgId } });
    if (user.emailVerifiedAt) return;
    await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    await tx.authToken.updateMany({ where: { userId, type: 'EMAIL_VERIFY', usedAt: null }, data: { usedAt: new Date() } });
    await audit(tx, actor, { action: 'EMAIL_VERIFIED', entityType: 'User', entityId: userId, summary: `${user.email} marked as verified by ${actor.name}` });
  });
}

export async function verifyEmail(token: string): Promise<void> {
  const record = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  // Opening the same link twice (or after an administrator confirmed the address) is not an error.
  if (record?.type === 'EMAIL_VERIFY' && record.user.emailVerifiedAt) return;
  if (!record || record.type !== 'EMAIL_VERIFY' || record.usedAt || record.expiresAt <= new Date()) {
    throw badRequest('This verification link is invalid or has expired.', 'INVALID_TOKEN');
  }
  await inTransaction(async (tx) => {
    await tx.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    await audit(tx, null, { action: 'EMAIL_VERIFIED', entityType: 'User', entityId: record.userId, summary: `${record.user.email} verified their e-mail address` }, record.user.orgId);
  });
}
