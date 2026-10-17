-- CreateTable
CREATE TABLE `organizations` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `legalName` VARCHAR(200) NULL,
    `tin` VARCHAR(40) NULL,
    `address` VARCHAR(255) NULL,
    `phone` VARCHAR(40) NULL,
    `email` VARCHAR(160) NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'RWF',
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Africa/Kigali',
    `defaultDueDay` INTEGER NOT NULL DEFAULT 5,
    `defaultGraceDays` INTEGER NOT NULL DEFAULT 5,
    `expiringSoonDays` INTEGER NOT NULL DEFAULT 30,
    `dueSoonDays` INTEGER NOT NULL DEFAULT 3,
    `receiptPrefix` VARCHAR(10) NOT NULL DEFAULT 'REC',
    `invoicePrefix` VARCHAR(10) NOT NULL DEFAULT 'INV',
    `contractPrefix` VARCHAR(10) NOT NULL DEFAULT 'CTR',
    `allocationRule` VARCHAR(20) NOT NULL DEFAULT 'OLDEST_FIRST',
    `notifyInApp` BOOLEAN NOT NULL DEFAULT true,
    `proratePartialMonths` BOOLEAN NOT NULL DEFAULT true,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sequences` (
    `orgId` CHAR(36) NOT NULL,
    `key` VARCHAR(30) NOT NULL,
    `year` INTEGER NOT NULL,
    `nextValue` INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY (`orgId`, `key`, `year`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `email` VARCHAR(160) NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `phone` VARCHAR(40) NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `emailVerifiedAt` DATETIME(3) NULL,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `lastLoginAt` DATETIME(3) NULL,
    `failedLogins` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_orgId_idx`(`orgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(40) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `description` VARCHAR(255) NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `roles_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(60) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `category` VARCHAR(40) NOT NULL,

    UNIQUE INDEX `permissions_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `roleId` CHAR(36) NOT NULL,
    `permissionId` CHAR(36) NOT NULL,

    PRIMARY KEY (`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `userId` CHAR(36) NOT NULL,
    `roleId` CHAR(36) NOT NULL,

    PRIMARY KEY (`userId`, `roleId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `csrfToken` CHAR(64) NOT NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `sessions_tokenHash_key`(`tokenHash`),
    INDEX `sessions_userId_idx`(`userId`),
    INDEX `sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_tokens` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` ENUM('EMAIL_VERIFY', 'PASSWORD_RESET') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auth_tokens_tokenHash_key`(`tokenHash`),
    INDEX `auth_tokens_userId_type_idx`(`userId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buildings` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `address` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `buildings_orgId_code_key`(`orgId`, `code`),
    UNIQUE INDEX `buildings_orgId_name_key`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `floors` (
    `id` CHAR(36) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `level` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `floors_buildingId_name_key`(`buildingId`, `name`),
    UNIQUE INDEX `floors_buildingId_level_key`(`buildingId`, `level`),
    UNIQUE INDEX `floors_id_buildingId_key`(`id`, `buildingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rooms` (
    `id` CHAR(36) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `floorId` CHAR(36) NOT NULL,
    `number` VARCHAR(30) NOT NULL,
    `roomType` VARCHAR(40) NOT NULL DEFAULT 'Shop',
    `monthlyRent` DECIMAL(14, 2) NOT NULL,
    `depositRequired` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `status` ENUM('VACANT', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE') NOT NULL DEFAULT 'VACANT',
    `description` TEXT NULL,
    `areaSqm` DECIMAL(8, 2) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `rooms_floorId_buildingId_idx`(`floorId`, `buildingId`),
    INDEX `rooms_status_idx`(`status`),
    UNIQUE INDEX `rooms_buildingId_number_key`(`buildingId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_rent_rates` (
    `id` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `effectiveFrom` DATE NOT NULL,
    `effectiveTo` DATE NULL,
    `reason` VARCHAR(255) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `room_rent_rates_roomId_effectiveFrom_idx`(`roomId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenants` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `idType` VARCHAR(20) NOT NULL DEFAULT 'NATIONAL_ID',
    `idNumber` VARCHAR(40) NOT NULL,
    `phone` VARCHAR(40) NOT NULL,
    `email` VARCHAR(160) NULL,
    `address` VARCHAR(255) NULL,
    `businessName` VARCHAR(160) NULL,
    `emergencyContactName` VARCHAR(160) NULL,
    `emergencyContactPhone` VARCHAR(40) NULL,
    `notes` TEXT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE', 'FORMER', 'BLACKLISTED') NOT NULL DEFAULT 'INACTIVE',
    `statusReason` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `tenants_orgId_fullName_idx`(`orgId`, `fullName`),
    INDEX `tenants_phone_idx`(`phone`),
    UNIQUE INDEX `tenants_orgId_idNumber_key`(`orgId`, `idNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contracts` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `contractNumber` VARCHAR(30) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `floorId` CHAR(36) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `monthlyRent` DECIMAL(14, 2) NOT NULL,
    `roomRentAtSigning` DECIMAL(14, 2) NOT NULL,
    `rentOverrideReason` VARCHAR(255) NULL,
    `depositAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `paymentDueDay` INTEGER NOT NULL,
    `graceDays` INTEGER NOT NULL,
    `specialTerms` TEXT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'TERMINATED', 'RENEWED') NOT NULL DEFAULT 'DRAFT',
    `activatedAt` DATETIME(3) NULL,
    `billingStart` DATE NULL,
    `terminatedOn` DATE NULL,
    `terminationReason` VARCHAR(255) NULL,
    `roomCondition` TEXT NULL,
    `finalBalance` DECIMAL(14, 2) NULL,
    `renewedFromId` CHAR(36) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `contracts_contractNumber_key`(`contractNumber`),
    UNIQUE INDEX `contracts_renewedFromId_key`(`renewedFromId`),
    INDEX `contracts_tenantId_idx`(`tenantId`),
    INDEX `contracts_roomId_status_idx`(`roomId`, `status`),
    INDEX `contracts_buildingId_status_idx`(`buildingId`, `status`),
    INDEX `contracts_endDate_idx`(`endDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contract_rent_rates` (
    `id` CHAR(36) NOT NULL,
    `contractId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `effectiveFrom` DATE NOT NULL,
    `effectiveTo` DATE NULL,
    `reason` VARCHAR(255) NULL,
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `contract_rent_rates_contractId_effectiveFrom_idx`(`contractId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rent_adjustments` (
    `id` CHAR(36) NOT NULL,
    `contractId` CHAR(36) NOT NULL,
    `type` ENUM('DISCOUNT', 'SURCHARGE') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `reason` VARCHAR(255) NOT NULL,
    `effectiveFrom` DATE NOT NULL,
    `effectiveTo` DATE NULL,
    `status` ENUM('ACTIVE', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
    `approvalId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `rent_adjustments_approvalId_key`(`approvalId`),
    INDEX `rent_adjustments_contractId_effectiveFrom_idx`(`contractId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reservations` (
    `id` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NULL,
    `prospectName` VARCHAR(160) NOT NULL,
    `prospectPhone` VARCHAR(40) NULL,
    `reservedOn` DATE NOT NULL,
    `expiresOn` DATE NOT NULL,
    `depositAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `notes` TEXT NULL,
    `status` ENUM('ACTIVE', 'CONVERTED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `createdById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `reservations_roomId_status_idx`(`roomId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rent_charges` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `contractId` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `floorId` CHAR(36) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `period` DATE NOT NULL,
    `baseAmount` DECIMAL(14, 2) NOT NULL,
    `adjustmentAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `amountDue` DECIMAL(14, 2) NOT NULL,
    `amountPaid` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `amountWaived` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `balance` DECIMAL(14, 2) NOT NULL,
    `status` ENUM('UNPAID', 'PARTIAL', 'PAID', 'OVERDUE', 'WAIVED', 'VOID') NOT NULL DEFAULT 'UNPAID',
    `dueDate` DATE NOT NULL,
    `overdueFrom` DATE NOT NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `rent_charges_contractId_period_idx`(`contractId`, `period`),
    INDEX `rent_charges_buildingId_period_idx`(`buildingId`, `period`),
    INDEX `rent_charges_tenantId_period_idx`(`tenantId`, `period`),
    INDEX `rent_charges_roomId_period_idx`(`roomId`, `period`),
    INDEX `rent_charges_status_overdueFrom_idx`(`status`, `overdueFrom`),
    INDEX `rent_charges_orgId_period_idx`(`orgId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_methods` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `requiresReference` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `payment_methods_orgId_code_key`(`orgId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `type` ENUM('PAYMENT', 'REVERSAL') NOT NULL DEFAULT 'PAYMENT',
    `status` ENUM('POSTED', 'REVERSED') NOT NULL DEFAULT 'POSTED',
    `tenantId` CHAR(36) NOT NULL,
    `contractId` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `floorId` CHAR(36) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `allocatedAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `unallocatedAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `paidAt` DATETIME(3) NOT NULL,
    `businessDate` DATE NOT NULL,
    `methodId` CHAR(36) NOT NULL,
    `reference` VARCHAR(80) NULL,
    `notes` TEXT NULL,
    `idempotencyKey` VARCHAR(80) NOT NULL,
    `reversesId` CHAR(36) NULL,
    `reason` VARCHAR(255) NULL,
    `recordedById` CHAR(36) NOT NULL,
    `verifiedById` CHAR(36) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payments_reversesId_key`(`reversesId`),
    INDEX `payments_buildingId_businessDate_idx`(`buildingId`, `businessDate`),
    INDEX `payments_orgId_businessDate_idx`(`orgId`, `businessDate`),
    INDEX `payments_tenantId_paidAt_idx`(`tenantId`, `paidAt`),
    INDEX `payments_contractId_idx`(`contractId`),
    INDEX `payments_roomId_idx`(`roomId`),
    INDEX `payments_reference_idx`(`reference`),
    UNIQUE INDEX `payments_orgId_idempotencyKey_key`(`orgId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_allocations` (
    `id` CHAR(36) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `rentChargeId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payment_allocations_paymentId_idx`(`paymentId`),
    INDEX `payment_allocations_rentChargeId_idx`(`rentChargeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `receipts` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `receiptNumber` VARCHAR(30) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `issuedById` CHAR(36) NOT NULL,
    `snapshot` JSON NOT NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidReason` VARCHAR(255) NULL,

    UNIQUE INDEX `receipts_receiptNumber_key`(`receiptNumber`),
    UNIQUE INDEX `receipts_paymentId_key`(`paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `invoiceNumber` VARCHAR(30) NOT NULL,
    `paymentId` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `issueDate` DATE NOT NULL,
    `ebmReference` VARCHAR(80) NULL,
    `status` ENUM('PENDING', 'GENERATED', 'ISSUED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `statusNote` VARCHAR(255) NULL,
    `updatedById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoices_invoiceNumber_key`(`invoiceNumber`),
    UNIQUE INDEX `invoices_paymentId_key`(`paymentId`),
    INDEX `invoices_status_idx`(`status`),
    INDEX `invoices_buildingId_issueDate_idx`(`buildingId`, `issueDate`),
    UNIQUE INDEX `invoices_orgId_ebmReference_key`(`orgId`, `ebmReference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `deposit_transactions` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `number` VARCHAR(30) NOT NULL,
    `contractId` CHAR(36) NOT NULL,
    `type` ENUM('PAYMENT', 'REFUND', 'DEDUCTION', 'CORRECTION') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `txnDate` DATE NOT NULL,
    `methodId` CHAR(36) NULL,
    `reference` VARCHAR(80) NULL,
    `reason` VARCHAR(255) NULL,
    `recordedById` CHAR(36) NOT NULL,
    `approvalId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `deposit_transactions_number_key`(`number`),
    UNIQUE INDEX `deposit_transactions_approvalId_key`(`approvalId`),
    INDEX `deposit_transactions_contractId_idx`(`contractId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounting_periods` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `period` DATE NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `closedById` CHAR(36) NULL,
    `closedAt` DATETIME(3) NULL,
    `note` VARCHAR(255) NULL,

    UNIQUE INDEX `accounting_periods_orgId_period_key`(`orgId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_requests` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `type` ENUM('PAYMENT_REVERSAL', 'RENT_ADJUSTMENT', 'DEBT_WAIVER', 'DEPOSIT_REFUND') NOT NULL,
    `status` ENUM('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
    `entityType` VARCHAR(40) NOT NULL,
    `entityId` CHAR(36) NOT NULL,
    `summary` VARCHAR(255) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `payload` JSON NOT NULL,
    `requestedById` CHAR(36) NOT NULL,
    `decidedById` CHAR(36) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `approval_requests_orgId_status_idx`(`orgId`, `status`),
    INDEX `approval_requests_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expense_categories` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `expense_categories_orgId_name_key`(`orgId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `number` VARCHAR(30) NOT NULL,
    `scope` ENUM('ORGANIZATION', 'BUILDING', 'FLOOR', 'ROOM') NOT NULL,
    `buildingId` CHAR(36) NULL,
    `floorId` CHAR(36) NULL,
    `roomId` CHAR(36) NULL,
    `categoryId` CHAR(36) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `expenseDate` DATE NOT NULL,
    `methodId` CHAR(36) NULL,
    `supplier` VARCHAR(160) NULL,
    `reference` VARCHAR(80) NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'VOID') NOT NULL DEFAULT 'SUBMITTED',
    `maintenanceRequestId` CHAR(36) NULL,
    `recordedById` CHAR(36) NOT NULL,
    `approvedById` CHAR(36) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `expenses_number_key`(`number`),
    INDEX `expenses_orgId_expenseDate_idx`(`orgId`, `expenseDate`),
    INDEX `expenses_buildingId_expenseDate_idx`(`buildingId`, `expenseDate`),
    INDEX `expenses_status_idx`(`status`),
    INDEX `expenses_maintenanceRequestId_idx`(`maintenanceRequestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `maintenance_requests` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `number` VARCHAR(30) NOT NULL,
    `buildingId` CHAR(36) NOT NULL,
    `floorId` CHAR(36) NULL,
    `roomId` CHAR(36) NULL,
    `title` VARCHAR(160) NOT NULL,
    `description` TEXT NULL,
    `priority` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'MEDIUM',
    `status` ENUM('REPORTED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'REPORTED',
    `reportedOn` DATE NOT NULL,
    `reportedById` CHAR(36) NOT NULL,
    `assignedToId` CHAR(36) NULL,
    `estimatedCost` DECIMAL(14, 2) NULL,
    `actualCost` DECIMAL(14, 2) NULL,
    `supplier` VARCHAR(160) NULL,
    `completedOn` DATE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `maintenance_requests_number_key`(`number`),
    INDEX `maintenance_requests_buildingId_status_idx`(`buildingId`, `status`),
    INDEX `maintenance_requests_roomId_idx`(`roomId`),
    INDEX `maintenance_requests_orgId_status_idx`(`orgId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `documents` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `entityType` VARCHAR(40) NOT NULL,
    `entityId` CHAR(36) NOT NULL,
    `category` VARCHAR(40) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `storedName` VARCHAR(120) NOT NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `uploadedById` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `documents_storedName_key`(`storedName`),
    INDEX `documents_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `category` ENUM('RENT', 'PAYMENT', 'CONTRACT', 'MAINTENANCE', 'FINANCE', 'SYSTEM') NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `body` VARCHAR(500) NOT NULL,
    `entityType` VARCHAR(40) NULL,
    `entityId` CHAR(36) NULL,
    `dedupeKey` VARCHAR(120) NOT NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
    UNIQUE INDEX `notifications_userId_dedupeKey_key`(`userId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_logs` (
    `id` CHAR(36) NOT NULL,
    `orgId` CHAR(36) NOT NULL,
    `tenantId` CHAR(36) NOT NULL,
    `contractId` CHAR(36) NULL,
    `channel` ENUM('COPY', 'EMAIL', 'SMS', 'WHATSAPP') NOT NULL,
    `template` VARCHAR(40) NOT NULL,
    `body` TEXT NOT NULL,
    `status` ENUM('GENERATED', 'SENT', 'FAILED') NOT NULL,
    `error` VARCHAR(255) NULL,
    `createdById` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `message_logs_tenantId_createdAt_idx`(`tenantId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `orgId` CHAR(36) NULL,
    `userId` CHAR(36) NULL,
    `userLabel` VARCHAR(200) NULL,
    `action` VARCHAR(60) NOT NULL,
    `entityType` VARCHAR(40) NOT NULL,
    `entityId` VARCHAR(40) NULL,
    `summary` VARCHAR(500) NULL,
    `oldValue` JSON NULL,
    `newValue` JSON NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `audit_logs_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `audit_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sequences` ADD CONSTRAINT `sequences_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_tokens` ADD CONSTRAINT `auth_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `buildings` ADD CONSTRAINT `buildings_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `floors` ADD CONSTRAINT `floors_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_floorId_buildingId_fkey` FOREIGN KEY (`floorId`, `buildingId`) REFERENCES `floors`(`id`, `buildingId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_rent_rates` ADD CONSTRAINT `room_rent_rates_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_rent_rates` ADD CONSTRAINT `room_rent_rates_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenants` ADD CONSTRAINT `tenants_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_floorId_fkey` FOREIGN KEY (`floorId`) REFERENCES `floors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_renewedFromId_fkey` FOREIGN KEY (`renewedFromId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contracts` ADD CONSTRAINT `contracts_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contract_rent_rates` ADD CONSTRAINT `contract_rent_rates_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contract_rent_rates` ADD CONSTRAINT `contract_rent_rates_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_adjustments` ADD CONSTRAINT `rent_adjustments_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_adjustments` ADD CONSTRAINT `rent_adjustments_approvalId_fkey` FOREIGN KEY (`approvalId`) REFERENCES `approval_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_floorId_fkey` FOREIGN KEY (`floorId`) REFERENCES `floors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rent_charges` ADD CONSTRAINT `rent_charges_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_methods` ADD CONSTRAINT `payment_methods_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_floorId_fkey` FOREIGN KEY (`floorId`) REFERENCES `floors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_methods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_reversesId_fkey` FOREIGN KEY (`reversesId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_verifiedById_fkey` FOREIGN KEY (`verifiedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_allocations` ADD CONSTRAINT `payment_allocations_rentChargeId_fkey` FOREIGN KEY (`rentChargeId`) REFERENCES `rent_charges`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_issuedById_fkey` FOREIGN KEY (`issuedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deposit_transactions` ADD CONSTRAINT `deposit_transactions_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deposit_transactions` ADD CONSTRAINT `deposit_transactions_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_methods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deposit_transactions` ADD CONSTRAINT `deposit_transactions_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `deposit_transactions` ADD CONSTRAINT `deposit_transactions_approvalId_fkey` FOREIGN KEY (`approvalId`) REFERENCES `approval_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounting_periods` ADD CONSTRAINT `accounting_periods_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounting_periods` ADD CONSTRAINT `accounting_periods_closedById_fkey` FOREIGN KEY (`closedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_decidedById_fkey` FOREIGN KEY (`decidedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expense_categories` ADD CONSTRAINT `expense_categories_orgId_fkey` FOREIGN KEY (`orgId`) REFERENCES `organizations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_floorId_fkey` FOREIGN KEY (`floorId`) REFERENCES `floors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `expense_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_methodId_fkey` FOREIGN KEY (`methodId`) REFERENCES `payment_methods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_maintenanceRequestId_fkey` FOREIGN KEY (`maintenanceRequestId`) REFERENCES `maintenance_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_requests` ADD CONSTRAINT `maintenance_requests_buildingId_fkey` FOREIGN KEY (`buildingId`) REFERENCES `buildings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_requests` ADD CONSTRAINT `maintenance_requests_floorId_fkey` FOREIGN KEY (`floorId`) REFERENCES `floors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_requests` ADD CONSTRAINT `maintenance_requests_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_requests` ADD CONSTRAINT `maintenance_requests_reportedById_fkey` FOREIGN KEY (`reportedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `maintenance_requests` ADD CONSTRAINT `maintenance_requests_assignedToId_fkey` FOREIGN KEY (`assignedToId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_logs` ADD CONSTRAINT `message_logs_tenantId_fkey` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_logs` ADD CONSTRAINT `message_logs_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `contracts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_logs` ADD CONSTRAINT `message_logs_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

