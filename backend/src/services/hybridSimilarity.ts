import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";

export interface ScoreBreakdown {
    clap: number;
    energy: number;
    valence: number;
    arousal: number;
    bpm: number;
    danceability: number;
    acousticness: number;
    instrumentalness: number;
    key: number;
    popularity: number;
    exploration: number;
    diversity: number;
    final: number;
}

export interface SimilarTrack {
    id: string;
    title: string;
    distance: number;
    similarity: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    reason: string;
    scoreBreakdown: ScoreBreakdown;
    popularity: number;
}

// ── Calibrated feature importance weights (from Spotify reference engine) ──
// Higher = more important for similarity perception.
// These replace the flat weights with empirically-tuned values.
const FEATURE_IMPORTANCE: Record<string, number> = {
    danceability: 1.12,
    energy:       1.18,
    loudness:     0.78,
    speechiness:  0.72,
    acousticness: 1.02,
    instrumentalness: 0.82,
    liveness:     0.44,
    valence:      1.08,
    tempo:        0.92,
};

// Normalized hybrid weights: CLAP 55%, features 45% (importance-weighted)
// Feature weights are proportional to FEATURE_IMPORTANCE, normalized to sum to 0.45
const HYBRID_WEIGHTS = (() => {
    const clap = 0.55;
    const featureBudget = 0.45;
    const used = ["energy", "valence", "arousal", "bpm", "danceability", "acousticness", "instrumentalness", "key"];
    const importanceMap: Record<string, number> = {
        energy: 1.18, valence: 1.08, arousal: 0.92, bpm: 0.92,
        danceability: 1.12, acousticness: 1.02, instrumentalness: 0.82, key: 0.20,
    };
    const totalImportance = used.reduce((s, f) => s + importanceMap[f], 0);
    const features: Record<string, number> = {};
    for (const f of used) {
        features[f] = featureBudget * (importanceMap[f] / totalImportance);
    }
    return { clap, features };
})();

// Features-only weights (normalized importance-weighted, sum to 1.0)
const FEATURES_ONLY_WEIGHTS = (() => {
    const used = ["energy", "valence", "arousal", "bpm", "danceability", "acousticness", "instrumentalness", "key"];
    const importanceMap: Record<string, number> = {
        energy: 1.18, valence: 1.08, arousal: 0.92, bpm: 0.92,
        danceability: 1.12, acousticness: 1.02, instrumentalness: 0.82, key: 0.20,
    };
    const totalImportance = used.reduce((s, f) => s + importanceMap[f], 0);
    const weights: Record<string, number> = {};
    for (const f of used) {
        weights[f] = importanceMap[f] / totalImportance;
    }
    return weights;
})();

// ── Diversity (MMR-style) ──
// Lambda balances relevance vs. diversity: 0.7 = mostly relevant with some diversity
const DIVERSITY_LAMBDA = 0.7;

// ── Popularity scoring ──
// Comfort mode: prefer popular tracks. Discovery mode: prefer mid-tail. Default: blend.
type PopularityMode = "comfort" | "discovery" | "balanced";

function popularityFit(popularity: number, mode: PopularityMode = "balanced"): number {
    const p = Math.max(0, Math.min(1, popularity));
    switch (mode) {
        case "comfort":
            return Math.max(0, Math.min(1, 0.35 + 0.65 * p));
        case "discovery":
            return Math.max(0, Math.min(1, 1 - Math.abs(p - 0.52) * 1.25));
        default: {
            const familiarity = p;
            const midTail = Math.max(0, Math.min(1, 1 - Math.abs(p - 0.62) * 1.15));
            return Math.max(0, Math.min(1, 0.55 * familiarity + 0.45 * midTail));
        }
    }
}

// ── Exploration score ──
// Rewards tracks at a calibrated distance from the seed (not too similar, not too different)
const EXPLORATION_TARGET = 0.22; // ideal distance from seed for exploration

function explorationScore(distance: number, mode: PopularityMode = "balanced"): number {
    let target = EXPLORATION_TARGET;
    if (mode === "discovery") target = Math.max(target, 0.34);
    if (mode === "comfort") target = Math.min(target, 0.10);
    return Math.max(0, Math.min(1, 1 - Math.abs(distance - target)));
}

// ── Recommendation explanations ──
function generateReason(
    clapScore: number,
    featureScore: number,
    explorationScore: number,
    hasAudioFeatures: boolean
): string {
    if (!hasAudioFeatures) {
        return "matched by embedding similarity while audio features were limited";
    }
    if (explorationScore >= 0.82 && clapScore >= 0.58) {
        return "close enough to your taste profile while adding useful variety";
    }
    if (clapScore >= 0.78) {
        return "audio features closely match your current taste profile";
    }
    if (featureScore >= 0.65) {
        return "matched by genre, energy, and mood signals";
    }
    return "balanced recommendation from taste, diversity, and popularity signals";
}

// ── MMR-style diversity re-ranking ──
function diversify(
    candidates: SimilarTrack[],
    limit: number,
    lambda: number = DIVERSITY_LAMBDA
): SimilarTrack[] {
    if (candidates.length <= limit) return candidates;

    const selected: SimilarTrack[] = [];
    const remaining = [...candidates];

    while (selected.length < limit && remaining.length > 0) {
        let bestIndex = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            // Diversity = minimum distance to any already-selected track (1 = very different)
            const diversity = minDistanceToSelected(candidate, selected);
            const score = lambda * candidate.similarity + (1 - lambda) * diversity;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        const chosen = remaining.splice(bestIndex, 1)[0];
        chosen.scoreBreakdown.diversity = minDistanceToSelected(chosen, selected);
        selected.push(chosen);
    }

    return selected;
}

function minDistanceToSelected(candidate: SimilarTrack, selected: SimilarTrack[]): number {
    if (selected.length === 0) return 1;
    let minDist = Infinity;
    for (const s of selected) {
        // Same artist = very similar (low distance)
        if (s.artistId === candidate.artistId) {
            minDist = Math.min(minDist, 0.12);
        }
        // Same album = extremely similar
        if (s.albumId === candidate.albumId) {
            minDist = Math.min(minDist, 0.05);
        }
        // Use CLAP distance as a proxy for feature distance
        const dist = Math.abs(candidate.distance - s.distance);
        minDist = Math.min(minDist, Math.max(0, Math.min(1, dist)));
    }
    return minDist;
}

// ── Main entry point ──

export interface SimilarityOptions {
    limit?: number;
    popularityMode?: PopularityMode;
    enableDiversity?: boolean;
    enableExploration?: boolean;
    excludedTrackIds?: string[];
    excludedArtistIds?: string[];
}

export async function findSimilarTracks(
    trackId: string,
    limit: number = 20,
    options: SimilarityOptions = {}
): Promise<SimilarTrack[]> {
    const {
        popularityMode = "balanced",
        enableDiversity = true,
        enableExploration = true,
        excludedTrackIds = [],
        excludedArtistIds = [],
    } = options;

    const features = await featureDetection.getFeatures();

    let results: SimilarTrack[];

    if (features.vibeEmbeddings && features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using hybrid mode for track ${trackId}`);
        results = await findSimilarHybrid(trackId, limit, options);
    } else if (features.vibeEmbeddings && !features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using CLAP-only mode for track ${trackId}`);
        results = await findSimilarClapOnly(trackId, limit, options);
    } else if (features.musicCNN && !features.vibeEmbeddings) {
        logger.debug(`[HYBRID-SIMILARITY] Using features-only mode for track ${trackId}`);
        results = await findSimilarFeaturesOnly(trackId, limit, options);
    } else {
        logger.warn("[HYBRID-SIMILARITY] No similarity features available");
        return [];
    }

    // Filter excluded tracks/artists
    const excludedTrackSet = new Set(excludedTrackIds);
    const excludedArtistSet = new Set(excludedArtistIds);
    results = results.filter(r => !excludedTrackSet.has(r.id) && !excludedArtistSet.has(r.artistId));

    // Apply diversity re-ranking
    if (enableDiversity && results.length > limit) {
        results = diversify(results, limit);
    }

    // Assign ranks
    for (let i = 0; i < results.length; i++) {
        results[i].similarity = Math.round(results[i].similarity * 10000) / 10000;
        results[i].scoreBreakdown.final = results[i].similarity;
    }

    return results;
}

// ── Internal query functions ──

async function findSimilarHybrid(
    trackId: string,
    limit: number,
    options: SimilarityOptions = {}
): Promise<SimilarTrack[]> {
    const { popularityMode = "balanced", enableExploration = true } = options;
    // Fetch 5x candidates from CLAP to ensure good coverage after re-ranking
    const candidateMultiplier = 5;

    const results = await prisma.$queryRaw<any[]>`
        WITH source AS (
            SELECT
                te.embedding,
                t.energy, t.valence, t.arousal, t.bpm, t."danceabilityMl",
                t.acousticness, t.instrumentalness, t.key, t."keyScale",
                t.popularity
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            WHERE te.track_id = ${trackId}
        ),
        clap_candidates AS (
            SELECT
                te.track_id,
                te.embedding <=> (SELECT embedding FROM source) as clap_dist,
                GREATEST(0, 1 - (te.embedding <=> (SELECT embedding FROM source))) as clap_sim
            FROM track_embeddings te
            WHERE te.track_id != ${trackId}
            ORDER BY te.embedding <=> (SELECT embedding FROM source)
            LIMIT ${limit * candidateMultiplier}
        )
        SELECT
            t.id,
            t.title,
            c.clap_dist as distance,
            (
                ${HYBRID_WEIGHTS.clap} * c.clap_sim +
                ${HYBRID_WEIGHTS.features.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                ${HYBRID_WEIGHTS.features.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                ${HYBRID_WEIGHTS.features.arousal} * (1 - ABS(COALESCE(t.arousal, 0.5) - COALESCE(s.arousal, 0.5))) +
                ${HYBRID_WEIGHTS.features.bpm} * bpm_similarity(t.bpm, s.bpm) +
                ${HYBRID_WEIGHTS.features.danceability} * (1 - ABS(COALESCE(t."danceabilityMl", 0.5) - COALESCE(s."danceabilityMl", 0.5))) +
                ${HYBRID_WEIGHTS.features.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                ${HYBRID_WEIGHTS.features.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                ${HYBRID_WEIGHTS.features.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
            ) as similarity,
            GREATEST(0, 1 - c.clap_dist) as clap_score,
            (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) as f_energy,
            (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) as f_valence,
            (1 - ABS(COALESCE(t.arousal, 0.5) - COALESCE(s.arousal, 0.5))) as f_arousal,
            bpm_similarity(t.bpm, s.bpm) as f_bpm,
            (1 - ABS(COALESCE(t."danceabilityMl", 0.5) - COALESCE(s."danceabilityMl", 0.5))) as f_danceability,
            (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) as f_acousticness,
            (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) as f_instrumentalness,
            key_similarity(t.key, t."keyScale", s.key, s."keyScale") as f_key,
            COALESCE(t.popularity, 0) as popularity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM clap_candidates c
        JOIN "Track" t ON c.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        ORDER BY similarity DESC
        LIMIT ${limit * 2}
    `;

    return results.map((r: any) => {
        const pop = (r.popularity || 0) / 100;
        const popScore = popularityFit(pop, popularityMode);
        const explScore = enableExploration ? explorationScore(r.distance, popularityMode) : 0;
        const hasAudio = r.f_energy > 0 || r.f_valence > 0;

        // Blend popularity (5%) and exploration (10%) into final score
        const finalSim = r.similarity * 0.85 + popScore * 0.05 + explScore * 0.10;

        return {
            id: r.id,
            title: r.title,
            distance: r.distance,
            similarity: finalSim,
            albumId: r.albumId,
            albumTitle: r.albumTitle,
            albumCoverUrl: r.albumCoverUrl,
            artistId: r.artistId,
            artistName: r.artistName,
            popularity: pop,
            reason: generateReason(r.clap_score, r.similarity, explScore, hasAudio),
            scoreBreakdown: {
                clap: r.clap_score || 0,
                energy: r.f_energy || 0,
                valence: r.f_valence || 0,
                arousal: r.f_arousal || 0,
                bpm: r.f_bpm || 0,
                danceability: r.f_danceability || 0,
                acousticness: r.f_acousticness || 0,
                instrumentalness: r.f_instrumentalness || 0,
                key: r.f_key || 0,
                popularity: popScore,
                exploration: explScore,
                diversity: 0,
                final: finalSim,
            },
        };
    });
}

async function findSimilarClapOnly(
    trackId: string,
    limit: number,
    options: SimilarityOptions = {}
): Promise<SimilarTrack[]> {
    const { popularityMode = "balanced", enableExploration = true } = options;

    const results = await prisma.$queryRaw<any[]>`
        WITH source AS (
            SELECT embedding FROM track_embeddings WHERE track_id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            te.embedding <=> (SELECT embedding FROM source) as distance,
            GREATEST(0, 1 - (te.embedding <=> (SELECT embedding FROM source))) as similarity,
            COALESCE(t.popularity, 0) as popularity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE te.track_id != ${trackId}
        ORDER BY distance
        LIMIT ${limit * 2}
    `;

    return results.map((r: any) => {
        const pop = (r.popularity || 0) / 100;
        const popScore = popularityFit(pop, popularityMode);
        const explScore = enableExploration ? explorationScore(r.distance, popularityMode) : 0;
        const clapSim = r.similarity;
        const finalSim = clapSim * 0.85 + popScore * 0.05 + explScore * 0.10;

        return {
            id: r.id,
            title: r.title,
            distance: r.distance,
            similarity: finalSim,
            albumId: r.albumId,
            albumTitle: r.albumTitle,
            albumCoverUrl: r.albumCoverUrl,
            artistId: r.artistId,
            artistName: r.artistName,
            popularity: pop,
            reason: generateReason(clapSim, 0, explScore, false),
            scoreBreakdown: {
                clap: clapSim,
                energy: 0, valence: 0, arousal: 0, bpm: 0,
                danceability: 0, acousticness: 0, instrumentalness: 0, key: 0,
                popularity: popScore,
                exploration: explScore,
                diversity: 0,
                final: finalSim,
            },
        };
    });
}

async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number,
    options: SimilarityOptions = {}
): Promise<SimilarTrack[]> {
    const { popularityMode = "balanced", enableExploration = true } = options;

    const results = await prisma.$queryRaw<any[]>`
        WITH source AS (
            SELECT energy, valence, arousal, bpm, "danceabilityMl", acousticness, instrumentalness, key, "keyScale", popularity
            FROM "Track"
            WHERE id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            0 as distance,
            (
                ${FEATURES_ONLY_WEIGHTS.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.arousal} * (1 - ABS(COALESCE(t.arousal, 0.5) - COALESCE(s.arousal, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.bpm} * bpm_similarity(t.bpm, s.bpm) +
                ${FEATURES_ONLY_WEIGHTS.danceability} * (1 - ABS(COALESCE(t."danceabilityMl", 0.5) - COALESCE(s."danceabilityMl", 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
            ) as similarity,
            (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) as f_energy,
            (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) as f_valence,
            (1 - ABS(COALESCE(t.arousal, 0.5) - COALESCE(s.arousal, 0.5))) as f_arousal,
            bpm_similarity(t.bpm, s.bpm) as f_bpm,
            (1 - ABS(COALESCE(t."danceabilityMl", 0.5) - COALESCE(s."danceabilityMl", 0.5))) as f_danceability,
            (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) as f_acousticness,
            (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) as f_instrumentalness,
            key_similarity(t.key, t."keyScale", s.key, s."keyScale") as f_key,
            COALESCE(t.popularity, 0) as popularity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM "Track" t
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        WHERE t.id != ${trackId}
        ORDER BY similarity DESC
        LIMIT ${limit * 2}
    `;

    return results.map((r: any) => {
        const pop = (r.popularity || 0) / 100;
        const popScore = popularityFit(pop, popularityMode);
        const explScore = enableExploration ? explorationScore(r.distance || 0, popularityMode) : 0;
        const finalSim = r.similarity * 0.85 + popScore * 0.05 + explScore * 0.10;

        return {
            id: r.id,
            title: r.title,
            distance: r.distance || 0,
            similarity: finalSim,
            albumId: r.albumId,
            albumTitle: r.albumTitle,
            albumCoverUrl: r.albumCoverUrl,
            artistId: r.artistId,
            artistName: r.artistName,
            popularity: pop,
            reason: generateReason(0, r.similarity, explScore, true),
            scoreBreakdown: {
                clap: 0,
                energy: r.f_energy || 0,
                valence: r.f_valence || 0,
                arousal: r.f_arousal || 0,
                bpm: r.f_bpm || 0,
                danceability: r.f_danceability || 0,
                acousticness: r.f_acousticness || 0,
                instrumentalness: r.f_instrumentalness || 0,
                key: r.f_key || 0,
                popularity: popScore,
                exploration: explScore,
                diversity: 0,
                final: finalSim,
            },
        };
    });
}
