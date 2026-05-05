-- AlterTable: Add SpotiFLAC toggle to SystemSettings
ALTER TABLE "SystemSettings" ADD COLUMN "spotiflacEnabled" BOOLEAN NOT NULL DEFAULT false;
