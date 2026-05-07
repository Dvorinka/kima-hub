-- Add recommendationMode to SystemSettings
ALTER TABLE "SystemSettings" ADD COLUMN "recommendationMode" TEXT NOT NULL DEFAULT 'balanced';
