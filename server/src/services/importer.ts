import ExcelJS from 'exceljs';
import { inTransaction, prisma } from '../db.js';
import { badRequest } from '../errors.js';
import type { Actor } from '../http/context.js';
import { addMonths, businessDate, isoDate, parseDate, startOfMonth } from '../lib/dates.js';
import { Decimal, type Money } from '../lib/money.js';
import { audit } from './audit.js';
import { deriveStatus, dueDatesFor } from './charges.js';
import { createContractTx } from './contracts.js';
import { parsePhone } from '../lib/phone.js';
import { idNumberProblem, normalizeIdNumber, type IdType } from '../lib/identity.js';
import { getOrg } from './org.js';

/**
 * Controlled import of existing records. Two steps, both run the same validation:
 *   preview → nothing is written; every row is shown with its problems
 *   commit  → refused if any row has an error; otherwise everything is written in ONE transaction
 */

export const IMPORT_SHEETS = {
  Buildings: ['code', 'name', 'address'],
  Floors: ['buildingCode', 'name', 'level'],
  Rooms: ['buildingCode', 'floorName', 'roomNumber', 'roomType', 'monthlyRent', 'depositRequired', 'description'],
  Tenants: ['fullName', 'idType', 'idNumber', 'phone', 'email', 'businessName', 'address'],
  Contracts: ['tenantIdNumber', 'buildingCode', 'roomNumber', 'startDate', 'endDate', 'monthlyRent', 'depositAmount', 'paymentDueDay', 'billFrom', 'openingBalance'],
} as const;

export type SheetName = keyof typeof IMPORT_SHEETS;
const SHEET_NAMES = Object.keys(IMPORT_SHEETS) as SheetName[];

/** Narrower imports offered on their own pages: Rooms brings in floors and rooms, Tenants brings in tenants. */
export const IMPORT_SCOPES = { rooms: ['Floors', 'Rooms'], tenants: ['Tenants'] } as const satisfies Record<string, readonly SheetName[]>;
export type ImportScope = keyof typeof IMPORT_SCOPES;
const sheetsFor = (scope?: ImportScope): readonly SheetName[] => (scope ? IMPORT_SCOPES[scope] : SHEET_NAMES);
/**
 * The page imports ask for the minimum; the rest is filled in on each record's page.
 * A rooms import is for one building, chosen on screen, so it has no buildingCode column (room type defaults to Shop, deposit to 0).
 * A tenants import needs only the name; ID, phone and the rest are added when editing the tenant.
 */
const SCOPE_SHEETS: Record<ImportScope, Partial<Record<SheetName, readonly string[]>>> = {
  rooms: { Floors: ['name', 'level'], Rooms: ['floorName', 'roomNumber', 'monthlyRent'] },
  tenants: { Tenants: ['fullName'] },
};
const columnsFor = (name: SheetName, scope?: ImportScope): readonly string[] => (scope && SCOPE_SHEETS[scope][name]) || IMPORT_SHEETS[name];
type ImportBuilding = { id: string; code: string; name: string };

async function buildingFor(actor: Actor, scope: ImportScope | undefined, buildingId: string | undefined): Promise<ImportBuilding | undefined> {
  if (scope !== 'rooms') return undefined;
  if (!buildingId) throw badRequest('Choose the building the rooms belong to.', 'IMPORT_BUILDING');
  const building = await prisma.building.findFirst({ where: { id: buildingId, orgId: actor.orgId, status: 'ACTIVE' } });
  if (!building) throw badRequest('That building does not exist or is not active.', 'IMPORT_BUILDING');
  return building;
}

const WHERE: Record<ImportScope | 'all', string> = { all: 'under Settings → Import data', rooms: 'with the Import button on the Rooms page', tenants: 'with the Import button on the Tenants page' };

const HELP: Record<SheetName, string> = {
  Buildings: 'code: short unique code (e.g. UBM). name: building name.',
  Floors: 'buildingCode: code from Buildings. level: number for ordering (-1 basement, 0 ground, 1 first floor …).',
  Rooms: 'monthlyRent and depositRequired in RWF, digits only. roomNumber must be unique within the building.',
  Tenants: 'idType: NATIONAL_ID (default) or PASSPORT. idNumber: 16-digit Rwandan national ID, or passport number; one number = one tenant. phone: required; Rwandan numbers like 0788123456, others with + and the country code.',
  Contracts: 'Dates as YYYY-MM-DD. monthlyRent blank = use the room rent. billFrom: first month this system should bill (blank = current month); earlier months are assumed settled in your old records. openingBalance: unpaid rent carried over from before billFrom (blank = 0).',
};

export interface ImportRow {
  rowNumber: number;
  data: Record<string, string>;
  errors: string[];
  /** create = will be imported; skip = already exists and will be left untouched. */
  action: 'create' | 'skip';
  note?: string;
}

export interface ImportPreview {
  sheets: Array<{ name: SheetName; rows: ImportRow[]; toCreate: number; toSkip: number; errors: number }>;
  totalErrors: number;
  totalToCreate: number;
  canCommit: boolean;
}

/** Rows in each sheet that get dropdowns. */
const LIST_ROWS = 500;

export async function importTemplate(actor: Actor, scope?: ImportScope, buildingId?: string): Promise<{ buffer: Buffer; fileName: string }> {
  const sheets = sheetsFor(scope);
  const only = await buildingFor(actor, scope, buildingId);
  const [buildings, floors] = await Promise.all([
    prisma.building.findMany({ where: { orgId: actor.orgId, status: 'ACTIVE', ...(only && { id: only.id }) }, orderBy: { code: 'asc' } }),
    prisma.floor.findMany({ where: { building: { orgId: actor.orgId, status: 'ACTIVE' }, ...(only && { buildingId: only.id }) }, include: { building: true }, orderBy: [{ building: { code: 'asc' } }, { level: 'asc' }] }),
  ]);
  const columns = (name: SheetName) => columnsFor(name, scope);
  const wb = new ExcelJS.Workbook();
  const guide = wb.addWorksheet('Instructions');
  guide.columns = [{ width: 16 }, { width: 110 }];
  guide.addRow([only ? `Rooms for ${only.name}` : 'How to use this template']).font = { bold: true, size: 13 };
  if (only) guide.addRow(['', `Every room in this file is added to ${only.name} (${only.code}). For another building, download its own template.`]);
  guide.addRow(['', 'Fill in the sheets you need, in any combination. Keep the header row exactly as it is. Do not rename the sheets.']);
  guide.addRow(['', `Upload the file ${WHERE[scope ?? 'all']}. You will see a preview with every problem listed; nothing is saved until you confirm, and nothing is saved at all if any row has an error.`]);
  guide.addRow(['', 'Rows that already exist in the system (same building code, floor, room number or tenant ID number) are skipped, never overwritten.']);
  guide.addRow([]);
  if (only) {
    guide.addRow(['Rooms', 'floorName: pick from the list. monthlyRent in RWF, digits only. roomNumber must be unique within the building. Room type is set to Shop; change it on the room page if needed.']);
    guide.addRow(['Floors', `Only for a floor ${only.name} does not have yet; leave empty otherwise. level: number for ordering (-1 basement, 0 ground, 1 first floor …).`]);
    guide.addRow(['Floors now', floors.map((f) => f.name).join(', ') || 'none yet — add them on the Floors sheet']);
  } else if (scope === 'tenants') {
    guide.addRow(['Tenants', 'One full name per row. Add the phone, ID number and other details afterwards on each tenant’s page (Edit). A name that is already registered is skipped.']);
  } else for (const name of sheets) guide.addRow([name, HELP[name]]);
  if (!only && buildings.length && sheets.some((n) => (IMPORT_SHEETS[n] as readonly string[]).includes('buildingCode'))) {
    guide.addRow([]);
    guide.addRow(['Buildings', buildings.map((b) => `${b.code} = ${b.name}`).join('     ')]);
    if (sheets.includes('Rooms')) guide.addRow(['Floors', buildings.map((b) => `${b.code}: ${floors.filter((f) => f.buildingId === b.id).map((f) => f.name).join(', ') || 'none yet'}`).join('     ')]);
  }

  const floorNames = [...new Set(floors.map((f) => f.name))];
  const choice = (col: string, count: number, error: string, strict = true): ExcelJS.DataValidation => ({
    type: 'list', allowBlank: true, formulae: [`Lists!$${col}$2:$${col}$${count + 1}`], showErrorMessage: true, errorStyle: strict ? 'stop' : 'warning', error,
  });
  const validations: Record<string, ExcelJS.DataValidation | null> = {
    buildingCode: buildings.length ? choice('A', buildings.length, 'Choose a building code from the list.') : null,
    // Not strict: a floor added on the Floors sheet of the same file is not in the list yet.
    floorName: floorNames.length ? choice('B', floorNames.length, 'This floor does not exist yet. Add it on the Floors sheet, or pick one from the list.', false) : null,
    idType: choice('C', 3, 'Choose NATIONAL_ID, PASSPORT or OTHER.'),
  };

  for (const name of sheets) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns(name).map((h) => ({ header: h, key: h, width: Math.max(h.length + 6, 18) }));
    ws.getRow(1).font = { bold: true };
    columns(name).forEach((h, i) => {
      const rule = validations[h];
      if (!rule) return;
      for (let r = 2; r <= LIST_ROWS + 1; r += 1) ws.getCell(r, i + 1).dataValidation = rule;
    });
  }
  // Dropdown values live on a hidden sheet; the importer only reads the sheets it knows.
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  lists.getColumn(1).values = ['buildingCode', ...buildings.map((b) => b.code)];
  lists.getColumn(2).values = ['floorName', ...floorNames];
  lists.getColumn(3).values = ['idType', 'NATIONAL_ID', 'PASSPORT', 'OTHER'];
  const fileName = only ? `rooms-import-${only.code}.xlsx` : `${scope ? `${scope}-import-template` : 'rental-import-template'}.xlsx`;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return isoDate(new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())));
  if (typeof value === 'object') {
    const v = value as { text?: string; result?: ExcelJS.CellValue; richText?: Array<{ text: string }> };
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return String(v.text).trim();
    return '';
  }
  return String(value).trim();
}

/** Removes the byte-order mark Excel puts at the start of CSV files. */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

type Raw = Partial<Record<SheetName, Array<{ rowNumber: number; data: Record<string, string> }>>>;

function tabulate(name: SheetName, grid: string[][], scope?: ImportScope, building?: ImportBuilding): Raw[SheetName] {
  const expected = columnsFor(name, scope);
  const header = (grid[0] ?? []).map((h) => h.trim());
  // idType was added later and is optional, so older files still import (it then defaults to NATIONAL_ID).
  const missing = expected.filter((h) => h !== 'idType' && !header.includes(h));
  if (missing.length) throw badRequest(`Sheet "${name}" is missing the column(s): ${missing.join(', ')}. Download the template and keep its header row.`, 'IMPORT_FORMAT');
  return grid.slice(1).map((cells, i) => ({
    rowNumber: i + 2,
    data: { ...(building && { buildingCode: building.code }), ...Object.fromEntries(expected.map((h) => [h, (cells[header.indexOf(h)] ?? '').trim()])) },
  }));
}

async function readFile(fileName: string, buffer: Buffer, csvSheet?: string, scope?: ImportScope, building?: ImportBuilding): Promise<Raw> {
  const raw: Raw = {};
  const sheets = sheetsFor(scope);
  if (/\.csv$/i.test(fileName)) {
    if (!csvSheet || !sheets.includes(csvSheet as SheetName)) throw badRequest(`For a CSV file, choose what it contains (${sheets.join(', ')}).`, 'IMPORT_FORMAT');
    raw[csvSheet as SheetName] = tabulate(csvSheet as SheetName, parseCsv(stripBom(buffer.toString('utf8'))), scope, building);
    return raw;
  }
  if (!/\.xlsx$/i.test(fileName) || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw badRequest('Upload an Excel (.xlsx) or CSV (.csv) file based on the template.', 'IMPORT_FORMAT');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw badRequest('The Excel file could not be read. Save it again as .xlsx and retry.', 'IMPORT_FORMAT');
  }
  for (const name of sheets) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    const grid: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c += 1) cells.push(cellText(row.getCell(c).value));
      grid.push(cells);
    });
    const body = grid.filter((r, i) => i === 0 || r.some((c) => c !== ''));
    if (body.length > 1) raw[name] = tabulate(name, body, scope, building);
  }
  if (!Object.keys(raw).length) throw badRequest(`The file contains no data rows in the ${sheets.join(' or ')} sheet${sheets.length > 1 ? 's' : ''}.`, 'IMPORT_EMPTY');
  return raw;
}

const upper = (s: string) => s.trim().toUpperCase();
const lower = (s: string) => s.trim().toLowerCase();

function amount(text: string, required: boolean, errors: string[], field: string): Money | null {
  const cleaned = text.replace(/[,\s]/g, '');
  if (!cleaned) {
    if (required) errors.push(`${field} is required.`);
    return null;
  }
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) {
    errors.push(`${field} "${text}" is not a valid amount.`);
    return null;
  }
  return new Decimal(cleaned);
}

function date(text: string, required: boolean, errors: string[], field: string): Date | null {
  if (!text) {
    if (required) errors.push(`${field} is required.`);
    return null;
  }
  try {
    return parseDate(text.slice(0, 10));
  } catch {
    errors.push(`${field} "${text}" is not a valid date (use YYYY-MM-DD).`);
    return null;
  }
}

interface Plan {
  preview: ImportPreview;
  buildings: Array<{ code: string; name: string; address: string }>;
  floors: Array<{ buildingCode: string; name: string; level: number }>;
  rooms: Array<{ buildingCode: string; floorName: string; number: string; roomType: string; monthlyRent: Money; depositRequired: Money; description: string }>;
  tenants: Array<{ fullName: string; idType: IdType; idNumber: string; phone: string; email: string; businessName: string; address: string }>;
  contracts: Array<{ tenantIdNumber: string; buildingCode: string; roomNumber: string; startDate: Date; endDate: Date; monthlyRent: Money | null; depositAmount: Money | null; paymentDueDay: number | null; billFrom: Date; openingBalance: Money }>;
}

async function plan(actor: Actor, raw: Raw, scope?: ImportScope): Promise<Plan> {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const [dbBuildings, dbFloors, dbRooms, dbTenants] = await Promise.all([
    prisma.building.findMany({ where: { orgId: actor.orgId } }),
    prisma.floor.findMany({ where: { building: { orgId: actor.orgId } }, include: { building: true } }),
    prisma.room.findMany({ where: { building: { orgId: actor.orgId } }, include: { building: true } }),
    prisma.tenant.findMany({ where: { orgId: actor.orgId }, select: { fullName: true, idNumber: true, status: true } }),
  ]);
  const out: Plan = { preview: { sheets: [], totalErrors: 0, totalToCreate: 0, canCommit: false }, buildings: [], floors: [], rooms: [], tenants: [], contracts: [] };
  const sheet = (name: SheetName, rows: ImportRow[]) => out.preview.sheets.push({ name, rows, toCreate: rows.filter((r) => r.action === 'create' && !r.errors.length).length, toSkip: rows.filter((r) => r.action === 'skip').length, errors: rows.filter((r) => r.errors.length).length });

  // Known keys = already in the database + accepted rows earlier in this file.
  const buildingCodes = new Set(dbBuildings.map((b) => upper(b.code)));
  const buildingNames = new Set(dbBuildings.map((b) => lower(b.name)));
  const floorKeys = new Set(dbFloors.map((f) => `${upper(f.building.code)}|${lower(f.name)}`));
  const floorLevels = new Set(dbFloors.map((f) => `${upper(f.building.code)}|${f.level}`));
  const roomKeys = new Map<string, 'db-vacant' | 'db-busy' | 'new'>(dbRooms.map((r) => [`${upper(r.building.code)}|${upper(r.number)}`, r.status === 'VACANT' ? 'db-vacant' : 'db-busy']));
  const tenantIds = new Map<string, string>(dbTenants.filter((t) => t.idNumber).map((t) => [normalizeIdNumber(t.idNumber!), t.status]));

  const rows = (name: SheetName) => raw[name] ?? [];

  if (raw.Buildings) {
    const seen = new Set<string>();
    sheet('Buildings', rows('Buildings').map(({ rowNumber, data }) => {
      const errors: string[] = [];
      const code = upper(data.code ?? '');
      if (!code) errors.push('code is required.');
      else if (!/^[A-Z0-9-]{1,20}$/.test(code)) errors.push('code may contain only letters, digits and hyphens (max 20).');
      if (!data.name) errors.push('name is required.');
      if (seen.has(code)) errors.push(`Building code ${code} appears more than once in this file.`);
      seen.add(code);
      if (buildingCodes.has(code)) return { rowNumber, data, errors, action: 'skip' as const, note: 'A building with this code already exists.' };
      if (data.name && buildingNames.has(lower(data.name))) errors.push(`A building named "${data.name}" already exists with a different code.`);
      if (!errors.length) {
        buildingCodes.add(code);
        buildingNames.add(lower(data.name!));
        out.buildings.push({ code, name: data.name!.trim(), address: data.address ?? '' });
      }
      return { rowNumber, data, errors, action: 'create' as const };
    }));
  }

  if (raw.Floors) {
    const seen = new Set<string>();
    sheet('Floors', rows('Floors').map(({ rowNumber, data }) => {
      const errors: string[] = [];
      const b = upper(data.buildingCode ?? '');
      const key = `${b}|${lower(data.name ?? '')}`;
      if (!b) errors.push('buildingCode is required.');
      else if (!buildingCodes.has(b)) errors.push(`Building ${b} does not exist and is not in the Buildings sheet.`);
      if (!data.name) errors.push('name is required.');
      const level = Number(data.level);
      if (data.level === '' || !Number.isInteger(level) || level < -20 || level > 200) errors.push('level must be a whole number (e.g. -1, 0, 1).');
      if (seen.has(key)) errors.push('This floor appears more than once in this file.');
      seen.add(key);
      if (floorKeys.has(key)) return { rowNumber, data, errors, action: 'skip' as const, note: 'This floor already exists.' };
      if (!errors.length && floorLevels.has(`${b}|${level}`)) errors.push(`Building ${b} already has a floor at level ${level}.`);
      if (!errors.length) {
        floorKeys.add(key);
        floorLevels.add(`${b}|${level}`);
        out.floors.push({ buildingCode: b, name: data.name!.trim(), level });
      }
      return { rowNumber, data, errors, action: 'create' as const };
    }));
  }

  if (raw.Rooms) {
    const seen = new Set<string>();
    sheet('Rooms', rows('Rooms').map(({ rowNumber, data }) => {
      const errors: string[] = [];
      const b = upper(data.buildingCode ?? '');
      const number = upper(data.roomNumber ?? '');
      const key = `${b}|${number}`;
      if (!b) errors.push('buildingCode is required.');
      else if (!buildingCodes.has(b)) errors.push(`Building ${b} does not exist and is not in the Buildings sheet.`);
      if (!data.floorName) errors.push('floorName is required.');
      else if (b && !floorKeys.has(`${b}|${lower(data.floorName)}`)) errors.push(`Floor "${data.floorName}" does not exist in building ${b} and is not in the Floors sheet.`);
      if (!number) errors.push('roomNumber is required.');
      const rent = amount(data.monthlyRent ?? '', true, errors, 'monthlyRent');
      const deposit = amount(data.depositRequired ?? '', false, errors, 'depositRequired');
      if (seen.has(key)) errors.push(`Room ${number} appears more than once for building ${b} in this file.`);
      seen.add(key);
      if (roomKeys.has(key)) return { rowNumber, data, errors, action: 'skip' as const, note: 'This room already exists (its rent is not changed by an import).' };
      if (!errors.length) {
        roomKeys.set(key, 'new');
        out.rooms.push({ buildingCode: b, floorName: data.floorName!.trim(), number, roomType: data.roomType || 'Shop', monthlyRent: rent!, depositRequired: deposit ?? new Decimal(0), description: data.description ?? '' });
      }
      return { rowNumber, data, errors, action: 'create' as const };
    }));
  }

  if (raw.Tenants && scope === 'tenants') {
    // Name only: without an ID number the name is what tells a new tenant from one already registered.
    const nameKey = (name: string) => lower(name).replace(/\s+/g, ' ');
    const registered = new Set(dbTenants.map((t) => nameKey(t.fullName)));
    const seen = new Set<string>();
    sheet('Tenants', rows('Tenants').map(({ rowNumber, data }) => {
      const errors: string[] = [];
      const key = nameKey(data.fullName ?? '');
      if (!key) errors.push('fullName is required.');
      else if (seen.has(key)) errors.push(`"${data.fullName}" appears more than once in this file.`);
      seen.add(key);
      if (key && registered.has(key)) return { rowNumber, data, errors, action: 'skip' as const, note: 'A tenant with this name is already registered.' };
      if (!errors.length) {
        out.tenants.push({ fullName: data.fullName!.trim().replace(/\s+/g, ' '), idType: 'NATIONAL_ID', idNumber: '', phone: '', email: '', businessName: '', address: '' });
      }
      return { rowNumber, data, errors, action: 'create' as const };
    }));
  } else if (raw.Tenants) {
    const seen = new Set<string>();
    sheet('Tenants', rows('Tenants').map(({ rowNumber, data }) => {
      const errors: string[] = [];
      const id = normalizeIdNumber(data.idNumber ?? '');
      const idType = (upper(data.idType ?? '') || 'NATIONAL_ID') as IdType;
      if (!data.fullName) errors.push('fullName is required.');
      if (!['NATIONAL_ID', 'PASSPORT', 'OTHER'].includes(idType)) errors.push('idType must be NATIONAL_ID, PASSPORT or OTHER.');
      else { const problem = idNumberProblem(idType, data.idNumber ?? ''); if (problem) errors.push(`idNumber: ${problem}`); }
      const phone = parsePhone(data.phone ?? '');
      if (!data.phone) errors.push('phone is required.');
      else if (!phone.e164) errors.push(`phone "${data.phone}": ${phone.problem}`);
      if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push(`email "${data.email}" is not valid.`);
      if (seen.has(id)) errors.push(`ID number ${id} appears more than once in this file.`);
      seen.add(id);
      if (tenantIds.has(id)) return { rowNumber, data, errors, action: 'skip' as const, note: 'A tenant with this ID number is already registered.' };
      if (!errors.length) {
        tenantIds.set(id, 'INACTIVE');
        out.tenants.push({ fullName: data.fullName!.trim(), idType, idNumber: id, phone: phone.e164!, email: lower(data.email ?? ''), businessName: data.businessName ?? '', address: data.address ?? '' });
      }
      return { rowNumber, data, errors, action: 'create' as const };
    }));
  }

  if (raw.Contracts) {
    const taken = new Set<string>();
    sheet('Contracts', rows('Contracts').map(({ rowNumber, data }) => {
      const errors: string[] = [];
      const id = normalizeIdNumber(data.tenantIdNumber ?? '');
      const key = `${upper(data.buildingCode ?? '')}|${upper(data.roomNumber ?? '')}`;
      if (!id) errors.push('tenantIdNumber is required.');
      else if (!tenantIds.has(id)) errors.push(`Tenant with ID number ${id} does not exist and is not in the Tenants sheet.`);
      else if (tenantIds.get(id) === 'BLACKLISTED') errors.push('This tenant is blacklisted.');
      const state = roomKeys.get(key);
      if (!data.buildingCode || !data.roomNumber) errors.push('buildingCode and roomNumber are required.');
      else if (!state) errors.push(`Room ${upper(data.roomNumber)} does not exist in building ${upper(data.buildingCode)} and is not in the Rooms sheet.`);
      else if (state === 'db-busy') errors.push('This room is already occupied, reserved or out of service. An active contract may already exist for this room.');
      else if (taken.has(key)) errors.push('Another contract in this file already takes this room.');
      const startDate = date(data.startDate ?? '', true, errors, 'startDate');
      const endDate = date(data.endDate ?? '', true, errors, 'endDate');
      if (startDate && endDate && endDate < startDate) errors.push('endDate is before startDate.');
      if (endDate && endDate < today) errors.push('endDate is in the past; only current contracts can be imported.');
      const rent = amount(data.monthlyRent ?? '', false, errors, 'monthlyRent');
      const deposit = amount(data.depositAmount ?? '', false, errors, 'depositAmount');
      const opening = amount(data.openingBalance ?? '', false, errors, 'openingBalance') ?? new Decimal(0);
      const dueDay = data.paymentDueDay ? Number(data.paymentDueDay) : null;
      if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) errors.push('paymentDueDay must be between 1 and 31.');
      const billFromRaw = data.billFrom ? date(data.billFrom, false, errors, 'billFrom') : startOfMonth(today);
      const billFrom = billFromRaw ? startOfMonth(billFromRaw) : startOfMonth(today);
      if (startDate && billFrom > startOfMonth(today) && startDate <= today) errors.push('billFrom cannot be after the current month.');
      if (!errors.length) {
        taken.add(key);
        out.contracts.push({ tenantIdNumber: id, buildingCode: upper(data.buildingCode!), roomNumber: upper(data.roomNumber!), startDate: startDate!, endDate: endDate!, monthlyRent: rent, depositAmount: deposit, paymentDueDay: dueDay, billFrom, openingBalance: opening });
      }
      return { rowNumber, data, errors, action: 'create' as const };
    }));
  }

  out.preview.totalErrors = out.preview.sheets.reduce((a, s) => a + s.errors, 0);
  out.preview.totalToCreate = out.preview.sheets.reduce((a, s) => a + s.toCreate, 0);
  out.preview.canCommit = out.preview.totalErrors === 0 && out.preview.totalToCreate > 0;
  return out;
}

interface ImportFile { fileName: string; buffer: Buffer; csvSheet?: string; scope?: ImportScope; buildingId?: string }

async function read(actor: Actor, file: ImportFile): Promise<Raw> {
  return readFile(file.fileName, file.buffer, file.csvSheet, file.scope, await buildingFor(actor, file.scope, file.buildingId));
}

export async function previewImport(actor: Actor, file: ImportFile): Promise<ImportPreview> {
  return (await plan(actor, await read(actor, file), file.scope)).preview;
}

export async function commitImport(actor: Actor, file: ImportFile) {
  const p = await plan(actor, await read(actor, file), file.scope);
  if (p.preview.totalErrors > 0) throw badRequest(`The file has ${p.preview.totalErrors} row(s) with errors. Nothing was imported. Fix the file and upload it again.`, 'IMPORT_HAS_ERRORS', p.preview);
  if (p.preview.totalToCreate === 0) throw badRequest('There is nothing new to import: every row already exists.', 'IMPORT_EMPTY');
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const counts = await inTransaction(async (tx) => {
    for (const b of p.buildings) await tx.building.create({ data: { orgId: actor.orgId, code: b.code, name: b.name, address: b.address || null } });
    const buildings = new Map((await tx.building.findMany({ where: { orgId: actor.orgId } })).map((b) => [b.code.toUpperCase(), b]));
    for (const f of p.floors) await tx.floor.create({ data: { buildingId: buildings.get(f.buildingCode)!.id, name: f.name, level: f.level } });
    const floors = new Map((await tx.floor.findMany({ where: { building: { orgId: actor.orgId } }, include: { building: true } })).map((f) => [`${f.building.code.toUpperCase()}|${f.name.toLowerCase()}`, f]));
    for (const r of p.rooms) {
      const floor = floors.get(`${r.buildingCode}|${r.floorName.toLowerCase()}`)!;
      const room = await tx.room.create({ data: { buildingId: floor.buildingId, floorId: floor.id, number: r.number, roomType: r.roomType, monthlyRent: r.monthlyRent, depositRequired: r.depositRequired, description: r.description || null } });
      await tx.roomRentRate.create({ data: { roomId: room.id, amount: r.monthlyRent, effectiveFrom: today, reason: 'Imported', createdById: actor.userId } });
    }
    for (const t of p.tenants) await tx.tenant.create({ data: { orgId: actor.orgId, fullName: t.fullName, idType: t.idType, idNumber: t.idNumber || null, phone: t.phone || null, email: t.email || null, businessName: t.businessName || null, address: t.address || null } });
    for (const c of p.contracts) {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { orgId: actor.orgId, idNumber: c.tenantIdNumber } });
      const room = await tx.room.findFirstOrThrow({ where: { buildingId: buildings.get(c.buildingCode)!.id, number: c.roomNumber } });
      const differs = c.monthlyRent && !c.monthlyRent.equals(room.monthlyRent);
      const contract = await createContractTx(tx, actor, {
        tenantId: tenant.id, roomId: room.id, startDate: c.startDate, endDate: c.endDate, monthlyRent: c.monthlyRent ?? undefined,
        rentOverrideReason: differs ? 'Contract rent carried over from previous records (import)' : undefined,
        depositAmount: c.depositAmount ?? undefined, paymentDueDay: c.paymentDueDay ?? undefined, activate: true, billingStart: c.billFrom,
      });
      if (c.openingBalance.greaterThan(0)) {
        // Arrears carried over from the previous records become one charge dated the month before billing starts.
        const period = addMonths(startOfMonth(c.billFrom > c.startDate ? c.billFrom : c.startDate), -1);
        const { dueDate, overdueFrom } = dueDatesFor(contract, period);
        await tx.rentCharge.create({
          data: {
            orgId: actor.orgId, contractId: contract.id, tenantId: tenant.id, roomId: room.id, floorId: room.floorId, buildingId: room.buildingId, period,
            baseAmount: c.openingBalance, amountDue: c.openingBalance, balance: c.openingBalance, dueDate, overdueFrom, note: 'Opening balance carried over at import',
            status: deriveStatus({ amountDue: c.openingBalance, amountPaid: new Decimal(0), amountWaived: new Decimal(0), overdueFrom }, today),
          },
        });
      }
    }
    const result = { buildings: p.buildings.length, floors: p.floors.length, rooms: p.rooms.length, tenants: p.tenants.length, contracts: p.contracts.length };
    await audit(tx, actor, { action: 'DATA_IMPORTED', entityType: 'Import', summary: `Imported from ${file.fileName}: ${Object.entries(result).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}`, newValue: result });
    return result;
  });
  return counts;
}
