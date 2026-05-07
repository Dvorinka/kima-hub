import { prisma } from "../utils/db";
import { InteractionType } from "@prisma/client";

export interface TasteProfile {
  genres: Record<string, number>;
  artists: Record<string, number>;
  audioFeatures: {
    energy: number;
    valence: number;
    danceability: number;
    acousticness: number;
  };
}

export interface RecommendationResult {
  trackId: string;
  score: number;
  reason: string;
}

export const recommendationService = {
  /**
   * Track user interaction for taste profiling
   */
  async trackInteraction(
    userId: string,
    trackId: string,
    type: InteractionType,
    completedMs?: number
  ): Promise<void> {
    const weight = this.calculateInteractionWeight(type, completedMs);
    
    await prisma.interaction.create({
      data: {
        userId,
        trackId,
        type,
        weight,
        completedMs,
        occurredAt: new Date(),
      },
    });

    // Update taste profile asynchronously
    this.updateTasteProfile(userId);
  },

  /**
   * Calculate weight for different interaction types
   */
  calculateInteractionWeight(type: InteractionType, completedMs?: number): number {
    const baseWeights: Record<InteractionType, number> = {
      [InteractionType.PLAY]: 1.0,
      [InteractionType.SKIP]: -0.5,
      [InteractionType.LIKE]: 2.0,
      [InteractionType.DISLIKE]: -2.0,
      [InteractionType.SAVE]: 1.5,
      [InteractionType.HIDE]: -1.0,
    };

    let weight = baseWeights[type];

    // Adjust weight for play completion
    if (type === InteractionType.PLAY && completedMs) {
      // Full listen = 1.0, partial = scaled
      // Assume average track length ~3.5 minutes (210000ms)
      const completionRatio = Math.min(completedMs / 210000, 1.0);
      weight *= (0.5 + 0.5 * completionRatio);
    }

    return weight;
  },

  /**
   * Update user taste profile based on recent interactions
   */
  async updateTasteProfile(userId: string): Promise<void> {
    const interactions = await prisma.interaction.findMany({
      where: { userId },
      include: {
        track: {
          include: {
            album: {
              include: { artist: true },
            },
            trackGenres: {
              include: { genre: true },
            },
          },
        },
      },
      orderBy: { occurredAt: "desc" },
      take: 1000,
    });

    if (interactions.length === 0) return;

    // Calculate genre preferences
    const genreScores: Record<string, number> = {};
    const artistScores: Record<string, number> = {};
    let totalEnergy = 0;
    let totalValence = 0;
    let totalDanceability = 0;
    let totalAcousticness = 0;
    let weightedCount = 0;

    for (const interaction of interactions) {
      const weight = interaction.weight || 0;
      if (weight === 0) continue;

      const track = interaction.track;

      // Genre scores
      for (const tg of track.trackGenres) {
        genreScores[tg.genre.name] = (genreScores[tg.genre.name] || 0) + weight;
      }

      // Artist scores
      const artistName = track.album.artist.name;
      artistScores[artistName] = (artistScores[artistName] || 0) + weight;

      // Audio features (weighted average)
      if (track.energy !== null) {
        totalEnergy += track.energy * weight;
      }
      if (track.valence !== null) {
        totalValence += track.valence * weight;
      }
      if (track.danceability !== null) {
        totalDanceability += track.danceability * weight;
      }
      if (track.acousticness !== null) {
        totalAcousticness += track.acousticness * weight;
      }

      weightedCount += Math.abs(weight);
    }

    // Normalize scores
    const totalWeight = weightedCount || 1;
    const normalizedGenres: Record<string, number> = {};
    for (const [genre, score] of Object.entries(genreScores)) {
      normalizedGenres[genre] = score / totalWeight;
    }

    const normalizedArtists: Record<string, number> = {};
    for (const [artist, score] of Object.entries(artistScores)) {
      normalizedArtists[artist] = score / totalWeight;
    }

    const audioFeatures = {
      energy: totalEnergy / totalWeight,
      valence: totalValence / totalWeight,
      danceability: totalDanceability / totalWeight,
      acousticness: totalAcousticness / totalWeight,
    };

    // Calculate exploration readiness (how much user likes new things)
    const explorationReadiness = this.calculateExplorationReadiness(interactions);

    // Create/update taste profile
    const existingProfile = await prisma.userTasteProfile.findUnique({
      where: { userId },
    });

    const profileData = {
      vector: {
        genres: normalizedGenres,
        artists: normalizedArtists,
        audioFeatures,
      },
      topGenres: normalizedGenres,
      interactionCount: interactions.length,
      confidence: Math.min(interactions.length / 100, 1.0),
      explorationReadiness,
    };

    if (existingProfile) {
      await prisma.userTasteProfile.update({
        where: { userId },
        data: profileData,
      });
    } else {
      await prisma.userTasteProfile.create({
        data: {
          userId,
          ...profileData,
        },
      });
    }
  },

  /**
   * Calculate exploration readiness based on interaction patterns
   */
  calculateExplorationReadiness(interactions: any[]): number {
    if (interactions.length < 10) return 0.5;

    // Count unique artists in recent interactions
    const uniqueArtists = new Set(
      interactions.map((i) => i.track?.album?.artist?.name).filter(Boolean)
    ).size;
    const artistDiversity = uniqueArtists / Math.min(interactions.length, 50);

    // Count likes vs total positive interactions
    const likes = interactions.filter((i) => i.type === InteractionType.LIKE).length;
    const positive = interactions.filter((i) => i.weight && i.weight > 0).length;
    const likeRatio = positive > 0 ? likes / positive : 0;

    // Combine metrics
    return (artistDiversity * 0.6 + likeRatio * 0.4);
  },

  /**
   * Get user's taste profile
   */
  async getTasteProfile(userId: string): Promise<TasteProfile | null> {
    const profile = await prisma.userTasteProfile.findUnique({
      where: { userId },
    });

    if (!profile) return null;

    const vector = profile.vector as any;
    return {
      genres: vector.genres || {},
      artists: vector.artists || {},
      audioFeatures: vector.audioFeatures || {
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        acousticness: 0.5,
      },
    };
  },

  /**
   * Calculate similarity between two taste profiles
   */
  calculateSimilarity(profile1: TasteProfile, profile2: TasteProfile): number {
    let genreSimilarity = 0;
    let genreCount = 0;

    const allGenres = new Set([
      ...Object.keys(profile1.genres),
      ...Object.keys(profile2.genres),
    ]);

    for (const genre of allGenres) {
      const score1 = profile1.genres[genre] || 0;
      const score2 = profile2.genres[genre] || 0;
      genreSimilarity += 1 - Math.abs(score1 - score2);
      genreCount++;
    }

    genreSimilarity = genreCount > 0 ? genreSimilarity / genreCount : 0;

    // Audio feature similarity
    const audioSim =
      1 -
      (Math.abs(profile1.audioFeatures.energy - profile2.audioFeatures.energy) +
        Math.abs(profile1.audioFeatures.valence - profile2.audioFeatures.valence) +
        Math.abs(
          profile1.audioFeatures.danceability - profile2.audioFeatures.danceability
        ) +
        Math.abs(
          profile1.audioFeatures.acousticness - profile2.audioFeatures.acousticness
        )) /
        4;

    return (genreSimilarity * 0.7 + audioSim * 0.3);
  },

  /**
   * Get recommendation settings for user
   */
  async getRecommendationSettings(userId: string) {
    const controls = await prisma.userRecControls.findUnique({
      where: { userId },
    });

    const systemSettings = await prisma.systemSettings.findUnique({
      where: { id: "default" },
    });

    return {
      mode: systemSettings?.recommendationMode || "balanced",
      excludedArtists: controls?.excludedArtistIds || [],
      excludedGenres: controls?.excludedGenres || [],
      excludedTrackIds: controls?.excludedTrackIds || [],
    };
  },

  /**
   * Generate recommendations for user
   */
  async generateRecommendations(
    userId: string,
    limit: number = 20
  ): Promise<RecommendationResult[]> {
    const [tasteProfile, settings] = await Promise.all([
      this.getTasteProfile(userId),
      this.getRecommendationSettings(userId),
    ]);

    if (!tasteProfile) {
      // No taste data, return random recommendations
      return this.getRandomRecommendations(userId, limit, settings);
    }

    // Get candidate tracks (not in library, not excluded)
    const excludedTrackIds = settings.excludedTrackIds || [];
    const candidateTracks = await prisma.track.findMany({
      where: {
        id: { notIn: excludedTrackIds },
        album: {
          artist: {
            name: { notIn: settings.excludedArtists as string[] },
          },
        },
      },
      include: {
        album: {
          include: { artist: true },
        },
        trackGenres: {
          include: { genre: true },
        },
      },
      take: limit * 5, // Get more candidates to rank
    });

    // Score candidates
    const scored = candidateTracks.map((track) => {
      const trackProfile: TasteProfile = {
        genres: {},
        artists: { [track.album.artist.name]: 1 },
        audioFeatures: {
          energy: track.energy || 0.5,
          valence: track.valence || 0.5,
          danceability: track.danceability || 0.5,
          acousticness: track.acousticness || 0.5,
        },
      };

      // Build genre profile for track
      for (const tg of track.trackGenres) {
        trackProfile.genres[tg.genre.name] = 1;
      }

      const similarity = this.calculateSimilarity(tasteProfile, trackProfile);
      
      // Apply mode-specific adjustments
      let adjustedScore = similarity;
      const mode = settings.mode;

      if (mode === "comfort") {
        // Boost similar items
        adjustedScore = similarity * 1.2;
      } else if (mode === "discovery") {
        // Boost diverse items, reduce similarity penalty
        adjustedScore = 0.3 + similarity * 0.4;
      }
      // balanced = no adjustment

      return {
        trackId: track.id,
        score: adjustedScore,
        reason: mode === "comfort" ? "Similar to your taste" : 
                mode === "discovery" ? "New discovery" :
                "Matched to your preferences",
      };
    });

    // Sort and apply MMR-style diversity
    const diversityFactor = settings.mode === "discovery" ? 0.7 : 
                          settings.mode === "comfort" ? 0.3 : 0.5;
    
    const diversified = this.applyMMRDiversity(scored, diversityFactor);

    // Return top N
    return diversified
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },

  /**
   * Apply Maximal Marginal Relevance (MMR) for diversity
   */
  applyMMRDiversity(
    candidates: RecommendationResult[],
    lambda: number
  ): RecommendationResult[] {
    if (candidates.length === 0) return [];

    const selected: RecommendationResult[] = [];
    const remaining = [...candidates];

    // Select first item (highest score)
    remaining.sort((a, b) => b.score - a.score);
    selected.push(remaining.shift()!);

    while (remaining.length > 0 && selected.length < candidates.length) {
      let bestIndex = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        
        // Calculate relevance to selected items (simplified - using score diff)
        let maxSimilarityToSelected = 0;
        for (const sel of selected) {
          const similarity = 1 - Math.abs(candidate.score - sel.score);
          maxSimilarityToSelected = Math.max(maxSimilarityToSelected, similarity);
        }

        // MMR score: lambda * relevance - (1 - lambda) * similarity
        const mmrScore = lambda * candidate.score - (1 - lambda) * maxSimilarityToSelected;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = i;
        }
      }

      selected.push(remaining.splice(bestIndex, 1)[0]);
    }

    return selected;
  },

  /**
   * Get random recommendations (fallback when no taste data)
   */
  async getRandomRecommendations(
    userId: string,
    limit: number,
    settings: any
  ): Promise<RecommendationResult[]> {
    const tracks = await prisma.track.findMany({
      where: {
        id: { notIn: settings.excludedTrackIds || [] },
        album: {
          artist: {
            name: { notIn: settings.excludedArtists as string[] },
          },
        },
      },
      include: {
        album: { include: { artist: true } },
      },
      take: limit,
      orderBy: { id: "desc" },
    });

    return tracks.map((track: any) => ({
      trackId: track.id,
      score: Math.random() * 0.5,
      reason: "Random selection",
    }));
  },
};
