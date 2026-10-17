/**
 * Permission catalog and the default permission set of each system role.
 * This is the single source of truth: `syncRbac()` writes it to the database on
 * bootstrap, and every protected route names one of these keys.
 */
export const PERMISSIONS = {
  'dashboard.view': ['Dashboard', 'View dashboards and daily operations'],
  'building.view': ['Property', 'View buildings and floors'],
  'building.manage': ['Property', 'Create and edit buildings and floors'],
  'room.view': ['Property', 'View rooms'],
  'room.manage': ['Property', 'Create and edit rooms, reservations and room status'],
  'room.rent.manage': ['Property', 'Change room rent and contract rent rates'],
  'tenant.view': ['Tenants', 'View tenants'],
  'tenant.manage': ['Tenants', 'Create and edit tenants'],
  'tenant.blacklist': ['Tenants', 'Blacklist or un-blacklist a tenant'],
  'contract.view': ['Contracts', 'View contracts'],
  'contract.manage': ['Contracts', 'Create, activate and renew contracts'],
  'contract.terminate': ['Contracts', 'Terminate contracts (move-out)'],
  'contract.rent.override': ['Contracts', 'Set a tenant-specific rent different from the room rent'],
  'rent.view': ['Rent', 'View rent charges and ledgers'],
  'rent.generate': ['Rent', 'Run monthly rent charge generation'],
  'payment.view': ['Payments', 'View payments and receipts'],
  'payment.create': ['Payments', 'Record rent payments and issue receipts'],
  'payment.advance': ['Payments', 'Record advance payments (more than the outstanding balance)'],
  'payment.verify': ['Payments', 'Verify recorded payments'],
  'payment.reverse.request': ['Payments', 'Request a payment reversal'],
  'deposit.view': ['Deposits', 'View security deposits'],
  'deposit.manage': ['Deposits', 'Record security deposit payments and deductions'],
  'invoice.view': ['Invoices', 'View invoice / EBM records'],
  'invoice.manage': ['Invoices', 'Update invoice / EBM references and status'],
  'expense.view': ['Expenses', 'View expenses'],
  'expense.create': ['Expenses', 'Record expenses'],
  'expense.approve': ['Expenses', 'Approve, reject or void expenses'],
  'maintenance.view': ['Maintenance', 'View maintenance requests'],
  'maintenance.manage': ['Maintenance', 'Create and update maintenance requests'],
  'adjustment.request': ['Approvals', 'Request rent discounts, surcharges and debt waivers'],
  'approval.view': ['Approvals', 'View the approval queue'],
  'approval.decide': ['Approvals', 'Approve or reject reversals, adjustments, waivers and deposit refunds'],
  'report.view': ['Reports', 'View occupancy and operational reports'],
  'report.financial': ['Reports', 'View financial reports'],
  'export.data': ['Reports', 'Export data to PDF / Excel'],
  'document.view': ['Documents', 'View and download documents'],
  'document.upload': ['Documents', 'Upload documents'],
  'message.create': ['Communication', 'Generate tenant messages and reminders'],
  'period.manage': ['Finance', 'Close and reopen accounting periods'],
  'data.delete': ['Administration', 'Delete buildings, floors, rooms and tenants that have no contracts or payments'],
  'import.data': ['Administration', 'Import existing records from Excel / CSV'],
  'user.manage': ['Administration', 'Create and manage users'],
  'role.manage': ['Administration', 'Change role permissions'],
  'settings.manage': ['Administration', 'Change organization settings, categories and payment methods'],
  'audit.view': ['Administration', 'View the audit log'],
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

const VIEW_ALL: PermissionKey[] = [
  'dashboard.view', 'building.view', 'room.view', 'tenant.view', 'contract.view', 'rent.view',
  'payment.view', 'deposit.view', 'invoice.view', 'expense.view', 'maintenance.view',
  'report.view', 'report.financial', 'document.view',
];

export const SYSTEM_ROLES: Record<string, { name: string; description: string; permissions: PermissionKey[] }> = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    description: 'Full access to everything, including users, roles and settings.',
    permissions: ALL_PERMISSIONS,
  },
  MANAGEMENT: {
    name: 'Management',
    description: 'Reports, tenants, rooms, payments, expenses, contracts and approvals.',
    permissions: [
      ...VIEW_ALL, 'building.manage', 'room.manage', 'room.rent.manage', 'tenant.manage', 'tenant.blacklist',
      'contract.manage', 'contract.terminate', 'contract.rent.override', 'rent.generate',
      'payment.create', 'payment.advance', 'payment.verify', 'payment.reverse.request',
      'deposit.manage', 'invoice.manage', 'expense.create', 'expense.approve', 'maintenance.manage',
      'adjustment.request', 'approval.view', 'approval.decide', 'export.data', 'document.upload',
      'message.create', 'period.manage', 'import.data', 'audit.view', 'data.delete',
    ],
  },
  ACCOUNTANT: {
    name: 'Accountant',
    description: 'Financial records, payments, expenses, invoices and financial reports.',
    permissions: [
      ...VIEW_ALL, 'rent.generate', 'payment.create', 'payment.advance', 'payment.verify',
      'payment.reverse.request', 'deposit.manage', 'invoice.manage', 'expense.create',
      'adjustment.request', 'approval.view', 'export.data', 'document.upload', 'message.create',
    ],
  },
  CASHIER: {
    name: 'Cashier',
    description: 'Records payments and issues receipts. Limited financial visibility.',
    permissions: [
      'dashboard.view', 'building.view', 'room.view', 'tenant.view', 'contract.view', 'rent.view',
      'payment.view', 'payment.create', 'payment.reverse.request', 'invoice.view', 'invoice.manage',
      'document.view', 'document.upload', 'message.create',
    ],
  },
  PROPERTY_STAFF: {
    name: 'Property Staff',
    description: 'Rooms, tenants, contracts and maintenance. Limited reports.',
    permissions: [
      'dashboard.view', 'building.view', 'room.view', 'room.manage', 'tenant.view', 'tenant.manage',
      'contract.view', 'contract.manage', 'rent.view', 'maintenance.view', 'maintenance.manage',
      'report.view', 'document.view', 'document.upload', 'message.create',
    ],
  },
  VIEWER: {
    name: 'Viewer',
    description: 'Read-only dashboard and reports.',
    permissions: VIEW_ALL,
  },
};
