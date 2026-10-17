-- Login one-time codes (e-mail OTP). Additive only: no existing data is changed.
ALTER TABLE `auth_tokens`
  MODIFY `type` ENUM('EMAIL_VERIFY', 'PASSWORD_RESET', 'LOGIN_OTP') NOT NULL,
  ADD COLUMN `codeHash` CHAR(64) NULL,
  ADD COLUMN `attempts` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `sendCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `sentAt` DATETIME(3) NULL;
