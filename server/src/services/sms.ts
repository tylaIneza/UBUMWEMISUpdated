import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * SMS delivery through a real provider account. Two providers used in Rwanda are supported:
 *   SMS_PROVIDER=africastalking  SMS_USERNAME=<app username>  SMS_API_KEY=<key>  [SMS_SENDER_ID=<approved sender>]
 *   SMS_PROVIDER=pindo           SMS_API_KEY=<token>          [SMS_SENDER_ID=<approved sender>]
 * Without these settings nothing is sent and nothing is reported as sent.
 */

export const testSmsOutbox: Array<{ to: string; text: string }> = [];
const capturing = () => config.NODE_ENV === 'test' && process.env.SMS_CAPTURE === 'true';

export function isSmsConfigured(): boolean {
  if (capturing()) return true;
  if (config.SMS_PROVIDER === 'africastalking') return Boolean(config.SMS_API_KEY && config.SMS_USERNAME);
  if (config.SMS_PROVIDER === 'pindo') return Boolean(config.SMS_API_KEY);
  return false;
}

export interface SmsResult {
  sent: boolean;
  reason?: string;
  providerId?: string;
}

async function africasTalking(to: string, text: string): Promise<SmsResult> {
  const host = config.SMS_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
  const body = new URLSearchParams({ username: config.SMS_USERNAME!, to, message: text, ...(config.SMS_SENDER_ID ? { from: config.SMS_SENDER_ID } : {}) });
  const res = await fetch(`https://${host}/version1/messaging`, { method: 'POST', headers: { apiKey: config.SMS_API_KEY!, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => null)) as { SMSMessageData?: { Message?: string; Recipients?: Array<{ status?: string; statusCode?: number; messageId?: string }> } } | null;
  const r = data?.SMSMessageData?.Recipients?.[0];
  // 100 = processed, 101 = sent, 102 = queued
  if (res.ok && r && [100, 101, 102].includes(Number(r.statusCode))) return { sent: true, providerId: r.messageId };
  return { sent: false, reason: r?.status ?? data?.SMSMessageData?.Message ?? `Provider answered ${res.status}` };
}

async function pindo(to: string, text: string): Promise<SmsResult> {
  const res = await fetch('https://api.pindo.io/v1/sms/', {
    method: 'POST', headers: { Authorization: `Bearer ${config.SMS_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, text, sender: config.SMS_SENDER_ID || 'PindoTest' }), signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as { sms_id?: number | string; message?: string; status?: string } | null;
  if (res.ok) return { sent: true, providerId: data?.sms_id !== undefined ? String(data.sms_id) : undefined };
  return { sent: false, reason: data?.message ?? `Provider answered ${res.status}` };
}

export async function sendSms(to: string, text: string): Promise<SmsResult> {
  if (!isSmsConfigured()) return { sent: false, reason: 'SMS delivery is not configured on this server.' };
  if (capturing()) {
    testSmsOutbox.push({ to, text });
    return { sent: true, providerId: `test-${testSmsOutbox.length}` };
  }
  try {
    const result = config.SMS_PROVIDER === 'pindo' ? await pindo(to, text) : await africasTalking(to, text);
    if (!result.sent) logger.warn({ to, reason: result.reason }, 'sms not accepted by provider');
    return result;
  } catch (err) {
    logger.warn({ err, to }, 'sms delivery failed');
    return { sent: false, reason: 'The SMS provider could not be reached.' };
  }
}
