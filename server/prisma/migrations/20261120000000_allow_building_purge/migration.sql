-- Deleting a building now removes it together with its whole history (contracts, rent charges, payments,
-- receipts, deposits, expenses...). The append-only delete guards stay in force everywhere else: they
-- only step aside while the application's building delete runs, which sets the session variable
-- @rpms_purge = 1 inside its transaction and clears it before returning the connection.

DROP TRIGGER `trg_payments_no_delete`;
CREATE TRIGGER `trg_payments_no_delete` BEFORE DELETE ON `payments` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: payments cannot be deleted; post a reversal instead';
  END IF;
END;

DROP TRIGGER `trg_allocations_no_delete`;
CREATE TRIGGER `trg_allocations_no_delete` BEFORE DELETE ON `payment_allocations` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: payment allocations are append-only';
  END IF;
END;

DROP TRIGGER `trg_deposits_no_delete`;
CREATE TRIGGER `trg_deposits_no_delete` BEFORE DELETE ON `deposit_transactions` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: deposit transactions are append-only';
  END IF;
END;

DROP TRIGGER `trg_receipts_no_delete`;
CREATE TRIGGER `trg_receipts_no_delete` BEFORE DELETE ON `receipts` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: receipts cannot be deleted; void them instead';
  END IF;
END;

DROP TRIGGER `trg_charges_no_delete`;
CREATE TRIGGER `trg_charges_no_delete` BEFORE DELETE ON `rent_charges` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent charges cannot be deleted; void or waive them instead';
  END IF;
END;

DROP TRIGGER `trg_room_rate_delete`;
CREATE TRIGGER `trg_room_rate_delete` BEFORE DELETE ON `room_rent_rates` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1
     AND EXISTS (SELECT 1 FROM `contracts` c WHERE c.`roomId` = OLD.`roomId` AND c.`status` <> 'DRAFT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate history cannot be deleted for a room that has been let';
  END IF;
END;

DROP TRIGGER `trg_contract_rate_delete`;
CREATE TRIGGER `trg_contract_rate_delete` BEFORE DELETE ON `contract_rent_rates` FOR EACH ROW
BEGIN
  IF COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate history cannot be deleted';
  END IF;
END;

DROP TRIGGER `trg_contracts_no_delete`;
CREATE TRIGGER `trg_contracts_no_delete` BEFORE DELETE ON `contracts` FOR EACH ROW
BEGIN
  IF OLD.`status` <> 'DRAFT' AND COALESCE(@rpms_purge, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: only draft contracts can be deleted; terminate the contract instead';
  END IF;
END;
