import type { ErrorRequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

/** Database rule names → the message staff should see when the rule blocks an operation. */
const RULE_MESSAGES: Array<[RegExp, string, string]> = [
  [/uq_contract_one_occupant_per_room/, 'ROOM_OCCUPIED', 'This room is already occupied. An active contract already exists for this room.'],
  [/uq_reservation_one_active_per_room/, 'ROOM_RESERVED', 'This room already has an active reservation.'],
  [/uq_charge_one_live_per_period/, 'CHARGE_EXISTS', 'A rent charge already exists for this contract and month.'],
  [/uq_payment_live_reference/, 'DUPLICATE_REFERENCE', 'A payment with this transaction reference has already been recorded for this payment method.'],
  [/payments_orgId_idempotencyKey_key/, 'DUPLICATE_SUBMISSION', 'This payment has already been submitted.'],
  [/rooms_buildingId_number_key/, 'DUPLICATE_ROOM', 'A room with this number already exists in this building.'],
  [/floors_buildingId_name_key/, 'DUPLICATE_FLOOR', 'A floor with this name already exists in this building.'],
  [/floors_buildingId_level_key/, 'DUPLICATE_FLOOR', 'A floor with this level already exists in this building.'],
  [/buildings_orgId_code_key/, 'DUPLICATE_BUILDING', 'A building with this code already exists.'],
  [/buildings_orgId_name_key/, 'DUPLICATE_BUILDING', 'A building with this name already exists.'],
  [/tenants_orgId_idNumber_key/, 'DUPLICATE_TENANT', 'A tenant with this ID/passport number is already registered.'],
  [/users_email_key/, 'DUPLICATE_USER', 'A user with this e-mail address already exists.'],
  [/invoices_orgId_ebmReference_key/, 'DUPLICATE_EBM', 'This EBM reference is already recorded on another invoice.'],
  [/expense_categories_orgId_name_key/, 'DUPLICATE_CATEGORY', 'An expense category with this name already exists.'],
  [/payment_methods_orgId_code_key/, 'DUPLICATE_METHOD', 'A payment method with this code already exists.'],
  [/accounting_periods_orgId_period_key/, 'DUPLICATE_PERIOD', 'This accounting period already exists.'],
  [/chk_contract_dates/, 'INVALID_DATES', 'The contract end date must be on or after the start date.'],
  [/chk_charge_/, 'LEDGER_RULE', 'This change would leave a rent charge in an inconsistent state and was rejected.'],
  [/chk_payment_/, 'LEDGER_RULE', 'This change would leave a payment in an inconsistent state and was rejected.'],
  [/chk_expense_scope/, 'INVALID_SCOPE', 'The expense scope does not match the selected building, floor or room.'],
];

function flatten(err: unknown, depth = 0): string {
  if (!err || depth > 4) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  const meta = (() => {
    try {
      return e.meta ? JSON.stringify(e.meta) : '';
    } catch {
      return '';
    }
  })();
  return [e.code, e.message, meta, flatten(e.cause, depth + 1)].filter(Boolean).join(' | ');
}

/** Translates database constraint/trigger failures into user-facing errors. Returns null if unrecognised. */
export function translateDbError(err: unknown): AppError | null {
  const text = flatten(err);
  if (!text) return null;
  const signal = /RPMS: ([^|"\\]+)/.exec(text);
  if (signal?.[1]) {
    const msg = signal[1].trim();
    return new AppError(409, 'RULE_VIOLATION', msg.charAt(0).toUpperCase() + msg.slice(1) + '.');
  }
  for (const [pattern, code, message] of RULE_MESSAGES) {
    if (pattern.test(text)) return new AppError(409, code, message);
  }
  if (/P2002|Duplicate entry|ER_DUP_ENTRY/.test(text)) {
    return new AppError(409, 'DUPLICATE', 'A record with the same unique value already exists.');
  }
  if (/P2003|foreign key constraint fails|ER_ROW_IS_REFERENCED|ER_NO_REFERENCED_ROW/.test(text)) {
    return new AppError(409, 'IN_USE', 'This record is linked to other records and cannot be removed or changed this way.');
  }
  if (/P2025/.test(text)) return new AppError(404, 'NOT_FOUND', 'The record was not found. It may have been changed by someone else.');
  if (/P2034|Deadlock found|Lock wait timeout/.test(text)) {
    return new AppError(503, 'BUSY', 'The record is being updated by someone else right now. Nothing was saved — please try again.');
  }
  if (/CONSTRAINT `?chk_|ER_CONSTRAINT_FAILED|4025/.test(text)) {
    return new AppError(409, 'RULE_VIOLATION', 'The data violates a business rule and was not saved.');
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    const first = err.issues[0];
    const label = first && first.path.length ? `${first.path.join('.')}: ` : '';
    res.status(400).json({ error: { code: 'VALIDATION', message: `Please check the form. ${label}${first?.message ?? ''}`.trim(), details: { fields } } });
    return;
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large.' : `The file could not be uploaded (${err.code}).`;
    res.status(400).json({ error: { code: 'UPLOAD_FAILED', message } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
    return;
  }
  const appErr = err instanceof AppError ? err : translateDbError(err);
  if (appErr) {
    if (appErr.status >= 500) logger.warn({ err, path: req.path }, 'request failed');
    res.status(appErr.status).json({ error: { code: appErr.code, message: appErr.message, details: appErr.details } });
    return;
  }
  const requestId = (req as { id?: string | number }).id;
  logger.error({ err, path: req.path, method: req.method, requestId }, 'unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong on the server and nothing was saved. Please try again; if it keeps happening, contact the administrator.',
      details: { requestId },
    },
  });
};
