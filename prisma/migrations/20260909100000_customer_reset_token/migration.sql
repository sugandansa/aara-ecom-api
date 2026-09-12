-- AlterTable
ALTER TABLE "Customer"
  ADD COLUMN "resetToken" TEXT,
  ADD COLUMN "resetTokenExpiry" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Customer_resetToken_idx" ON "Customer"("resetToken");
