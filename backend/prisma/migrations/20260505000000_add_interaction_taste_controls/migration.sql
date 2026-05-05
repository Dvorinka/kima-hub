-- Add popularity column to Track (if not exists)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Track' AND column_name = 'popularity'
    ) THEN
        ALTER TABLE "Track" ADD COLUMN "popularity" DOUBLE PRECISION DEFAULT 0;
    END IF;
END $$;

-- Create InteractionType enum
CREATE TYPE "InteractionType" AS ENUM ('PLAY', 'SKIP', 'LIKE', 'DISLIKE', 'SAVE', 'HIDE');

-- Create Interaction table
CREATE TABLE "Interaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "type" "InteractionType" NOT NULL,
    "weight" DOUBLE PRECISION,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedMs" INTEGER,

    CONSTRAINT "Interaction_pkey" PRIMARY KEY ("id")
);

-- Add foreign keys
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create indexes
CREATE INDEX "Interaction_userId_type_idx" ON "Interaction"("userId", "type");
CREATE INDEX "Interaction_userId_occurredAt_idx" ON "Interaction"("userId", "occurredAt");

-- Create UserTasteProfile table
CREATE TABLE "UserTasteProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vector" JSON NOT NULL,
    "topGenres" JSON NOT NULL DEFAULT '{}',
    "interactionCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "explorationReadiness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTasteProfile_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UserTasteProfile" ADD CONSTRAINT "UserTasteProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserTasteProfile" ADD CONSTRAINT "UserTasteProfile_userId_key" UNIQUE ("userId");

-- Create UserRecControls table
CREATE TABLE "UserRecControls" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "allowExplicit" BOOLEAN NOT NULL DEFAULT true,
    "excludedTrackIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedArtistIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedGenres" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "postponedTrackIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRecControls_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UserRecControls" ADD CONSTRAINT "UserRecControls_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRecControls" ADD CONSTRAINT "UserRecControls_userId_key" UNIQUE ("userId");
