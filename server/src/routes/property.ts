import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { badRequest, forbidden } from '../errors.js';
import { actorOf, can } from '../http/context.js';
import { requirePermission, requireAuth } from '../http/middleware.js';
import { paged, zDate, zEmail, zId, zMoney, zOptionalDate, zOptionalId, zOptionalMoney, zPage, zPhone, zPositiveMoney, zRequiredText, zText, zTextNullable } from '../http/validation.js';
import * as contracts from '../services/contracts.js';
import * as deletion from '../services/deletion.js';
import { contractDocument, isContractTemplate, listContractTemplates } from '../services/contractDocument.js';
import * as documents from '../services/documents.js';
import * as importer from '../services/importer.js';
import * as maintenance from '../services/maintenance.js';
import * as property from '../services/property.js';
import * as tenants from '../services/tenants.js';
import { idNumberProblem, normalizeIdNumber, normalizeTin, tinProblem } from '../lib/identity.js';

export const propertyRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
const zBool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

// ───────────── Buildings & floors ─────────────

const zBuilding = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, 'Use letters, digits or hyphens (max 20).'), name: zRequiredText(120, 'Building name'), address: zTextNullable(255), description: zTextNullable(2000),
  companyName: zTextNullable(160), tin: zTextNullable(40), phone: zTextNullable(40), email: zTextNullable(160), managerName: zTextNullable(160),
  bankName: zTextNullable(120), bankAccount: zTextNullable(60), upi: zTextNullable(60), district: zTextNullable(80), sector: zTextNullable(80), cell: zTextNullable(80), village: zTextNullable(80),
  contractTemplate: zTextNullable(120).refine(async (f) => !f || (await isContractTemplate(f)), 'Choose one of the contract files available on the server.') });

propertyRouter.get('/buildings', requirePermission('building.view'), async (req, res) => {
  res.json({ items: await property.listBuildings(actorOf(req).orgId) });
});
propertyRouter.post('/buildings', requirePermission('building.manage'), async (req, res) => {
  res.status(201).json(await property.createBuilding(actorOf(req), await zBuilding.parseAsync(req.body)));
});
propertyRouter.patch('/buildings/:id', requirePermission('building.manage'), async (req, res) => {
  const body = await zBuilding.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).parseAsync(req.body);
  res.json(await property.updateBuilding(actorOf(req), zId.parse(req.params.id), body));
});

const zFloor = z.object({ buildingId: zId, name: zRequiredText(80, 'Floor name'), level: z.coerce.number().int().min(-20).max(200) });

propertyRouter.delete('/buildings/:id', requirePermission('data.delete'), async (req, res) => {
  await deletion.deleteBuilding(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});

propertyRouter.get('/floors', requirePermission('building.view'), async (req, res) => {
  const q = z.object({ buildingId: zOptionalId }).parse(req.query);
  res.json({ items: await property.listFloors(actorOf(req).orgId, q.buildingId) });
});
propertyRouter.post('/floors', requirePermission('building.manage'), async (req, res) => {
  res.status(201).json(await property.createFloor(actorOf(req), zFloor.parse(req.body)));
});
propertyRouter.patch('/floors/:id', requirePermission('building.manage'), async (req, res) => {
  res.json(await property.updateFloor(actorOf(req), zId.parse(req.params.id), zFloor.omit({ buildingId: true }).partial().parse(req.body)));
});
propertyRouter.delete('/floors/:id', requirePermission('data.delete'), async (req, res) => {
  await deletion.deleteFloor(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});

// ───────────── Rooms ─────────────

propertyRouter.get('/rooms', requirePermission('room.view'), async (req, res) => {
  const q = zPage.extend({ buildingId: zOptionalId, floorId: zOptionalId, status: z.enum(['VACANT', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']).optional().or(z.literal('').transform(() => undefined)), available: zBool }).parse(req.query);
  const r = await property.listRooms(actorOf(req).orgId, q);
  res.json(paged(r.items, r.total, q));
});
propertyRouter.get('/rooms/map', requirePermission('room.view'), async (req, res) => {
  const q = z.object({ buildingId: zOptionalId }).parse(req.query);
  res.json({ buildings: await property.roomMap(actorOf(req).orgId, q.buildingId) });
});
propertyRouter.post('/rooms', requirePermission('room.manage'), async (req, res) => {
  const body = z.object({
    buildingId: zId, floorId: zId, number: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,29}$/, 'Enter a room number such as 101 or B1-015.'), roomType: zText(40),
    monthlyRent: zPositiveMoney, depositRequired: zOptionalMoney, description: zTextNullable(2000), areaSqm: zOptionalMoney,
  }).parse(req.body);
  res.status(201).json(await property.createRoom(actorOf(req), body));
});
propertyRouter.get('/rooms/:id', requirePermission('room.view'), async (req, res) => {
  res.json(await property.roomDetail(actorOf(req).orgId, zId.parse(req.params.id)));
});
propertyRouter.patch('/rooms/:id', requirePermission('room.manage'), async (req, res) => {
  const body = z.object({
    number: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,29}$/).optional(), roomType: zText(40), depositRequired: zOptionalMoney, description: zTextNullable(2000),
    areaSqm: z.preprocess((v) => (v === '' ? null : v), zMoney.nullable().optional()), status: z.enum(['VACANT', 'MAINTENANCE', 'INACTIVE']).optional(), floorId: zOptionalId,
  }).parse(req.body);
  res.json(await property.updateRoom(actorOf(req), zId.parse(req.params.id), body));
});
propertyRouter.delete('/rooms/:id', requirePermission('data.delete'), async (req, res) => {
  await deletion.deleteRoom(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});
// Changing rent is a separate, separately-authorised operation: it is never part of a plain room edit.
propertyRouter.post('/rooms/:id/rent', requirePermission('room.rent.manage'), async (req, res) => {
  const body = z.object({ amount: zPositiveMoney, effectiveFrom: zDate, reason: zRequiredText(255, 'Reason') }).parse(req.body);
  res.status(201).json(await property.changeRoomRent(actorOf(req), zId.parse(req.params.id), body));
});

propertyRouter.get('/reservations', requirePermission('room.view'), async (req, res) => {
  const q = z.object({ buildingId: zOptionalId, status: zText(20) }).parse(req.query);
  res.json({ items: await property.listReservations(actorOf(req).orgId, q) });
});
propertyRouter.post('/reservations', requirePermission('room.manage'), async (req, res) => {
  const body = z.object({ roomId: zId, tenantId: zOptionalId, prospectName: zRequiredText(160, 'Prospective tenant name'), prospectPhone: z.preprocess((v) => (v === '' ? undefined : v), zPhone.optional()), reservedOn: zDate, expiresOn: zDate, depositAmount: zOptionalMoney, notes: zText(2000) })
    .refine((b) => b.expiresOn >= b.reservedOn, { message: 'The expiry date must be on or after the reservation date.', path: ['expiresOn'] }).parse(req.body);
  res.status(201).json(await property.createReservation(actorOf(req), body));
});
propertyRouter.post('/reservations/:id/cancel', requirePermission('room.manage'), async (req, res) => {
  const actor = actorOf(req);
  res.json(await property.endReservation(actor, actor.orgId, zId.parse(req.params.id), 'CANCELLED'));
});

// ───────────── Tenants ─────────────

const zTenant = z.object({
  fullName: zRequiredText(160, 'Full name'), idType: z.enum(['NATIONAL_ID', 'PASSPORT', 'OTHER']).optional(),
  // Only the name is required: the rest can be added later. The contract prints a blank line for anything missing.
  idNumber: zTextNullable(40), phone: z.preprocess((v) => (v === '' ? null : v), zPhone.nullable().optional()),
  email: z.preprocess((v) => (v === '' ? null : v), zEmail.nullable().optional()), address: zTextNullable(255), businessName: zTextNullable(160),
  tin: zTextNullable(40), district: zTextNullable(80), sector: zTextNullable(80), cell: zTextNullable(80), village: zTextNullable(80),
  emergencyContactName: zTextNullable(160), emergencyContactPhone: z.preprocess((v) => (v === '' ? null : v), zPhone.nullable().optional()), notes: zTextNullable(4000),
});

/** On registration the ID number format is checked together with the other fields, so every problem shows at once. */
const zNewTenant = zTenant.extend({
  // The room the tenant occupies from `startDate`, without a contract until one is given.
  roomId: zOptionalId, startDate: zOptionalDate,
}).superRefine((t, ctx) => {
  const problem = t.idNumber ? idNumberProblem(t.idType ?? 'NATIONAL_ID', t.idNumber) : null;
  if (problem) ctx.addIssue({ code: 'custom', path: ['idNumber'], message: problem });
  const tin = t.tin ? tinProblem(t.tin) : null;
  if (tin) ctx.addIssue({ code: 'custom', path: ['tin'], message: tin });
  if (t.roomId && !t.startDate) ctx.addIssue({ code: 'custom', path: ['startDate'], message: 'Enter the day the tenant moved in.' });
});

propertyRouter.get('/tenants', requirePermission('tenant.view'), async (req, res) => {
  const q = zPage.extend({ status: zText(20), buildingId: zOptionalId, floorId: zOptionalId, withArrears: zBool }).parse(req.query);
  if (q.status === 'ARCHIVED' && !can(actorOf(req), 'tenant.archive')) throw forbidden('You are not allowed to see archived tenants.');
  const r = await tenants.listTenants(actorOf(req).orgId, q, q, q.sort, q.dir);
  res.json(paged(r.items, r.total, q));
});
// Live check used by the registration form, so a duplicate or malformed number is caught at step 1.
propertyRouter.get('/tenants/check-id', requirePermission('tenant.view'), async (req, res) => {
  const q = z.object({ idType: z.enum(['NATIONAL_ID', 'PASSPORT', 'OTHER']).default('NATIONAL_ID'), idNumber: z.string().max(60).default(''), exceptId: zOptionalId }).parse(req.query);
  const problem = idNumberProblem(q.idType, q.idNumber);
  const existing = problem ? null : await tenants.findByIdNumber(actorOf(req).orgId, q.idNumber, q.exceptId);
  res.json({ normalized: normalizeIdNumber(q.idNumber), problem, existing });
});

propertyRouter.get('/tenants/check-tin', requirePermission('tenant.view'), async (req, res) => {
  const q = z.object({ tin: z.string().max(60).default(''), exceptId: zOptionalId }).parse(req.query);
  const problem = tinProblem(q.tin);
  const existing = problem ? null : await tenants.findByTin(actorOf(req).orgId, q.tin, q.exceptId);
  res.json({ normalized: normalizeTin(q.tin), problem, existing });
});

propertyRouter.post('/tenants', requirePermission('tenant.manage'), async (req, res) => {
  const { roomId, startDate, ...tenant } = zNewTenant.parse(req.body);
  res.status(201).json(await tenants.createTenant(actorOf(req), tenant, roomId && startDate ? { roomId, startDate } : undefined));
});
propertyRouter.get('/tenants/:id', requirePermission('tenant.view'), async (req, res) => {
  const id = zId.parse(req.params.id);
  await tenants.assertTenantVisible(actorOf(req), id);
  res.json(await tenants.tenantDetail(actorOf(req).orgId, id));
});
propertyRouter.post('/tenants/:id/archive', requirePermission('tenant.archive'), async (req, res) => {
  const body = z.object({ reason: zRequiredText(255, 'Reason') }).parse(req.body);
  res.json(await tenants.archiveTenant(actorOf(req), zId.parse(req.params.id), body.reason));
});
propertyRouter.post('/tenants/:id/restore', requirePermission('tenant.archive'), async (req, res) => {
  res.json(await tenants.restoreTenant(actorOf(req), zId.parse(req.params.id)));
});
propertyRouter.patch('/tenants/:id', requirePermission('tenant.manage'), async (req, res) => {
  res.json(await tenants.updateTenant(actorOf(req), zId.parse(req.params.id), zTenant.partial().parse(req.body)));
});
propertyRouter.delete('/tenants/:id', requirePermission('data.delete'), async (req, res) => {
  await deletion.deleteTenant(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});
propertyRouter.post('/tenants/:id/status', requirePermission('tenant.manage', 'tenant.blacklist'), async (req, res) => {
  const body = z.object({ status: z.enum(['INACTIVE', 'FORMER', 'BLACKLISTED']), reason: zText(255) }).parse(req.body);
  res.json(await tenants.setTenantStatus(actorOf(req), zId.parse(req.params.id), body.status, body.reason));
});

// ───────────── Contracts ─────────────

const zDueDay = z.coerce.number().int().min(1).max(31);
const zGrace = z.coerce.number().int().min(0).max(90);

propertyRouter.get('/contracts', requirePermission('contract.view'), async (req, res) => {
  const q = zPage.extend({ buildingId: zOptionalId, floorId: zOptionalId, roomId: zOptionalId, tenantId: zOptionalId, status: zText(20), expiringBefore: zOptionalDate }).parse(req.query);
  const r = await contracts.listContracts(actorOf(req).orgId, { ...q, includeArchived: Boolean(q.tenantId) && can(actorOf(req), 'tenant.archive') }, q);
  res.json(paged(r.items, r.total, q));
});
propertyRouter.post('/contracts', requirePermission('contract.manage'), async (req, res) => {
  const body = z.object({
    tenantId: zId, roomId: zId, startDate: zDate, endDate: zDate, monthlyRent: zOptionalMoney, rentOverrideReason: zText(255), depositAmount: zOptionalMoney,
    paymentDueDay: zDueDay.optional(), graceDays: zGrace.optional(), specialTerms: zText(8000), activate: z.boolean().default(true),
    // false = the tenant rents the room without a contract (the end date is then ignored).
    withLease: z.boolean().optional(),
  }).parse(req.body);
  res.status(201).json(await contracts.createContract(actorOf(req), body));
});
propertyRouter.get('/contracts/:id', requirePermission('contract.view'), async (req, res) => {
  const contract = await contracts.contractDetail(actorOf(req).orgId, zId.parse(req.params.id));
  await tenants.assertTenantVisible(actorOf(req), contract.tenantId);
  res.json(contract);
});
propertyRouter.patch('/contracts/:id', requirePermission('contract.manage'), async (req, res) => {
  const body = z.object({ paymentDueDay: zDueDay.optional(), graceDays: zGrace.optional(), specialTerms: zTextNullable(8000), startDate: zOptionalDate, endDate: zOptionalDate, depositAmount: zOptionalMoney }).parse(req.body);
  res.json(await contracts.updateContract(actorOf(req), zId.parse(req.params.id), body));
});
propertyRouter.delete('/contracts/:id', requirePermission('contract.manage'), async (req, res) => {
  await contracts.deleteDraftContract(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});
// The lease contract files a building can use (Buildings → Edit → Lease contract).
propertyRouter.get('/contract-templates', requirePermission('building.view'), async (_req, res) => {
  res.json({ items: await listContractTemplates() });
});
propertyRouter.get('/contracts/:id/document', requirePermission('contract.view'), async (req, res) => {
  const format = z.enum(['docx', 'pdf']).parse(req.query.format ?? 'pdf');
  const doc = await contractDocument(actorOf(req), zId.parse(req.params.id), format);
  res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName}"`);
  res.send(doc.buffer);
});
propertyRouter.post('/contracts/:id/activate', requirePermission('contract.manage'), async (req, res) => {
  res.json(await contracts.activateContract(actorOf(req), zId.parse(req.params.id)));
});
propertyRouter.post('/contracts/:id/terminate', requirePermission('contract.terminate'), async (req, res) => {
  const body = z.object({
    moveOutDate: zDate, reason: zRequiredText(255, 'Reason'), roomCondition: zText(2000), needsMaintenance: z.boolean().optional(), maintenanceNote: zText(2000),
    depositDeduction: zOptionalMoney, deductionReason: zText(255),
  }).parse(req.body);
  res.json(await contracts.terminateContract(actorOf(req), zId.parse(req.params.id), body));
});
propertyRouter.post('/contracts/:id/renew', requirePermission('contract.manage'), async (req, res) => {
  const body = z.object({ endDate: zDate, monthlyRent: zOptionalMoney, rentChangeReason: zText(255), paymentDueDay: zDueDay.optional(), graceDays: zGrace.optional(), specialTerms: zText(8000) }).parse(req.body);
  res.status(201).json(await contracts.renewContract(actorOf(req), zId.parse(req.params.id), body));
});
propertyRouter.post('/contracts/:id/dates', requirePermission('contract.manage'), async (req, res) => {
  const body = z.object({ startDate: zDate, endDate: zDate, reason: zRequiredText(255, 'Reason') }).parse(req.body);
  res.json(await contracts.correctContractDates(actorOf(req), zId.parse(req.params.id), body));
});
propertyRouter.post('/contracts/:id/give', requirePermission('contract.manage'), async (req, res) => {
  const body = z.object({ startDate: zDate, endDate: zDate }).parse(req.body);
  res.json(await contracts.giveContract(actorOf(req), zId.parse(req.params.id), body));
});
propertyRouter.post('/contracts/:id/rent', requirePermission('room.rent.manage'), async (req, res) => {
  const body = z.object({ amount: zPositiveMoney, effectiveFrom: zDate, reason: zRequiredText(255, 'Reason') }).parse(req.body);
  res.json(await contracts.changeContractRent(actorOf(req), zId.parse(req.params.id), body));
});

// ───────────── Maintenance ─────────────

const zPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

propertyRouter.get('/maintenance', requirePermission('maintenance.view'), async (req, res) => {
  const q = zPage.extend({ buildingId: zOptionalId, floorId: zOptionalId, roomId: zOptionalId, status: zText(20), priority: zText(20), from: zOptionalDate, to: zOptionalDate }).parse(req.query);
  const r = await maintenance.listMaintenance(actorOf(req).orgId, q, q);
  res.json(paged(r.items, r.total, q));
});
propertyRouter.post('/maintenance', requirePermission('maintenance.manage'), async (req, res) => {
  const body = z.object({
    buildingId: zId, floorId: zOptionalId, roomId: zOptionalId, title: zRequiredText(160, 'Issue'), description: zText(4000), priority: zPriority.optional(),
    estimatedCost: zOptionalMoney, supplier: zText(160), assignedToId: zOptionalId, markRoomUnderMaintenance: z.boolean().optional(),
  }).parse(req.body);
  res.status(201).json(await maintenance.createMaintenance(actorOf(req), body));
});
propertyRouter.get('/maintenance/:id', requirePermission('maintenance.view'), async (req, res) => {
  res.json(await maintenance.maintenanceDetail(actorOf(req).orgId, zId.parse(req.params.id)));
});
propertyRouter.patch('/maintenance/:id', requirePermission('maintenance.manage'), async (req, res) => {
  const nullableMoney = z.preprocess((v) => (v === '' ? null : v), zMoney.nullable().optional());
  const body = z.object({
    title: zRequiredText(160).optional(), description: zTextNullable(4000), priority: zPriority.optional(), status: z.enum(['REPORTED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
    assignedToId: z.preprocess((v) => (v === '' ? null : v), zId.nullable().optional()), estimatedCost: nullableMoney, actualCost: nullableMoney, supplier: zTextNullable(160), returnRoomToService: z.boolean().optional(),
  }).parse(req.body);
  res.json(await maintenance.updateMaintenance(actorOf(req), zId.parse(req.params.id), body));
});

// ───────────── Documents ─────────────

propertyRouter.get('/documents', requireAuth, async (req, res) => {
  const q = z.object({ entityType: zRequiredText(40), entityId: zId }).parse(req.query);
  res.json({ items: await documents.listDocuments(actorOf(req), q.entityType, q.entityId) });
});
propertyRouter.post('/documents', requirePermission('document.upload'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload.', 'FILE_MISSING');
  const body = z.object({ entityType: zRequiredText(40), entityId: zId, category: z.enum(documents.DOCUMENT_CATEGORIES) }).parse(req.body);
  res.status(201).json(await documents.uploadDocument(actorOf(req), { ...body, fileName: req.file.originalname, buffer: req.file.buffer }));
});
propertyRouter.get('/documents/:id/download', requirePermission('document.view'), async (req, res) => {
  const { doc, stream, size } = await documents.openDocument(actorOf(req), zId.parse(req.params.id));
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Length', String(size));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
  stream.pipe(res);
});
propertyRouter.delete('/documents/:id', requirePermission('document.upload'), async (req, res) => {
  await documents.archiveDocument(actorOf(req), zId.parse(req.params.id));
  res.json({ ok: true });
});

// ───────────── Import ─────────────

propertyRouter.get('/import/template', requirePermission('import.data'), async (_req, res) => {
  const buffer = await importer.importTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="rental-import-template.xlsx"');
  res.send(buffer);
});
propertyRouter.post('/import/preview', requirePermission('import.data'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to import.', 'FILE_MISSING');
  const body = z.object({ sheet: zText(20) }).parse(req.body);
  res.json(await importer.previewImport(actorOf(req), { fileName: req.file.originalname, buffer: req.file.buffer, csvSheet: body.sheet }));
});
propertyRouter.post('/import/commit', requirePermission('import.data'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to import.', 'FILE_MISSING');
  const body = z.object({ sheet: zText(20), confirm: z.literal('yes', { error: 'Confirm the import after reviewing the preview.' }) }).parse(req.body);
  res.status(201).json(await importer.commitImport(actorOf(req), { fileName: req.file.originalname, buffer: req.file.buffer, csvSheet: body.sheet }));
});
