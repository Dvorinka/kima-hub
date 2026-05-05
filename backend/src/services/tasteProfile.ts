/**
 * Taste Profile Service
 *
 * Computes and persists a user's taste vector from their interaction history.
 * Integrates negative feedback (skip/dislike/hide), time decay, and exploration readiness.
 * Based on the Spotify reference engine's taste profile architecture.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

// ── Feature names matching Track DB columns ──
const TASTE_FEATURES = [
    "energy",
    "valence",
    "arousal",
    "bpm",
    "danceabilityMl",
    "acousticness",
    "instrumentalness",
    "speechiness",
    "loudness",
] as const;

type TasteFeature = (typeof TASTE_FEATURES)[number];

// Feature importance weights (from Spotify reference engine)
const FEATURE_IMPORTANCE: Record<TasteFeature, number> = {
    danceabilityMl: 1.12,
    energy: 1.18,
    loudness: 0.78,
    speechiness: 0.72,
    acousticness: 1.02,
    instrumentalness: 0.82,
    valence: 1.08,
    arousal: 0.92,
    bpm: 0.92,
};

// ── Interaction weights (from reference engine) ──
const INTERACTION_WEIGHTS: Record<string, number> = {
    LIKE: 1.0,
    SAVE: 0.9,
    PLAY: 0.45,     // completed play (>30s)
    SKIP: -0.55,
    DISLIKE: -1.0,
    HIDE: -1.25,
};

// Time decay: exp(-days/120) — recent interactions matter more
function timeDecay(occurredAt: Date, now: Date = new Date()): number {
    const days = (now.getTime() - occurredAt.getTime()) / (1000 * 60 * 60 * 24);
    if (days <= 0) return 1;
    return Math.exp(-days / 120);
}

// Get interaction weight with optional override
function interactionWeight(type: string, weightOverride?: number | null, completedMs?: number | null): number {
    if (weightOverride != null && weightOverride !== 0) return weightOverride;
    if (type === "PLAY" && completedMs != null && completedMs < 30000) return 0.20; // short play
    return INTERACTION_WEIGHTS[type] ?? 0;
}

// ── Taste vector computation ──

export interface TasteVector {
    vector: Record<TasteFeature, number>;
    topGenres: Record<string, number>;
    interactionCount: number;
    confidence: number;
    explorationReadiness: number;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

/**
 * Compute a user's taste vector from their interaction history.
 * Positive interactions pull the vector toward those tracks' features.
 * Negative interactions push the vector away.
 */
export async function computeTasteVector(userId: string): Promise<TasteVector> {
    const now = new Date();

    // Fetch all interactions for this user (with track features)
    const interactions = await prisma.interaction.findMany({
        where: { userId },
        orderBy: { occurredAt: "desc" },
        include: {
            track: {
                select: {
                    id: true,
                    energy: true,
                    valence: true,
                    arousal: true,
                    bpm: true,
                    danceabilityMl: true,
                    acousticness: true,
                    instrumentalness: true,
                    speechiness: true,
                    loudness: true,
                    lastfmTags: true,
                    essentiaGenres: true,
                },
            },
        },
    });

    // If no interactions, return empty profile
    if (interactions.length === 0) {
        const emptyVector: Record<string, number> = {};
        for (const f of TASTE_FEATURES) emptyVector[f] = 0.5;
        return {
            vector: emptyVector as Record<TasteFeature, number>,
            topGenres: {},
            interactionCount: 0,
            confidence: 0,
            explorationReadiness: 0.45,
        };
    }

    // Weighted sum of features
    const weightedSum: Record<string, number> = {};
    const totalWeight: Record<string, number> = {};
    for (const f of TASTE_FEATURES) {
        weightedSum[f] = 0;
        totalWeight[f] = 0;
    }

    // Genre scoring
    const genreScores: Record<string, number> = {};

    let positiveCount = 0;
    let negativeCount = 0;

    for (const interaction of interactions) {
        const weight = interactionWeight(
            interaction.type,
            interaction.weight,
            interaction.completedMs
        );
        const decay = timeDecay(interaction.occurredAt, now);
        const effectiveWeight = weight * decay;

        if (effectiveWeight > 0) positiveCount++;
        else if (effectiveWeight < 0) negativeCount++;

        // Accumulate feature weights
        for (const f of TASTE_FEATURES) {
            const value = interaction.track[f as keyof typeof interaction.track] as number | null;
            if (value != null) {
                // Normalize BPM/loudness to 0-1 range
                let normalized: number;
                if (f === "bpm") {
                    normalized = clamp01((value - 40) / (220 - 40));
                } else if (f === "loudness") {
                    normalized = clamp01((value + 60) / 60);
                } else {
                    normalized = clamp01(value);
                }
                weightedSum[f] += effectiveWeight * normalized * FEATURE_IMPORTANCE[f];
                totalWeight[f] += Math.abs(effectiveWeight) * FEATURE_IMPORTANCE[f];
            }
        }

        // Accumulate genre weights (positive interactions only)
        if (effectiveWeight > 0) {
            const genres = [
                ...(interaction.track.lastfmTags || []),
                ...(interaction.track.essentiaGenres || []),
            ];
            for (const genre of genres) {
                const g = genre.toLowerCase().trim();
                if (g) genreScores[g] = (genreScores[g] || 0) + effectiveWeight;
            }
        }
    }

    // Normalize taste vector
    const vector: Record<string, number> = {};
    let audioTotal = 0;
    for (const f of TASTE_FEATURES) {
        if (totalWeight[f] > 0) {
            vector[f] = clamp01(weightedSum[f] / totalWeight[f]);
            audioTotal += totalWeight[f];
        } else {
            vector[f] = 0.5; // neutral default
        }
    }

    // Normalize genre scores
    const maxGenreScore = Math.max(...Object.values(genreScores), 0);
    const topGenres: Record<string, number> = {};
    if (maxGenreScore > 0) {
        for (const [genre, score] of Object.entries(genreScores)) {
            topGenres[genre] = Math.round((score / maxGenreScore) * 10000) / 10000;
        }
    }

    // Confidence: how much data we have (logarithmic scaling)
    const totalInteractionWeight = interactions.reduce(
        (sum: number, i: { type: string; weight: number | null; completedMs: number | null; occurredAt: Date }) =>
            sum + Math.abs(interactionWeight(i.type, i.weight, i.completedMs) * timeDecay(i.occurredAt, now)),
        0
    );
    const confidence = clamp01(Math.log1p(totalInteractionWeight) / Math.log(32));

    // Exploration readiness: higher confidence + lower negative friction = more ready
    const friction = interactions.length > 0 ? negativeCount / interactions.length : 0;
    const explorationReadiness = clamp01((0.45 + confidence * 0.55) * (1 - friction * 0.6));

    return {
        vector: vector as Record<TasteFeature, number>,
        topGenres,
        interactionCount: interactions.length,
        confidence,
        explorationReadiness,
    };
}

/**
 * Persist the computed taste profile to the database.
 */
export async function saveTasteProfile(userId: string, taste: TasteVector): Promise<void> {
    await prisma.userTasteProfile.upsert({
        where: { userId },
        create: {
            userId,
            vector: taste.vector,
            topGenres: taste.topGenres,
            interactionCount: taste.interactionCount,
            confidence: taste.confidence,
            explorationReadiness: taste.explorationReadiness,
        },
        update: {
            vector: taste.vector,
            topGenres: taste.topGenres,
            interactionCount: taste.interactionCount,
            confidence: taste.confidence,
            explorationReadiness: taste.explorationReadiness,
        },
    });
    logger.debug(`[TASTE-PROFILE] Saved taste profile for user ${userId} (confidence=${taste.confidence.toFixed(3)}, exploration=${taste.explorationReadiness.toFixed(3)})`);
}

/**
 * Get the stored taste profile for a user, computing it fresh if missing.
 */
export async function getTasteProfile(userId: string): Promise<TasteVector> {
    const stored = await prisma.userTasteProfile.findUnique({ where: { userId } });
    if (stored) {
        return {
            vector: stored.vector as Record<TasteFeature, number>,
            topGenres: stored.topGenres as Record<string, number>,
            interactionCount: stored.interactionCount,
            confidence: stored.confidence,
            explorationReadiness: stored.explorationReadiness,
        };
    }
    // Compute and save on first access
    const taste = await computeTasteVector(userId);
    await saveTasteProfile(userId, taste);
    return taste;
}

/**
 * Record an interaction and refresh the taste profile.
 */
export async function recordInteraction(
    userId: string,
    trackId: string,
    type: string,
    completedMs?: number,
    weight?: number
): Promise<void> {
    await prisma.interaction.create({
        data: {
            userId,
            trackId,
            type: type as any,
            weight: weight ?? null,
            completedMs: completedMs ?? null,
        },
    });

    // Refresh taste profile in background (don't block the response)
    computeTasteVector(userId)
        .then(taste => saveTasteProfile(userId, taste))
        .catch(err => logger.error(`[TASTE-PROFILE] Failed to refresh taste profile:`, err));
}

/**
 * Get user recommendation controls, creating defaults if missing.
 */
export async function getUserControls(userId: string): Promise<{
    allowExplicit: boolean;
    excludedTrackIds: string[];
    excludedArtistIds: string[];
    excludedGenres: string[];
    postponedTrackIds: string[];
}> {
    const controls = await prisma.userRecControls.findUnique({ where: { userId } });
    if (controls) return controls;

    // Create defaults
    const created = await prisma.userRecControls.create({
        data: { userId },
    });
    return created;
}

/**
 * Update user recommendation controls.
 */
export async function updateUserControls(
    userId: string,
    updates: {
        allowExplicit?: boolean;
        addExcludedTrackIds?: string[];
        removeExcludedTrackIds?: string[];
        addExcludedArtistIds?: string[];
        removeExcludedArtistIds?: string[];
        addExcludedGenres?: string[];
        removeExcludedGenres?: string[];
        addPostponedTrackIds?: string[];
        removePostponedTrackIds?: string[];
    }
): Promise<void> {
    const current = await getUserControls(userId);

    const merge = (current: string[], add?: string[], remove?: string[]): string[] => {
        const set = new Set(current);
        if (add) for (const id of add) set.add(id);
        if (remove) for (const id of remove) set.delete(id);
        return Array.from(set);
    };

    await prisma.userRecControls.upsert({
        where: { userId },
        create: {
            userId,
            allowExplicit: updates.allowExplicit ?? current.allowExplicit,
            excludedTrackIds: merge(current.excludedTrackIds, updates.addExcludedTrackIds, updates.removeExcludedTrackIds),
            excludedArtistIds: merge(current.excludedArtistIds, updates.addExcludedArtistIds, updates.removeExcludedArtistIds),
            excludedGenres: merge(current.excludedGenres, updates.addExcludedGenres, updates.removeExcludedGenres),
            postponedTrackIds: merge(current.postponedTrackIds, updates.addPostponedTrackIds, updates.removePostponedTrackIds),
        },
        update: {
            allowExplicit: updates.allowExplicit ?? current.allowExplicit,
            excludedTrackIds: merge(current.excludedTrackIds, updates.addExcludedTrackIds, updates.removeExcludedTrackIds),
            excludedArtistIds: merge(current.excludedArtistIds, updates.addExcludedArtistIds, updates.removeExcludedArtistIds),
            excludedGenres: merge(current.excludedGenres, updates.addExcludedGenres, updates.removeExcludedGenres),
            postponedTrackIds: merge(current.postponedTrackIds, updates.addPostponedTrackIds, updates.removePostponedTrackIds),
        },
    });
}

/**
 * Check if a track should be filtered based on user controls.
 */
export function shouldFilterTrack(
    track: { id: string; artistId?: string; lastfmTags?: string[]; essentiaGenres?: string[] },
    controls: Awaited<ReturnType<typeof getUserControls>>,
    positiveTrackIds?: Set<string>
): boolean {
    if (positiveTrackIds?.has(track.id)) return true;

    if (controls.excludedTrackIds.includes(track.id)) return true;
    if (controls.postponedTrackIds.includes(track.id)) return true;

    if (track.artistId && controls.excludedArtistIds.includes(track.artistId)) return true;

    const genres = [...(track.lastfmTags || []), ...(track.essentiaGenres || [])];
    for (const genre of genres) {
        if (controls.excludedGenres.some(g => g.toLowerCase() === genre.toLowerCase())) return true;
    }

    return false;
}
