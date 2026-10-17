-- Whether a second person must verify each payment. Off: a recorded payment counts as verified at once.
ALTER TABLE `organizations` ADD COLUMN `requirePaymentVerification` BOOLEAN NOT NULL DEFAULT true;
