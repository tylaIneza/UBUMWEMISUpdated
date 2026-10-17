-- A room that has never been let can now be deleted (e.g. registered by mistake), together with its
-- rent-rate rows. Rent history of any room that has ever had a contract still cannot be deleted.
DROP TRIGGER `trg_room_rate_delete`;
CREATE TRIGGER `trg_room_rate_delete` BEFORE DELETE ON `room_rent_rates` FOR EACH ROW
BEGIN
  IF EXISTS (SELECT 1 FROM `contracts` c WHERE c.`roomId` = OLD.`roomId` AND c.`status` <> 'DRAFT') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RPMS: rent rate history cannot be deleted for a room that has been let';
  END IF;
END;
