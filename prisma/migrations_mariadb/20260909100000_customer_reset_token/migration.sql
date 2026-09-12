-- AlterTable
ALTER TABLE `Customer`
  ADD COLUMN `resetToken` VARCHAR(191) NULL,
  ADD COLUMN `resetTokenExpiry` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Customer_resetToken_idx` ON `Customer`(`resetToken`);
