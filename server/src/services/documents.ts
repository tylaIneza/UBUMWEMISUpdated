import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { config } from '../config.js';
import { inTransaction, prisma } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { can, type Actor } from '../http/context.js';
import type { PermissionKey } from '../auth/permissions.js';
import { audit } from './audit.js';

const STORAGE_ROOT = resolve(config.STORAGE_DIR);

/** Which record types documents can be attached to, and the permission needed to see them. */
const ENTITY_ACCESS: Record<string, PermissionKey> = {
  Tenant: 'tenant.view', Contract: 'contract.view', Payment: 'payment.view', Expense: 'expense.view',
  MaintenanceRequest: 'maintenance.view', Room: 'room.view', Building: 'building.view',
};

export const DOCUMENT_CATEGORIES = ['ID_DOCUMENT', 'PHOTO', 'CONTRACT', 'PAYMENT_EVIDENCE', 'RECEIPT', 'MAINTENANCE', 'OTHER'] as const;

/** Allowed types, each verified against the file's actual leading bytes (not just its name). */
const TYPES: Array<{ mime: string; exts: string[]; test: (b: Buffer) => boolean }> = [
  { mime: 'application/pdf', exts: ['.pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', exts: ['.png'], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', exts: ['.webp'], test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // .docx / .xlsx are ZIP containers.
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['.docx'], test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: ['.xlsx'], test: (b) => b[0] === 0x50 && b[1] === 0x4b },
];

export function detectFileType(fileName: string, buffer: Buffer): string {
  const ext = extname(fileName).toLowerCase();
  const type = TYPES.find((t) => t.exts.includes(ext));
  if (!type) throw badRequest('This file type is not allowed. Upload a PDF, JPG, PNG, WEBP, DOCX or XLSX file.', 'FILE_TYPE');
  if (!type.test(buffer)) throw badRequest(`The file content does not match its extension (${ext}). The upload was rejected.`, 'FILE_TYPE');
  return type.mime;
}

async function assertEntity(orgId: string, entityType: string, entityId: string): Promise<void> {
  const ok = await (async () => {
    switch (entityType) {
      case 'Tenant': return prisma.tenant.count({ where: { id: entityId, orgId } });
      case 'Contract': return prisma.contract.count({ where: { id: entityId, orgId } });
      case 'Payment': return prisma.payment.count({ where: { id: entityId, orgId } });
      case 'Expense': return prisma.expense.count({ where: { id: entityId, orgId } });
      case 'MaintenanceRequest': return prisma.maintenanceRequest.count({ where: { id: entityId, orgId } });
      case 'Room': return prisma.room.count({ where: { id: entityId, building: { orgId } } });
      case 'Building': return prisma.building.count({ where: { id: entityId, orgId } });
      default: return 0;
    }
  })();
  if (!ok) throw notFound('The record this document belongs to');
}

function assertAccess(actor: Actor, entityType: string): void {
  const permission = ENTITY_ACCESS[entityType];
  if (!permission) throw badRequest('Documents cannot be attached to this kind of record.');
  if (!can(actor, permission)) throw forbidden('You do not have access to documents of this record.');
}

export async function uploadDocument(actor: Actor, input: { entityType: string; entityId: string; category: string; fileName: string; buffer: Buffer }) {
  assertAccess(actor, input.entityType);
  await assertEntity(actor.orgId, input.entityType, input.entityId);
  if (!input.buffer.length) throw badRequest('The file is empty.', 'FILE_EMPTY');
  const mimeType = detectFileType(input.fileName, input.buffer);
  // The stored name is random: the client-supplied name is kept only as metadata and never used as a path.
  const storedName = `${randomBytes(16).toString('hex')}${extname(input.fileName).toLowerCase()}`;
  const safeName = input.fileName.replace(/[^\w.\- ()]/g, '_').slice(0, 200);
  await mkdir(STORAGE_ROOT, { recursive: true });
  await writeFile(join(STORAGE_ROOT, storedName), input.buffer, { flag: 'wx', mode: 0o600 });
  return inTransaction(async (tx) => {
    const previous = await tx.document.findFirst({ where: { orgId: actor.orgId, entityType: input.entityType, entityId: input.entityId, category: input.category, fileName: safeName }, orderBy: { version: 'desc' } });
    const doc = await tx.document.create({
      data: {
        orgId: actor.orgId, entityType: input.entityType, entityId: input.entityId, category: input.category, fileName: safeName, storedName, mimeType,
        sizeBytes: input.buffer.length, sha256: createHash('sha256').update(input.buffer).digest('hex'), version: (previous?.version ?? 0) + 1, uploadedById: actor.userId,
      },
    });
    await audit(tx, actor, { action: 'DOCUMENT_UPLOADED', entityType: input.entityType, entityId: input.entityId, summary: `Document "${safeName}" (${input.category}) uploaded, version ${doc.version}`, newValue: { documentId: doc.id, fileName: safeName, sizeBytes: doc.sizeBytes } });
    return doc;
  });
}

export async function listDocuments(actor: Actor, entityType: string, entityId: string) {
  assertAccess(actor, entityType);
  await assertEntity(actor.orgId, entityType, entityId);
  return prisma.document.findMany({
    where: { orgId: actor.orgId, entityType, entityId, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, category: true, fileName: true, mimeType: true, sizeBytes: true, version: true, createdAt: true, uploadedBy: { select: { fullName: true } } },
  });
}

/** Returns a stream for an authorised download. Files are never reachable by URL without this check. */
export async function openDocument(actor: Actor, id: string) {
  const doc = await prisma.document.findFirst({ where: { id, orgId: actor.orgId, archivedAt: null } });
  if (!doc) throw notFound('Document');
  assertAccess(actor, doc.entityType);
  const path = join(STORAGE_ROOT, doc.storedName);
  if (!path.startsWith(STORAGE_ROOT)) throw notFound('Document');
  const info = await stat(path).catch(() => null);
  if (!info) throw notFound('The stored file for this document');
  return { doc, stream: createReadStream(path), size: info.size };
}

export async function archiveDocument(actor: Actor, id: string) {
  return inTransaction(async (tx) => {
    const doc = await tx.document.findFirst({ where: { id, orgId: actor.orgId, archivedAt: null } });
    if (!doc) throw notFound('Document');
    assertAccess(actor, doc.entityType);
    await tx.document.update({ where: { id }, data: { archivedAt: new Date() } });
    await audit(tx, actor, { action: 'DOCUMENT_ARCHIVED', entityType: doc.entityType, entityId: doc.entityId, summary: `Document "${doc.fileName}" archived (file retained)` });
  });
}
