-- Integrity rules that the Prisma schema cannot express.
-- Hand-written. These are the database-level guarantees behind docs/ARCHITECTURE.md §"Data consistency".

-- ───────────── CHECK constraints ─────────────
ALTER TABLE `rooms`
  ADD CONSTRAINT `chk_room_amounts` CHECK (`monthlyRent` >= 0 AND `depositRequired` >= 0);

ALTER TABLE `room_rent_rates`
  ADD CONSTRAINT `chk_room_rate` CHECK (`amount` >= 0 AND (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`));

ALTER TABLE `contract_rent_rates`
  ADD CONSTRAINT `chk_contract_rate` CHECK (`amount` >= 0 AND (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`));

ALTER TABLE `contracts`
  ADD CONSTRAINT `chk_contract_dates` CHECK (`endDate` >= `startDate` AND (`terminatedOn` IS NULL OR `terminatedOn` >= `startDate`)),
  ADD CONSTRAINT `chk_contract_terms` CHECK (`monthlyRent` >= 0 AND `depositAmount` >= 0 AND `paymentDueDay` BETWEEN 1 AND 31 AND `graceDays` BETWEEN 0 AND 90);

ALTER TABLE `rent_adjustments`
  ADD CONSTRAINT `chk_adjustment` CHECK (`amount` > 0 AND (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`));

ALTER TABLE `reservations`
  ADD CONSTRAINT `chk_reservation` CHECK (`expiresOn` >= `reservedOn` AND `depositAmount` >= 0);

ALTER TABLE `rent_charges`
  ADD CONSTRAINT `chk_charge_amounts` CHECK (
    `amountDue` >= 0 AND `amountPaid` >= 0 AND `amountWaived` >= 0 AND `balance` >= 0
    AND `balance` = `amountDue` - `amountPaid` - `amountWaived`
    AND `amountDue` = `baseAmount` + `adjustmentAmount`),
  ADD CONSTRAINT `chk_charge_status` CHECK (
    (`status` <> 'PAID' OR `balance` = 0)
    AND (`status` <> 'WAIVED' OR (`balance` = 0 AND `amountWaived` > 0))
    AND (`status` <> 'PARTIAL' OR (`amountPaid` > 0 AND `balance` > 0))
    AND (`status` NOT IN ('UNPAID', 'OVERDUE') OR (`amountPaid` = 0 AND `balance` > 0))
    AND (`status` <> 'VOID' OR `amountPaid` = 0)),
  ADD CONSTRAINT `chk_charge_period` CHECK (DAYOFMONTH(`period`) = 1);

ALTER TABLE `payments`
  ADD CONSTRAINT `chk_payment_sign` CHECK (
    (`type` = 'PAYMENT' AND `amount` > 0 AND `allocatedAmount` >= 0 AND `unallocatedAmount` >= 0 AND `reversesId` IS NULL)
    OR (`type` = 'REVERSAL' AND `amount` < 0 AND `reversesId` IS NOT NULL)),
  ADD CONSTRAINT `chk_payment_split` CHECK (`amount` = `allocatedAmount` + `unallocatedAmount`);

ALTER TABLE `payment_allocations`
  ADD CONSTRAINT `chk_allocation_nonzero` CHECK (`amount` <> 0);

ALTER TABLE `deposit_transactions`
  ADD CONSTRAINT `chk_deposit_amount` CHECK (`amount` <> 0 AND (`type` = 'CORRECTION' OR `amount` > 0));

ALTER TABLE `expenses`
  ADD CONSTRAINT `chk_expense_amount` CHECK (`amount` > 0),
  ADD CONSTRAINT `chk_expense_scope` CHECK (
    (`scope` = 'ORGANIZATION' AND `buildingId` IS NULL AND `floorId` IS NULL AND `roomId` IS NULL)
    OR (`scope` = 'BUILDING' AND `buildingId` IS NOT NULL AND `floorId` IS NULL AND `roomId` IS NULL)
    OR (`scope` = 'FLOOR' AND `buildingId` IS NOT NULL AND `floorId` IS NOT NULL AND `roomId` IS NULL)
    OR (`scope` = 'ROOM' AND `buildingId` IS NOT NULL AND `floorId` IS NOT NULL AND `roomId` IS NOT NULL));

ALTER TABLE `maintenance_requests`
  ADD CONSTRAINT `chk_maint_costs` CHECK ((`estimatedCost` IS NULL OR `estimatedCost` >= 0) AND (`actualCost` IS NULL OR `actualCost` >= 0));

ALTER TABLE `accounting_periods`
  ADD CONSTRAINT `chk_period_first_day` CHECK (DAYOFMONTH(`period`) = 1);

-- ───────────── "Partial unique" rules ─────────────
-- One occupying contract per room, one active reservation per room, one live charge per contract and month, one live
-- payment per method and reference, one open rent rate per room / contract: created by migration
-- 20261023000100_partial_unique_columns as trigger-maintained columns with unique indexes.

-- ───────────── Immutability triggers ─────────────
CREATE TRIGGER `trg_payments_no_delete` BEFORE DELETE ON `payments` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: payments cannot be deleted; post a reversal instead';

CREATE TRIGGER `trg_payments_immutable` BEFORE UPDATE ON `payments` FOR EACH ROW
BEGIN
  IF NOT (NEW.`id` <=> OLD.`id`) OR NOT (NEW.`orgId` <=> OLD.`orgId`) OR NOT (NEW.`type` <=> OLD.`type`)
     OR NOT (NEW.`tenantId` <=> OLD.`tenantId`) OR NOT (NEW.`contractId` <=> OLD.`contractId`)
     OR NOT (NEW.`roomId` <=> OLD.`roomId`) OR NOT (NEW.`floorId` <=> OLD.`floorId`)
     OR NOT (NEW.`buildingId` <=> OLD.`buildingId`) OR NOT (NEW.`amount` <=> OLD.`amount`)
     OR NOT (NEW.`paidAt` <=> OLD.`paidAt`) OR NOT (NEW.`businessDate` <=> OLD.`businessDate`)
     OR NOT (NEW.`methodId` <=> OLD.`methodId`) OR NOT (NEW.`reference` <=> OLD.`reference`)
     OR NOT (NEW.`notes` <=> OLD.`notes`) OR NOT (NEW.`idempotencyKey` <=> OLD.`idempotencyKey`)
     OR NOT (NEW.`reversesId` <=> OLD.`reversesId`) OR NOT (NEW.`reason` <=> OLD.`reason`)
     OR NOT (NEW.`recordedById` <=> OLD.`recordedById`) OR NOT (NEW.`createdAt` <=> OLD.`createdAt`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: posted payments are immutable; post a reversal instead';
  END IF;
  IF OLD.`status` = 'REVERSED' AND NEW.`status` <> 'REVERSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: a reversed payment cannot be re-posted';
  END IF;
END;

-- A payment may not be dated inside a closed accounting period.
CREATE TRIGGER `trg_payments_closed_period` BEFORE INSERT ON `payments` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `accounting_periods` p
             WHERE p.`orgId` = NEW.`orgId` AND p.`status` = 'CLOSED'
               AND p.`period` = DATE_SUB(NEW.`businessDate`, INTERVAL DAYOFMONTH(NEW.`businessDate`) - 1 DAY)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: the accounting period for this date is closed';
  END IF;
END;

CREATE TRIGGER `trg_allocations_no_update` BEFORE UPDATE ON `payment_allocations` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: payment allocations are append-only';
CREATE TRIGGER `trg_allocations_no_delete` BEFORE DELETE ON `payment_allocations` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: payment allocations are append-only';

CREATE TRIGGER `trg_audit_no_update` BEFORE UPDATE ON `audit_logs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: audit log is append-only';
CREATE TRIGGER `trg_audit_no_delete` BEFORE DELETE ON `audit_logs` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: audit log is append-only';

CREATE TRIGGER `trg_deposits_no_update` BEFORE UPDATE ON `deposit_transactions` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: deposit transactions are append-only';
CREATE TRIGGER `trg_deposits_no_delete` BEFORE DELETE ON `deposit_transactions` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: deposit transactions are append-only';

CREATE TRIGGER `trg_receipts_no_delete` BEFORE DELETE ON `receipts` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: receipts cannot be deleted; void them instead';
CREATE TRIGGER `trg_receipts_immutable` BEFORE UPDATE ON `receipts` FOR EACH ROW
BEGIN
  IF NOT (NEW.`receiptNumber` <=> OLD.`receiptNumber`) OR NOT (NEW.`paymentId` <=> OLD.`paymentId`)
     OR NOT (NEW.`issuedAt` <=> OLD.`issuedAt`) OR NOT (NEW.`issuedById` <=> OLD.`issuedById`)
     OR NOT (NEW.`snapshot` <=> OLD.`snapshot`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: issued receipts are immutable; they can only be voided';
  END IF;
END;

CREATE TRIGGER `trg_charges_no_delete` BEFORE DELETE ON `rent_charges` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent charges cannot be deleted; void or waive them instead';

-- ───────────── Rent-rate history: no overlaps, no rewriting ─────────────
CREATE TRIGGER `trg_room_rate_insert` BEFORE INSERT ON `room_rent_rates` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `room_rent_rates` r WHERE r.`roomId` = NEW.`roomId`
             AND r.`effectiveFrom` <= COALESCE(NEW.`effectiveTo`, '9999-12-31')
             AND COALESCE(r.`effectiveTo`, '9999-12-31') >= NEW.`effectiveFrom`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate periods for a room cannot overlap';
  END IF;
END;
CREATE TRIGGER `trg_room_rate_update` BEFORE UPDATE ON `room_rent_rates` FOR EACH ROW
BEGIN
  IF NOT (NEW.`roomId` <=> OLD.`roomId`) OR NOT (NEW.`amount` <=> OLD.`amount`)
     OR NOT (NEW.`effectiveFrom` <=> OLD.`effectiveFrom`) OR OLD.`effectiveTo` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: historical rent rates cannot be changed; only an open rate can be closed';
  END IF;
END;
CREATE TRIGGER `trg_room_rate_delete` BEFORE DELETE ON `room_rent_rates` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate history cannot be deleted';

CREATE TRIGGER `trg_contract_rate_insert` BEFORE INSERT ON `contract_rent_rates` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `contract_rent_rates` r WHERE r.`contractId` = NEW.`contractId`
             AND r.`effectiveFrom` <= COALESCE(NEW.`effectiveTo`, '9999-12-31')
             AND COALESCE(r.`effectiveTo`, '9999-12-31') >= NEW.`effectiveFrom`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate periods for a contract cannot overlap';
  END IF;
END;
CREATE TRIGGER `trg_contract_rate_update` BEFORE UPDATE ON `contract_rent_rates` FOR EACH ROW
BEGIN
  IF NOT (NEW.`contractId` <=> OLD.`contractId`) OR NOT (NEW.`amount` <=> OLD.`amount`)
     OR NOT (NEW.`effectiveFrom` <=> OLD.`effectiveFrom`) OR OLD.`effectiveTo` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: historical rent rates cannot be changed; only an open rate can be closed';
  END IF;
END;
CREATE TRIGGER `trg_contract_rate_delete` BEFORE DELETE ON `contract_rent_rates` FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate history cannot be deleted';

-- ───────────── Contracts: no overlapping occupancy periods for a room ─────────────
-- Effective period of a non-draft contract is [startDate, COALESCE(terminatedOn, endDate)].
CREATE TRIGGER `trg_contract_overlap_insert` BEFORE INSERT ON `contracts` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'DRAFT' AND EXISTS (
       SELECT 1 FROM `contracts` c WHERE c.`roomId` = NEW.`roomId` AND c.`status` <> 'DRAFT'
         AND c.`startDate` <= COALESCE(NEW.`terminatedOn`, NEW.`endDate`)
         AND COALESCE(c.`terminatedOn`, c.`endDate`) >= NEW.`startDate`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: contract dates overlap another contract for this room';
  END IF;
END;
CREATE TRIGGER `trg_contract_overlap_update` BEFORE UPDATE ON `contracts` FOR EACH ROW
BEGIN
  IF NEW.`status` <> 'DRAFT'
     AND (OLD.`status` = 'DRAFT' OR NOT (NEW.`startDate` <=> OLD.`startDate`) OR NOT (NEW.`endDate` <=> OLD.`endDate`)
          OR NOT (NEW.`roomId` <=> OLD.`roomId`)
          OR (NEW.`terminatedOn` IS NOT NULL AND OLD.`terminatedOn` IS NOT NULL AND NEW.`terminatedOn` > OLD.`terminatedOn`))
     AND EXISTS (
       SELECT 1 FROM `contracts` c WHERE c.`roomId` = NEW.`roomId` AND c.`status` <> 'DRAFT' AND c.`id` <> NEW.`id`
         AND c.`startDate` <= COALESCE(NEW.`terminatedOn`, NEW.`endDate`)
         AND COALESCE(c.`terminatedOn`, c.`endDate`) >= NEW.`startDate`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: contract dates overlap another contract for this room';
  END IF;
END;
CREATE TRIGGER `trg_contracts_no_delete` BEFORE DELETE ON `contracts` FOR EACH ROW
BEGIN
  IF OLD.`status` <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: only draft contracts can be deleted; terminate the contract instead';
  END IF;
END;
