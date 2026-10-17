import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** Automated tests only: messages are captured here instead of being sent. Never active outside NODE_ENV=test. */
export const testOutbox: Array<{ to: string; subject: string; text: string; html?: string }> = [];
const capturing = () => config.NODE_ENV === 'test' && process.env.MAIL_CAPTURE === 'true';

export function isEmailConfigured(): boolean {
  return capturing() || Boolean(config.SMTP_HOST && config.SMTP_FROM);
}

let transport: Transporter | null = null;

export interface MailResult {
  sent: boolean;
  /** Why the message was not sent (never set when sent = true). */
  reason?: string;
}

/**
 * Sends an e-mail through the configured SMTP server. If SMTP is not configured the
 * message is NOT sent and the result says so — callers must never report it as delivered.
 */
/** Every message goes out under the brand name, whatever display name the mailbox itself has. */
const SENDER_NAME = 'UBUMWE HOUSE';
const senderAddress = () => /<([^>]+)>/.exec(config.SMTP_FROM ?? '')?.[1] ?? (config.SMTP_FROM ?? '').trim();

export async function sendMail(msg: { to: string; subject: string; text: string; html?: string }): Promise<MailResult> {
  if (!isEmailConfigured()) return { sent: false, reason: 'E-mail delivery is not configured on this server.' };
  if (capturing()) {
    testOutbox.push(msg);
    return { sent: true };
  }
  transport ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: config.SMTP_SECURE === 'true',
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  try {
    await transport.sendMail({ from: { name: SENDER_NAME, address: senderAddress() }, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return { sent: true };
  } catch (err) {
    logger.warn({ err, to: msg.to }, 'e-mail delivery failed');
    return { sent: false, reason: 'The mail server rejected or could not deliver the message.' };
  }
}
