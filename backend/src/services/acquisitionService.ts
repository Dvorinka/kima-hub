/**
 * Unified Acquisition Service
 *
 * Consolidates album/track acquisition logic from Discovery Weekly and Playlist Import.
 * Handles download source selection, behavior matrix routing, and job tracking.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { soulseekService } from "./soulseek";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { musicBrainzService } from "./musicbrainz";
import { lastFmService } from "./lastfm";
import { AcquisitionError, AcquisitionErrorType } from "./lidarr";
import { spotiflacService } from "./spotiflac";
import { distributedLock } from "../utils/distributedLock";
import PQueue from "p-queue";
import { downloadJobsTotal, downloadJobDuration, activeDownloads } from "../utils/metrics";
import {
  UserFacingError,
  IntegrationError,
  ConfigurationError,
} from '../utils/errors';

/**
 * Context for tracking acquisition origin
 * Used to link download jobs to their source (Discovery batch or Spotify import)
 */
export interface AcquisitionContext {
    userId: string;
    discoveryBatchId?: string;
    spotifyImportJobId?: string;
    existingJobId?: string;
    retryCount?: number;
    signal?: AbortSignal;
}

/**
 * Request to acquire an album
 */
export interface AlbumAcquisitionRequest {
    albumTitle: string;
    artistName: string;
    mbid?: string;
    lastfmUrl?: string;
    spotifyAlbumId?: string;
    spotifyArtistId?: string;
    requestedTracks?: Array<{ title: string; position?: number }>;
}

/**
 * Request to acquire individual tracks (for Unknown Album case)
 */
export interface TrackAcquisitionRequest {
    trackTitle: string;
    artistName: string;
    albumTitle?: string;
}

/**
 * Result of an acquisition attempt
 */
export interface AcquisitionResult {
    success: boolean;
    downloadJobId?: string;
    source?: "soulseek" | "lidarr" | "spotiflac";
    error?: string;
    errorType?: AcquisitionErrorType;
    isRecoverable?: boolean;
    tracksDownloaded?: number;
    tracksTotal?: number;
    correlationId?: string;
}

/**
 * Download behavior matrix configuration
 */
interface DownloadBehavior {
    hasPrimarySource: boolean;
    primarySource: "soulseek" | "lidarr" | "spotiflac" | null;
    hasFallbackSource: boolean;
    fallbackSource: "soulseek" | "lidarr" | "spotiflac" | null;
}

class AcquisitionService {
    private albumQueue: PQueue;
    private lastConcurrency: number = 4;

    constructor() {
        // Initialize album queue with default concurrency (will be updated from settings)
        this.albumQueue = new PQueue({ concurrency: 4 });
        logger.debug(
            "[Acquisition] Initialized album queue with default concurrency=4"
        );
    }

    /**
     * Update album queue concurrency from user settings
     * Called before processing to ensure settings are respected
     */
    private async updateQueueConcurrency(): Promise<void> {
        const settings = await getSystemSettings();
        const concurrency = settings?.soulseekConcurrentDownloads ?? 1;

        if (concurrency !== this.lastConcurrency) {
            this.albumQueue.concurrency = concurrency;
            this.lastConcurrency = concurrency;
            logger.debug(
                `[Acquisition] Updated album queue concurrency to ${concurrency}`
            );
        }
    }

    /**
     * Get download behavior configuration (settings + service availability)
     * Auto-detects and selects download source based on actual availability
     */
    private async getDownloadBehavior(): Promise<DownloadBehavior> {
        const settings = await getSystemSettings();

        // Get download source settings
        const downloadSource = settings?.downloadSource || "soulseek";
        const primaryFailureFallback = settings?.primaryFailureFallback;

        // Determine actual availability
        const hasSoulseek = await soulseekService.isAvailable();
        const hasLidarr = !!(
            settings?.lidarrEnabled &&
            settings?.lidarrUrl &&
            settings?.lidarrApiKey
        );
        const hasSpotiFLAC = settings?.spotiflacEnabled && await spotiflacService.isAvailable();

        // Get available sources array
        const availableSources: ("soulseek" | "lidarr" | "spotiflac")[] = [];
        if (hasSoulseek) availableSources.push("soulseek");
        if (hasLidarr) availableSources.push("lidarr");
        if (hasSpotiFLAC) availableSources.push("spotiflac");

        // Case 1: No sources available
        if (availableSources.length === 0) {
            logger.error("[Acquisition] No download sources configured");
            return {
                hasPrimarySource: false,
                primarySource: null,
                hasFallbackSource: false,
                fallbackSource: null,
            };
        }

        // Case 2: Only one source available - use it regardless of preference
        if (availableSources.length === 1) {
            const onlySource = availableSources[0];
            logger.debug(`[Acquisition] Source config: primary=${onlySource}, fallback=none (only source)`);
            return {
                hasPrimarySource: true,
                primarySource: onlySource,
                hasFallbackSource: false,
                fallbackSource: null,
            };
        }

        // Case 3: Multiple sources available - respect user preference for primary
        // Handle legacy values that might not include "spotiflac"
        const validSources: ("soulseek" | "lidarr" | "spotiflac")[] = ["soulseek", "lidarr", "spotiflac"];
        const userPrimary = validSources.includes(downloadSource as any) 
            ? downloadSource as "soulseek" | "lidarr" | "spotiflac"
            : "soulseek";
            
        // Check if user's preferred source is available
        const primaryAvailable = availableSources.includes(userPrimary);
        
        // Find fallback candidates (sources that are available but not the primary)
        const fallbackCandidates = availableSources.filter(s => s !== userPrimary);
        const alternative = fallbackCandidates.length > 0 ? fallbackCandidates[0] : null;

        // Auto-enable fallback if multiple sources are configured and no explicit setting
        let useFallback = primaryFailureFallback !== "none" && 
                         alternative !== null &&
                         primaryFailureFallback === alternative;

        // Only auto-enable fallback if the setting is truly undefined/null (first-time users)
        if (!useFallback && (primaryFailureFallback === undefined || primaryFailureFallback === null) && alternative) {
            useFallback = true;
            logger.debug(
                `[Acquisition] Auto-enabled fallback: ${alternative} (multiple sources configured)`
            );
        }

        // If primary not available but fallback is, use fallback as primary
        if (!primaryAvailable && alternative) {
            logger.debug(`[Acquisition] Primary ${userPrimary} not available, using ${alternative} as primary`);
            return {
                hasPrimarySource: true,
                primarySource: alternative,
                hasFallbackSource: fallbackCandidates.length > 1,
                fallbackSource: fallbackCandidates.length > 1 ? fallbackCandidates[1] : null,
            };
        }

        logger.debug(
            `[Acquisition] Source config: primary=${userPrimary}, fallback=${useFallback && alternative ? alternative : "none"}`
        );

        return {
            hasPrimarySource: primaryAvailable,
            primarySource: userPrimary,
            hasFallbackSource: useFallback && alternative !== null,
            fallbackSource: useFallback ? alternative : null,
        };
    }

    /**
     * Update download job with source-specific status text
     * Stored in metadata for frontend display
     */
    private async updateJobStatusText(
        jobId: string,
        source: "lidarr" | "soulseek" | "spotiflac",
        attemptNumber: number
    ): Promise<void> {
        const sourceLabel = source === "spotiflac" ? "SpotiFLAC" : source.charAt(0).toUpperCase() + source.slice(1);
        const statusText = `${sourceLabel} #${attemptNumber}`;

        const job = await prisma.downloadJob.findUnique({
            where: { id: jobId },
            select: { metadata: true },
        });
        const existingMetadata = (job?.metadata as any) || {};

        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                metadata: {
                    ...existingMetadata,
                    currentSource: source,
                    lidarrAttempts:
                        source === "lidarr"
                            ? attemptNumber
                            : existingMetadata.lidarrAttempts || 0,
                    soulseekAttempts:
                        source === "soulseek"
                            ? attemptNumber
                            : existingMetadata.soulseekAttempts || 0,
                    spotiflacAttempts:
                        source === "spotiflac"
                            ? attemptNumber
                            : existingMetadata.spotiflacAttempts || 0,
                    statusText,
                },
            },
        });

        logger.debug(`[Acquisition] Updated job ${jobId}: ${statusText}`);
    }

    /**
     * Acquire an album using the configured behavior matrix
     * Routes to Soulseek or Lidarr based on settings, with fallback support
     * Queued to enable parallel album acquisition
     *
     * @param request - Album to acquire
     * @param context - Tracking context (userId, batchId, etc.)
     * @returns Acquisition result
     */
    async acquireAlbum(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        // Update queue concurrency from user settings
        await this.updateQueueConcurrency();

        // Timeout is applied INSIDE the queue callback so it only counts
        // actual processing time, not time spent waiting for a queue slot.
        const MAX_ACQUISITION_TIME = 5 * 60 * 1000; // 5 minutes
        const result = await this.albumQueue.add(async () => {
            if (context.signal?.aborted) {
                return { success: false, error: 'Import cancelled' } as AcquisitionResult;
            }

            let timeoutId: NodeJS.Timeout;
            const timeoutPromise = new Promise<AcquisitionResult>((resolve) => {
                timeoutId = setTimeout(() => {
                    resolve({
                        success: false,
                        source: undefined,
                        error: `Acquisition timed out after ${Math.round(MAX_ACQUISITION_TIME / 1000)}s - tried all available sources`,
                    });
                }, MAX_ACQUISITION_TIME);
            });

            try {
                return await Promise.race([
                    this.acquireAlbumInternal(request, context),
                    timeoutPromise,
                ]);
            } finally {
                clearTimeout(timeoutId!);
            }
        }, context.signal ? { signal: context.signal } : {});

        return result as AcquisitionResult;
    }

    /**
     * Internal album acquisition logic (called via queue)
     */
    private async acquireAlbumInternal(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        if (context.signal?.aborted) {
            return { success: false, error: 'Import cancelled' };
        }

        const startTime = Date.now();
        logger.debug(
            `\n[Acquisition] Acquiring album: ${request.artistName} - ${request.albumTitle} (queue: ${this.albumQueue.size} pending, ${this.albumQueue.pending} active)`
        );

        // Check configuration
        const soulseekAvailable = await soulseekService.isAvailable();
        const settings = await getSystemSettings();
        const lidarrAvailable = !!(
            settings?.lidarrEnabled &&
            settings?.lidarrUrl &&
            settings?.lidarrApiKey
        );
        const spotiflacAvailable = settings?.spotiflacEnabled && await spotiflacService.isAvailable();

        if (!soulseekAvailable && !lidarrAvailable && !spotiflacAvailable) {
            throw new ConfigurationError(
                'No download sources configured. Please configure Soulseek, Lidarr, or SpotiFLAC in settings.'
            );
        }

        // MBID only required when Soulseek/SpotiFLAC is unavailable (Lidarr needs it)
        if (!request.mbid && !soulseekAvailable && !spotiflacAvailable) {
            throw new UserFacingError('Album MBID is required when Soulseek and SpotiFLAC are not available', 400, 'INVALID_INPUT');
        }

        // Verify artist name before acquisition
        try {
            const correction = await lastFmService.getArtistCorrection(
                request.artistName
            );
            if (correction?.corrected) {
                logger.debug(
                    `[Acquisition] Artist corrected: "${request.artistName}" → "${correction.canonicalName}"`
                );
                request = { ...request, artistName: correction.canonicalName };
            }
        } catch (error) {
            logger.warn(
                `[Acquisition] Artist correction failed for "${request.artistName}":`,
                error
            );
        }

        // Get download behavior configuration
        const behavior = await this.getDownloadBehavior();

        // Try primary source first
        let result: AcquisitionResult;

        try {
            if (behavior.primarySource === "soulseek") {
                logger.debug(`[Acquisition] Trying primary: Soulseek`);
                result = await this.acquireAlbumViaSoulseek(request, context);

                // Fallback to other sources if Soulseek fails
                if (!result.success && behavior.hasFallbackSource) {
                    logger.debug(
                        `[Acquisition] Soulseek failed: ${result.error || "unknown error"}`
                    );
                    logger.debug(
                        `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`
                    );

                    if (behavior.fallbackSource === "lidarr" && request.mbid) {
                        logger.debug(`[Acquisition] Attempting Lidarr fallback...`);
                        result = await this.acquireAlbumViaLidarr(request, context);
                    } else if (behavior.fallbackSource === "spotiflac") {
                        logger.debug(`[Acquisition] Attempting SpotiFLAC fallback...`);
                        result = await this.acquireAlbumViaSpotiFLAC(request, context);
                    }
                }
            } else if (behavior.primarySource === "lidarr") {
                if (!request.mbid) {
                    // No MBID -- Lidarr requires it, try other sources
                    logger.info(`[Acquisition] No MBID for "${request.albumTitle}", skipping Lidarr`);
                    if (soulseekAvailable) {
                        logger.debug(`[Acquisition] Trying Soulseek instead...`);
                        result = await this.acquireAlbumViaSoulseek(request, context);
                    } else if (spotiflacAvailable) {
                        logger.debug(`[Acquisition] Trying SpotiFLAC instead...`);
                        result = await this.acquireAlbumViaSpotiFLAC(request, context);
                    } else {
                        throw new ConfigurationError("Lidarr requires MBID but no fallback source available");
                    }
                } else {
                    logger.debug(`[Acquisition] Trying primary: Lidarr`);
                    result = await this.acquireAlbumViaLidarr(request, context);

                    // Fallback to other sources if Lidarr fails
                    if (!result.success && behavior.hasFallbackSource) {
                        logger.debug(
                            `[Acquisition] Lidarr failed: ${result.error || "unknown error"}`
                        );
                        logger.debug(
                            `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`
                        );

                        if (behavior.fallbackSource === "soulseek") {
                            logger.debug(`[Acquisition] Attempting Soulseek fallback...`);
                            result = await this.acquireAlbumViaSoulseek(request, context);
                        } else if (behavior.fallbackSource === "spotiflac") {
                            logger.debug(`[Acquisition] Attempting SpotiFLAC fallback...`);
                            result = await this.acquireAlbumViaSpotiFLAC(request, context);
                        }
                    }
                }
            } else if (behavior.primarySource === "spotiflac") {
                logger.debug(`[Acquisition] Trying primary: SpotiFLAC`);
                result = await this.acquireAlbumViaSpotiFLAC(request, context);

                // Fallback to other sources if SpotiFLAC fails
                if (!result.success && behavior.hasFallbackSource) {
                    logger.debug(
                        `[Acquisition] SpotiFLAC failed: ${result.error || "unknown error"}`
                    );
                    logger.debug(
                        `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`
                    );

                    if (behavior.fallbackSource === "soulseek") {
                        logger.debug(`[Acquisition] Attempting Soulseek fallback...`);
                        result = await this.acquireAlbumViaSoulseek(request, context);
                    } else if (behavior.fallbackSource === "lidarr" && request.mbid) {
                        logger.debug(`[Acquisition] Attempting Lidarr fallback...`);
                        result = await this.acquireAlbumViaLidarr(request, context);
                    }
                }
            } else {
                // This should never happen due to validation above
                throw new ConfigurationError("No primary source configured");
            }
        } catch (error) {
            if (error instanceof IntegrationError && error.retryable) {
                // Initialize retry count
                const currentRetryCount = context.retryCount || 0;
                const maxRetries = 3;

                if (currentRetryCount < maxRetries) {
                    logger.info(`Retrying download for ${request.mbid} due to retryable error (attempt ${currentRetryCount + 1}/${maxRetries})`);
                    return await this.acquireAlbumInternal(request, { ...context, retryCount: currentRetryCount + 1 });
                } else {
                    logger.error(`Max retries (${maxRetries}) exceeded for ${request.mbid}`);
                    throw new IntegrationError(
                        `Failed after ${maxRetries} retry attempts`,
                        error.integration,
                        false
                    );
                }
            }
            throw error;
        }

        // Record metrics
        const duration = (Date.now() - startTime) / 1000;
        const source = result.source || 'unknown';
        const status = result.success ? 'success' : 'failed';

        downloadJobsTotal.inc({ source, status });
        downloadJobDuration.observe({ source, status }, duration);

        return result;
    }

    /**
     * Acquire individual tracks via Soulseek (for Unknown Album case)
     * Batch downloads tracks without album MBID
     *
     * @param requests - Tracks to acquire
     * @param context - Tracking context
     * @returns Array of acquisition results
     */
    async acquireTracks(
        requests: TrackAcquisitionRequest[],
        context: AcquisitionContext
    ): Promise<AcquisitionResult[]> {
        logger.debug(
            `\n[Acquisition] Acquiring ${requests.length} individual tracks`
        );

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            logger.error(`[Acquisition] Music path not configured`);
            return requests.map(() => ({
                success: false,
                error: "Music path not configured",
            }));
        }

        const soulseekAvailable = await soulseekService.isAvailable();
        const spotiflacAvailable = settings?.spotiflacEnabled && await spotiflacService.isAvailable();

        if (!soulseekAvailable && !spotiflacAvailable) {
            logger.error(`[Acquisition] No download sources available for track downloads`);
            return requests.map(() => ({
                success: false,
                error: "No download sources configured (Soulseek or SpotiFLAC required)",
            }));
        }

        // Phase 1: Try Soulseek batch download for all tracks
        const soulseekResults: (AcquisitionResult | null)[] = new Array(requests.length).fill(null);
        const failedIndices: number[] = [];

        if (soulseekAvailable) {
            const tracksToDownload = requests.map((req) => ({
                artist: req.artistName,
                title: req.trackTitle,
                album: req.albumTitle || "Unknown Album",
            }));

            try {
                const batchResult = await soulseekService.searchAndDownloadBatch(
                    tracksToDownload,
                    musicPath,
                    settings?.soulseekConcurrentDownloads ?? 4,
                    context.signal
                );

                logger.debug(
                    `[Acquisition] Soulseek batch: ${batchResult.successful}/${requests.length} tracks`
                );

                for (let i = 0; i < requests.length; i++) {
                    const req = requests[i];
                    const trackKey = `${req.artistName} - ${req.trackTitle}`;
                    const trackError = batchResult.errors.find((e) => e.startsWith(trackKey));
                    const success = !trackError;
                    soulseekResults[i] = {
                        success,
                        source: "soulseek" as const,
                        tracksDownloaded: success ? 1 : 0,
                        tracksTotal: 1,
                        error: trackError || undefined,
                    };
                    if (!success) failedIndices.push(i);
                }
            } catch (error: any) {
                if (error?.name === 'AbortError' || context.signal?.aborted) {
                    return requests.map(() => ({ success: false, error: 'Import cancelled' }));
                }
                logger.error(`[Acquisition] Soulseek batch error: ${error.message}`);
                // All tracks failed via Soulseek
                for (let i = 0; i < requests.length; i++) failedIndices.push(i);
            }
        } else {
            // Soulseek not available, all tracks need SpotiFLAC
            for (let i = 0; i < requests.length; i++) failedIndices.push(i);
        }

        // Phase 2: Try SpotiFLAC for failed tracks
        if (failedIndices.length > 0 && spotiflacAvailable) {
            logger.debug(`[Acquisition] Trying SpotiFLAC for ${failedIndices.length} failed tracks`);

            for (const idx of failedIndices) {
                const req = requests[idx];
                try {
                    // Strategy 1: Search Spotify by artist + track name
                    const spotifyTrackId = await spotiflacService.searchSpotifyTrack(req.artistName, req.trackTitle);

                    if (spotifyTrackId) {
                        const dlResult = await spotiflacService.downloadTrack(spotifyTrackId, {
                            outputDir: musicPath,
                            preferSource: "auto",
                        });
                        soulseekResults[idx] = {
                            success: dlResult.success,
                            source: "spotiflac" as const,
                            tracksDownloaded: dlResult.success ? 1 : 0,
                            tracksTotal: 1,
                            error: dlResult.error || undefined,
                        };
                        if (dlResult.success) continue;
                    }

                    // Strategy 2: Try ISRC lookup via MusicBrainz
                    const mbRecording = await musicBrainzService.searchRecording(req.trackTitle, req.artistName);
                    if (mbRecording?.trackMbid) {
                        const isrc = await musicBrainzService.getRecordingIsrc(mbRecording.trackMbid);
                        if (isrc) {
                            const isrcResult = await spotiflacService.downloadTrackByISRC(isrc, {
                                outputDir: musicPath,
                                preferSource: "auto",
                            });
                            soulseekResults[idx] = {
                                success: isrcResult.success,
                                source: "spotiflac" as const,
                                tracksDownloaded: isrcResult.success ? 1 : 0,
                                tracksTotal: 1,
                                error: isrcResult.error || undefined,
                            };
                            if (isrcResult.success) continue;
                        }
                    }

                    // Both strategies failed
                    if (!soulseekResults[idx]) {
                        soulseekResults[idx] = {
                            success: false,
                            error: `Track not found on Spotify, Qobuz, or Tidal`,
                        };
                    }
                } catch (e: any) {
                    logger.debug(`[Acquisition] SpotiFLAC track fallback failed: ${e.message}`);
                    if (!soulseekResults[idx]) {
                        soulseekResults[idx] = {
                            success: false,
                            error: e.message,
                        };
                    }
                }
            }
        }

        // Fill any remaining nulls with failures
        return soulseekResults.map(r => r || { success: false, error: "No download source available" });
    }

    /**
     * Acquire album via Soulseek (track-by-track download)
     * Gets track list from MusicBrainz or Last.fm, then batch downloads
     * Marks job as completed immediately (no webhook needed)
     *
     * @param request - Album to acquire
     * @param context - Tracking context
     * @returns Acquisition result
     */
    private async acquireAlbumViaSoulseek(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        logger.debug(
            `[Acquisition/Soulseek] Downloading: ${request.artistName} - ${request.albumTitle}`
        );

        // Get music path
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            return { success: false, error: "Music path not configured" };
        }

        if (!request.mbid && (!request.requestedTracks || request.requestedTracks.length === 0)) {
            return {
                success: false,
                error: "Album MBID or track list required for Soulseek download",
            };
        }

        let job: any;
        try {
            // Create download job at start for tracking
            job = await this.createDownloadJob(request, context);

            // Calculate attempt number (existing soulseek attempts + 1)
            const jobMetadata = (job.metadata as any) || {};
            const soulseekAttempts = (jobMetadata.soulseekAttempts || 0) + 1;
            await this.updateJobStatusText(
                job.id,
                "soulseek",
                soulseekAttempts
            );

            let tracks: Array<{ title: string; position?: number }>;

            // If specific tracks requested, use those instead of full album
            if (request.requestedTracks && request.requestedTracks.length > 0) {
                tracks = request.requestedTracks;
                logger.debug(
                    `[Acquisition/Soulseek] Using ${tracks.length} requested tracks (not full album)`
                );
            } else {
                // Strategy 1: Get track list from MusicBrainz (mbid guaranteed by early guard above)
                tracks = await musicBrainzService.getAlbumTracks(request.mbid!);

                // Strategy 2: Fallback to Last.fm (always try when MusicBrainz fails)
                if (!tracks || tracks.length === 0) {
                    logger.debug(
                        `[Acquisition/Soulseek] MusicBrainz has no tracks, trying Last.fm`
                    );

                    try {
                        const albumInfo = await lastFmService.getAlbumInfo(
                            request.artistName,
                            request.albumTitle
                        );
                        const lastFmTracks = albumInfo?.tracks?.track || [];

                        if (Array.isArray(lastFmTracks) && lastFmTracks.length > 0) {
                            tracks = lastFmTracks.map((t: any) => ({
                                title: t.name || t.title,
                                position: t["@attr"]?.rank
                                    ? parseInt(t["@attr"].rank)
                                    : undefined,
                            }));
                            logger.debug(
                                `[Acquisition/Soulseek] Got ${tracks.length} tracks from Last.fm`
                            );
                        }
                    } catch (lastfmError: any) {
                        logger.warn(
                            `[Acquisition/Soulseek] Last.fm fallback failed: ${lastfmError.message}`
                        );
                    }
                }

                if (!tracks || tracks.length === 0) {
                    // Mark job as failed
                    await this.updateJobStatus(
                        job.id,
                        "failed",
                        "Could not get track list from MusicBrainz or Last.fm"
                    );
                    return {
                        success: false,
                        error: "Could not get track list from MusicBrainz or Last.fm",
                    };
                }

                logger.debug(
                    `[Acquisition/Soulseek] Found ${tracks.length} tracks for album`
                );
            }

            // Use album-level search (1-2 network calls) instead of per-track
            const batchResult = await soulseekService.searchAndDownloadAlbum(
                request.artistName,
                request.albumTitle,
                tracks,
                musicPath,
                context.signal
            );

            if (batchResult.successful === 0) {
                // Mark job as failed
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    `No tracks found on Soulseek (searched ${tracks.length} tracks)`
                );
                return {
                    success: false,
                    tracksTotal: tracks.length,
                    downloadJobId: job.id,
                    error: `No tracks found on Soulseek (searched ${tracks.length} tracks)`,
                };
            }

            // Success threshold: at least 50% of tracks
            const successThreshold = Math.ceil(tracks.length * 0.5);
            const isSuccess = batchResult.successful >= successThreshold;

            logger.debug(
                `[Acquisition/Soulseek] Downloaded ${batchResult.successful}/${tracks.length} tracks (threshold: ${successThreshold})`
            );

            // Mark job as completed immediately (Soulseek doesn't use webhooks)
            await this.updateJobStatus(
                job.id,
                isSuccess ? "completed" : "failed",
                isSuccess
                    ? undefined
                    : `Only ${batchResult.successful}/${tracks.length} tracks found`
            );

            // Update job metadata with track counts
            // Read current metadata from DB (job object may be a stub with only id)
            const currentJob = await prisma.downloadJob.findUnique({
                where: { id: job.id },
                select: { metadata: true },
            });
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    metadata: {
                        ...((currentJob?.metadata as any) || {}),
                        tracksDownloaded: batchResult.successful,
                        tracksTotal: tracks.length,
                    },
                },
            });

            return {
                success: isSuccess,
                source: "soulseek",
                downloadJobId: job.id,
                tracksDownloaded: batchResult.successful,
                tracksTotal: tracks.length,
                error: isSuccess
                    ? undefined
                    : `Only ${batchResult.successful}/${tracks.length} tracks found`,
            };
        } catch (error: any) {
            if (error?.name === 'AbortError' || context.signal?.aborted) {
                if (job) {
                    await this.updateJobStatus(job.id, "failed", "Import cancelled").catch(() => {});
                }
                return { success: false, error: 'Import cancelled' };
            }
            logger.error(`[Acquisition/Soulseek] Error: ${error.message}`);
            // Update job status if job was created
            if (job) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    error.message
                ).catch((e) =>
                    logger.error(
                        `[Acquisition/Soulseek] Failed to update job status: ${e.message}`
                    )
                );
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Acquire album via Lidarr (full album download)
     * Creates download job and waits for webhook completion
     *
     * @param request - Album to acquire
     * @param context - Tracking context
     * @returns Acquisition result
     */
    private async acquireAlbumViaLidarr(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        if (context.signal?.aborted) {
            return { success: false, error: 'Import cancelled' };
        }

        logger.debug(
            `[Acquisition/Lidarr] Downloading: ${request.artistName} - ${request.albumTitle}`
        );

        if (!request.mbid) {
            return {
                success: false,
                error: "Album MBID required for Lidarr download",
            };
        }

        let job: any;
        try {
            // Create download job
            job = await this.createDownloadJob(request, context);

            // Calculate attempt number (existing lidarr attempts + 1)
            const jobMetadata = (job.metadata as any) || {};
            const lidarrAttempts = (jobMetadata.lidarrAttempts || 0) + 1;
            await this.updateJobStatusText(job.id, "lidarr", lidarrAttempts);

            // Start Lidarr download
            const isDiscovery = !!context.discoveryBatchId;
            const result = await simpleDownloadManager.startDownload(
                job.id,
                request.artistName,
                request.albumTitle,
                request.mbid,
                context.userId,
                isDiscovery
            );

            if (result.success) {
                logger.debug(
                    `[Acquisition/Lidarr] Download started (correlation: ${result.correlationId})`
                );

                return {
                    success: true,
                    source: "lidarr",
                    downloadJobId: job.id,
                    correlationId: result.correlationId,
                };
            } else {
                logger.error(
                    `[Acquisition/Lidarr] Failed to start: ${result.error}`
                );

                // Mark job as failed
                await this.updateJobStatus(job.id, "failed", result.error);

                // Return structured error info for fallback logic
                return {
                    success: false,
                    error: result.error,
                    errorType: result.errorType,
                    isRecoverable: result.isRecoverable,
                };
            }
        } catch (error: any) {
            logger.error(`[Acquisition/Lidarr] Error: ${error.message}`);
            // Update job status if job was created
            if (job) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    error.message
                ).catch((e) =>
                    logger.error(
                        `[Acquisition/Lidarr] Failed to update job status: ${e.message}`
                    )
                );
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Acquire album via SpotiFLAC (Spotify → Qobuz/Tidal download)
     * Gets Spotify album and downloads via high-quality sources
     *
     * @param request - Album to acquire
     * @param context - Tracking context
     * @returns Acquisition result
     */
    private async acquireAlbumViaSpotiFLAC(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<AcquisitionResult> {
        logger.debug(
            `[Acquisition/SpotiFLAC] Downloading: ${request.artistName} - ${request.albumTitle}`
        );

        let job: any;
        try {
            // Create download job
            job = await this.createDownloadJob(request, context);

            // Calculate attempt number (existing spotiflac attempts + 1)
            const jobMetadata = (job.metadata as any) || {};
            const spotiflacAttempts = (jobMetadata.spotiflacAttempts || 0) + 1;
            await this.updateJobStatusText(job.id, "spotiflac", spotiflacAttempts);

            // Get music path for output
            const settings = await getSystemSettings();
            const musicPath = settings?.musicPath || "/music";

            // Build sanitized paths
            const sanitizedArtist = request.artistName.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100);
            const sanitizedAlbum = request.albumTitle.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100);
            const albumDir = `${musicPath}/${sanitizedArtist}/${sanitizedAlbum}`;

            // For SpotiFLAC, we need the Spotify album ID
            // Strategy: 1) Use provided Spotify ID  2) Search Spotify by name  3) Use UPC from MusicBrainz
            
            let spotifyAlbumId = request.spotifyAlbumId || jobMetadata.spotifyAlbumId || jobMetadata.spotifyId;
            
            if (!spotifyAlbumId) {
                // Strategy 2: Search Spotify by artist + album name
                logger.debug(`[Acquisition/SpotiFLAC] No Spotify ID provided, searching Spotify by name...`);
                
                try {
                    spotifyAlbumId = await spotiflacService.searchSpotifyAlbum(request.artistName, request.albumTitle);
                    if (spotifyAlbumId) {
                        logger.debug(`[Acquisition/SpotiFLAC] Found Spotify album ID: ${spotifyAlbumId}`);
                    }
                } catch (e: any) {
                    logger.debug(`[Acquisition/SpotiFLAC] Spotify search failed: ${e.message}`);
                }
            }

            // Strategy 3: If still no Spotify ID, try downloading by UPC from MusicBrainz
            if (!spotifyAlbumId && request.mbid) {
                logger.debug(`[Acquisition/SpotiFLAC] No Spotify ID found, trying MusicBrainz UPC lookup...`);
                try {
                    // Get releases from the release group, then get the first release's barcode
                    const rgDetails = await musicBrainzService.getReleaseGroupDetails(request.mbid);
                    const releases = rgDetails?.releases || [];
                    const officialRelease = releases.find((r: any) => r.status === "Official") || releases[0];
                    
                    if (officialRelease?.id) {
                        const releaseData = await musicBrainzService.getRelease(officialRelease.id);
                        const barcode = releaseData?.barcode;
                        if (barcode) {
                            logger.debug(`[Acquisition/SpotiFLAC] Found UPC/barcode: ${barcode}, trying Qobuz...`);
                            const upcResult = await spotiflacService.downloadAlbumByUPC(barcode, {
                                outputDir: albumDir,
                                quality: undefined,
                                preferSource: "auto",
                                jobId: job.id,
                            });
                            if (upcResult.successful > 0) {
                                const successThreshold = Math.ceil(upcResult.total * 0.5);
                                const isSuccess = upcResult.successful >= successThreshold;
                                await this.updateJobStatus(job.id, isSuccess ? "completed" : "failed",
                                    isSuccess ? undefined : `Only ${upcResult.successful}/${upcResult.total} tracks via UPC`);
                                return {
                                    success: isSuccess,
                                    source: "spotiflac",
                                    downloadJobId: job.id,
                                    tracksDownloaded: upcResult.successful,
                                    tracksTotal: upcResult.total,
                                    error: isSuccess ? undefined : `Only ${upcResult.successful}/${upcResult.total} tracks via UPC`,
                                };
                            }
                        }
                    }
                } catch (e: any) {
                    logger.debug(`[Acquisition/SpotiFLAC] UPC download failed: ${e.message}`);
                }
            }

            if (!spotifyAlbumId) {
                await this.updateJobStatus(job.id, "failed",
                    `Could not find "${request.albumTitle}" by "${request.artistName}" on Spotify or Qobuz (UPC). Try providing a Spotify album URL.`
                );
                return {
                    success: false,
                    error: `Could not find album on Spotify or Qobuz. Try providing a Spotify URL.`,
                };
            }

            // Start the SpotiFLAC download
            logger.debug(`[Acquisition/SpotiFLAC] Starting download for album: ${spotifyAlbumId}`);
            
            const batchResult = await spotiflacService.downloadAlbum(spotifyAlbumId, {
                outputDir: albumDir,
                quality: undefined, // Use default quality from config
                preferSource: "auto",
                jobId: job.id,
            });

            if (batchResult.successful > 0) {
                const successThreshold = Math.ceil(batchResult.total * 0.5); // At least 50% of tracks
                const isSuccess = batchResult.successful >= successThreshold;

                logger.debug(
                    `[Acquisition/SpotiFLAC] Downloaded ${batchResult.successful}/${batchResult.total} tracks (threshold: ${successThreshold})`
                );

                // Update job status
                await this.updateJobStatus(
                    job.id,
                    isSuccess ? "completed" : "failed",
                    isSuccess ? undefined : `Only ${batchResult.successful}/${batchResult.total} tracks downloaded`
                );

                // Update metadata with track counts
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        metadata: {
                            ...jobMetadata,
                            tracksDownloaded: batchResult.successful,
                            tracksTotal: batchResult.total,
                            outputDir: batchResult.outputDir,
                        },
                    },
                });

                return {
                    success: isSuccess,
                    source: "spotiflac",
                    downloadJobId: job.id,
                    tracksDownloaded: batchResult.successful,
                    tracksTotal: batchResult.total,
                    error: isSuccess ? undefined : `Only ${batchResult.successful}/${batchResult.total} tracks downloaded`,
                };
            } else {
                logger.error(`[Acquisition/SpotiFLAC] No tracks downloaded`);
                
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    "No tracks found or downloaded from SpotiFLAC sources"
                );

                return {
                    success: false,
                    error: "No tracks found or downloaded from SpotiFLAC sources",
                };
            }
        } catch (error: any) {
            logger.error(`[Acquisition/SpotiFLAC] Error: ${error.message}`);
            
            if (job) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    error.message
                ).catch((e) =>
                    logger.error(
                        `[Acquisition/SpotiFLAC] Failed to update job status: ${e.message}`
                    )
                );
            }
            
            return {
                success: false,
                error: error.message,
            };
        }
    }

    /**
     * Create a DownloadJob for tracking acquisition
     * Links to Discovery batch or Spotify import job as appropriate
     * Implements deduplication to prevent duplicate download jobs
     *
     * @param request - Album request
     * @param context - Tracking context
     * @returns Created or existing download job
     */
    private async createDownloadJob(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext
    ): Promise<any> {
        // Check for existing job first - return full object (not stub) to preserve metadata
        if (context.existingJobId) {
            logger.debug(
                `[Acquisition] Using existing download job: ${context.existingJobId}`
            );
            const existingJob = await prisma.downloadJob.findUnique({
                where: { id: context.existingJobId },
            });
            if (existingJob) return existingJob;
            return { id: context.existingJobId };
        }

        // Validate userId before creating download job to prevent foreign key constraint violations
        if (!context.userId || typeof context.userId !== 'string' || context.userId === 'NaN' || context.userId === 'undefined' || context.userId === 'null') {
            logger.error(
                `[Acquisition] Invalid userId in context: ${JSON.stringify({
                    userId: context.userId,
                    typeofUserId: typeof context.userId,
                    albumTitle: request.albumTitle,
                    artistName: request.artistName
                })}`
            );
            throw new Error(`Invalid userId in acquisition context: ${context.userId}`);
        }

        // Dedup key: use MBID if available, otherwise use artist+album as identifier
        const dedupKey = request.mbid || `${request.artistName}::${request.albumTitle}`;

        // Check for existing active download job (before acquiring lock)
        const existingJobWhere: any = {
            userId: context.userId,
            discoveryBatchId: context.discoveryBatchId || null,
            status: { in: ['pending', 'downloading'] },
        };
        if (request.mbid) {
            existingJobWhere.targetMbid = request.mbid;
        } else {
            existingJobWhere.subject = `${request.artistName} - ${request.albumTitle}`;
        }

        const existingJob = await prisma.downloadJob.findFirst({
            where: existingJobWhere,
        });

        if (existingJob) {
            logger.info(
                `[Acquisition] Download job already exists for album ${dedupKey}, returning existing job ${existingJob.id}`
            );
            return existingJob;
        }

        // Use distributed lock to prevent race condition
        const lockKey = `download-job:${context.userId}:${dedupKey}:${context.discoveryBatchId || 'null'}`;

        return await distributedLock.withLock(lockKey, 5000, async () => {
            // Double-check after acquiring lock (another request might have created it)
            const doubleCheck = await prisma.downloadJob.findFirst({
                where: existingJobWhere,
            });

            if (doubleCheck) {
                logger.info(
                    `[Acquisition] Download job created by concurrent request, returning existing job ${doubleCheck.id}`
                );
                return doubleCheck;
            }

            // Create new download job
            const jobData: any = {
                userId: context.userId,
                subject: `${request.artistName} - ${request.albumTitle}`,
                type: "album",
                targetMbid: request.mbid || null,
                status: "pending",
                metadata: {
                    artistName: request.artistName,
                    albumTitle: request.albumTitle,
                    albumMbid: request.mbid || null,
                },
            };

            // Add context-based tracking
            if (context.discoveryBatchId) {
                jobData.discoveryBatchId = context.discoveryBatchId;
                jobData.metadata.downloadType = "discovery";
            }

            if (context.spotifyImportJobId) {
                jobData.metadata.spotifyImportJobId = context.spotifyImportJobId;
                jobData.metadata.downloadType = "spotify_import";
            }

            const job = await prisma.downloadJob.create({
                data: jobData,
            });

            logger.debug(
                `[Acquisition] Created download job: ${job.id} (type: ${
                    jobData.metadata.downloadType || "library"
                })`
            );

            return job;
        });
    }

    /**
     * Update download job status
     *
     * @param jobId - Job ID to update
     * @param status - New status
     * @param error - Optional error message
     */
    private async updateJobStatus(
        jobId: string,
        status: string,
        error?: string
    ): Promise<void> {
        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status,
                error: error || null,
                completedAt:
                    status === "completed" || status === "failed"
                        ? new Date()
                        : undefined,
            },
        });

        logger.debug(
            `[Acquisition] Updated job ${jobId}: status=${status}${
                error ? `, error=${error}` : ""
            }`
        );
    }
}

// Export singleton instance
export const acquisitionService = new AcquisitionService();
