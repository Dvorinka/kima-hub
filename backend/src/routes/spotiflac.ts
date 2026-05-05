/**
 * SpotiFLAC Download Routes
 *
 * Provides API endpoints for downloading music via SpotiFLAC:
 * - Individual tracks
 * - Albums
 * - Artists (all albums)
 * - Playlists
 */

import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { spotiflacService } from "../services/spotiflac";
import { getSystemSettings } from "../utils/systemSettings";

const router = Router();

router.use(requireAuthOrToken);

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTIFY URL PARSERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseSpotifyUrl(url: string): { type: "track" | "album" | "artist" | "playlist"; id: string } | null {
    // Handle various Spotify URL formats
    const patterns = [
        // open.spotify.com URLs
        /open\.spotify\.com\/(track|album|artist|playlist)\/([a-zA-Z0-9]+)/,
        // spotify: URI format
        /spotify:(track|album|artist|playlist):([a-zA-Z0-9]+)/,
        // embed URLs
        /open\.spotify\.com\/embed\/(track|album|artist|playlist)\/([a-zA-Z0-9]+)/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return {
                type: match[1] as "track" | "album" | "artist" | "playlist",
                id: match[2],
            };
        }
    }

    // Try to extract just the ID if it's a bare ID (22 characters)
    if (/^[a-zA-Z0-9]{22}$/.test(url)) {
        // Can't determine type from ID alone
        return null;
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH / STATUS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /spotiflac/status - Check if SpotiFLAC is available
router.get("/status", async (_req, res) => {
    try {
        const isAvailable = await spotiflacService.isAvailable();
        const settings = await getSystemSettings();
        
        res.json({
            available: isAvailable,
            enabled: settings?.spotiflacEnabled ?? false,
            zeroConfig: true,
            sources: ["qobuz", "tidal"],
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Status check error:", error);
        res.status(500).json({ error: "Failed to check SpotiFLAC status" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRACK DOWNLOADS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /spotiflac/download/track - Download a single track
router.post("/download/track", async (req, res) => {
    try {
        const { spotifyUrl, spotifyId, quality, preferSource = "auto" } = req.body;
        const userId = req.user!.id;

        // Parse URL if provided
        let trackId = spotifyId;
        if (!trackId && spotifyUrl) {
            const parsed = parseSpotifyUrl(spotifyUrl);
            if (!parsed || parsed.type !== "track") {
                return res.status(400).json({ 
                    error: "Invalid Spotify URL. Must be a track URL." 
                });
            }
            trackId = parsed.id;
        }

        if (!trackId) {
            return res.status(400).json({ 
                error: "Missing spotifyId or spotifyUrl" 
            });
        }

        // Check if SpotiFLAC is available
        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({
                error: "SpotiFLAC is not available. Enable it in Settings → Downloads.",
            });
        }

        // Create download job
        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `SpotiFLAC Track: ${trackId}`,
                type: "track",
                status: "pending",
                metadata: {
                    spotifyId: trackId,
                    quality,
                    preferSource,
                    downloadType: "spotiflac",
                },
            },
        });

        // Start download in background
        spotiflacService.downloadTrack(trackId, {
            quality,
            preferSource: preferSource as any,
            jobId: job.id,
        }).catch((error) => {
            logger.error(`[SpotiFLAC] Background track download failed:`, error);
        });

        res.json({
            success: true,
            jobId: job.id,
            message: "Track download started",
            trackId,
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Track download error:", error);
        res.status(500).json({ error: error.message || "Failed to start track download" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALBUM DOWNLOADS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /spotiflac/download/album - Download an album
router.post("/download/album", async (req, res) => {
    try {
        const { 
            spotifyUrl, 
            spotifyId, 
            quality, 
            preferSource = "auto",
            artistName,
            albumTitle,
        } = req.body;
        const userId = req.user!.id;

        // Parse URL if provided
        let albumId = spotifyId;
        if (!albumId && spotifyUrl) {
            const parsed = parseSpotifyUrl(spotifyUrl);
            if (!parsed || parsed.type !== "album") {
                return res.status(400).json({ 
                    error: "Invalid Spotify URL. Must be an album URL." 
                });
            }
            albumId = parsed.id;
        }

        if (!albumId) {
            return res.status(400).json({ 
                error: "Missing spotifyId or spotifyUrl" 
            });
        }

        // Check if SpotiFLAC is available
        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({
                error: "SpotiFLAC is not available. Enable it in Settings → Downloads.",
            });
        }

        // Create download job
        const subject = artistName && albumTitle
            ? `${artistName} - ${albumTitle}`
            : `SpotiFLAC Album: ${albumId}`;

        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject,
                type: "album",
                status: "pending",
                metadata: {
                    spotifyAlbumId: albumId,
                    artistName,
                    albumTitle,
                    quality,
                    preferSource,
                    downloadType: "spotiflac",
                },
            },
        });

        // Start download in background
        spotiflacService.downloadAlbum(albumId, {
            quality,
            preferSource: preferSource as any,
            jobId: job.id,
        }).catch((error) => {
            logger.error(`[SpotiFLAC] Background album download failed:`, error);
        });

        res.json({
            success: true,
            jobId: job.id,
            message: "Album download started",
            albumId,
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Album download error:", error);
        res.status(500).json({ error: error.message || "Failed to start album download" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARTIST DOWNLOADS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /spotiflac/download/artist - Download all albums by an artist
router.post("/download/artist", async (req, res) => {
    try {
        const { 
            spotifyUrl, 
            spotifyId, 
            quality, 
            preferSource = "auto",
            maxAlbums,
        } = req.body;
        const userId = req.user!.id;

        // Parse URL if provided
        let artistId = spotifyId;
        if (!artistId && spotifyUrl) {
            const parsed = parseSpotifyUrl(spotifyUrl);
            if (!parsed || parsed.type !== "artist") {
                return res.status(400).json({ 
                    error: "Invalid Spotify URL. Must be an artist URL." 
                });
            }
            artistId = parsed.id;
        }

        if (!artistId) {
            return res.status(400).json({ 
                error: "Missing spotifyId or spotifyUrl" 
            });
        }

        // Check if SpotiFLAC is available
        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({
                error: "SpotiFLAC is not available. Enable it in Settings → Downloads.",
            });
        }

        // Create download job
        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `SpotiFLAC Artist: ${artistId}`,
                type: "artist",
                status: "pending",
                metadata: {
                    spotifyArtistId: artistId,
                    quality,
                    preferSource,
                    maxAlbums,
                    downloadType: "spotiflac",
                },
            },
        });

        // Start download in background
        spotiflacService.downloadArtist(artistId, {
            quality,
            preferSource: preferSource as any,
            jobId: job.id,
            maxAlbums: maxAlbums ? parseInt(maxAlbums, 10) : undefined,
        }).catch((error) => {
            logger.error(`[SpotiFLAC] Background artist download failed:`, error);
        });

        res.json({
            success: true,
            jobId: job.id,
            message: "Artist download started",
            artistId,
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Artist download error:", error);
        res.status(500).json({ error: error.message || "Failed to start artist download" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYLIST DOWNLOADS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /spotiflac/download/playlist - Download a playlist
router.post("/download/playlist", async (req, res) => {
    try {
        const { 
            spotifyUrl, 
            spotifyId, 
            quality, 
            preferSource = "auto",
        } = req.body;
        const userId = req.user!.id;

        // Parse URL if provided
        let playlistId = spotifyId;
        if (!playlistId && spotifyUrl) {
            const parsed = parseSpotifyUrl(spotifyUrl);
            if (!parsed || parsed.type !== "playlist") {
                return res.status(400).json({ 
                    error: "Invalid Spotify URL. Must be a playlist URL." 
                });
            }
            playlistId = parsed.id;
        }

        if (!playlistId) {
            return res.status(400).json({ 
                error: "Missing spotifyId or spotifyUrl" 
            });
        }

        // Check if SpotiFLAC is available
        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({
                error: "SpotiFLAC is not available. Enable it in Settings → Downloads.",
            });
        }

        // Create download job
        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `SpotiFLAC Playlist: ${playlistId}`,
                type: "playlist",
                status: "pending",
                metadata: {
                    spotifyPlaylistId: playlistId,
                    quality,
                    preferSource,
                    downloadType: "spotiflac",
                },
            },
        });

        // Start download in background
        spotiflacService.downloadPlaylist(playlistId, {
            quality,
            preferSource: preferSource as any,
            jobId: job.id,
        }).catch((error) => {
            logger.error(`[SpotiFLAC] Background playlist download failed:`, error);
        });

        res.json({
            success: true,
            jobId: job.id,
            message: "Playlist download started",
            playlistId,
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Playlist download error:", error);
        res.status(500).json({ error: error.message || "Failed to start playlist download" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BATCH DOWNLOAD (Multiple items)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /spotiflac/download/batch - Download multiple items
router.post("/download/batch", async (req, res) => {
    try {
        const { items } = req.body; // Array of { type, spotifyId, spotifyUrl }
        const userId = req.user!.id;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "No items provided" });
        }

        // Limit batch size
        if (items.length > 50) {
            return res.status(400).json({ error: "Batch size limited to 50 items" });
        }

        // Check if SpotiFLAC is available
        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({
                error: "SpotiFLAC is not available. Enable it in Settings → Downloads.",
            });
        }

        const results = [];
        
        for (const item of items) {
            let id = item.spotifyId;
            
            if (!id && item.spotifyUrl) {
                const parsed = parseSpotifyUrl(item.spotifyUrl);
                if (parsed) {
                    id = parsed.id;
                }
            }

            if (!id) {
                results.push({ success: false, error: "Could not parse Spotify ID" });
                continue;
            }

            // Create job for each item
            const job = await prisma.downloadJob.create({
                data: {
                    userId,
                    subject: `SpotiFLAC ${item.type}: ${id}`,
                    type: item.type,
                    status: "pending",
                    metadata: {
                        spotifyId: id,
                        downloadType: "spotiflac",
                    },
                },
            });

            results.push({ success: true, jobId: job.id, type: item.type, id });

            // Start appropriate download
            switch (item.type) {
                case "track":
                    spotiflacService.downloadTrack(id, { jobId: job.id }).catch((e) => {
                        logger.error(`[SpotiFLAC] Batch track download failed:`, e);
                    });
                    break;
                case "album":
                    spotiflacService.downloadAlbum(id, { jobId: job.id }).catch((e) => {
                        logger.error(`[SpotiFLAC] Batch album download failed:`, e);
                    });
                    break;
                case "artist":
                    spotiflacService.downloadArtist(id, { jobId: job.id }).catch((e) => {
                        logger.error(`[SpotiFLAC] Batch artist download failed:`, e);
                    });
                    break;
                case "playlist":
                    spotiflacService.downloadPlaylist(id, { jobId: job.id }).catch((e) => {
                        logger.error(`[SpotiFLAC] Batch playlist download failed:`, e);
                    });
                    break;
            }
        }

        res.json({
            success: true,
            total: items.length,
            results,
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Batch download error:", error);
        res.status(500).json({ error: error.message || "Failed to start batch download" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOB STATUS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /spotiflac/jobs - List SpotiFLAC download jobs for the current user
router.get("/jobs", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { limit = "20", status } = req.query;

        const where: any = {
            userId,
            metadata: {
                path: ["downloadType"],
                equals: "spotiflac",
            },
        };

        if (status) {
            where.status = status as string;
        }

        const jobs = await prisma.downloadJob.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: parseInt(limit as string, 10),
        });

        res.json(jobs);
    } catch (error: any) {
        logger.error("[SpotiFLAC] List jobs error:", error);
        res.status(500).json({ error: "Failed to list jobs" });
    }
});

// GET /spotiflac/jobs/:id - Get specific job status
router.get("/jobs/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
                metadata: {
                    path: ["downloadType"],
                    equals: "spotiflac",
                },
            },
        });

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        res.json(job);
    } catch (error: any) {
        logger.error("[SpotiFLAC] Get job error:", error);
        res.status(500).json({ error: "Failed to get job" });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH (find Spotify IDs by name — used when no Spotify URL available)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /spotiflac/search?q=...&type=album|track|artist
router.get("/search", async (req, res) => {
    try {
        const { q, type = "album", limit = 5 } = req.query;
        if (!q || typeof q !== "string") {
            return res.status(400).json({ error: "Missing search query (q)" });
        }
        if (!["album", "track", "artist"].includes(type as string)) {
            return res.status(400).json({ error: "type must be album, track, or artist" });
        }

        const settings = await getSystemSettings();
        if (!settings?.spotiflacEnabled) {
            return res.status(400).json({ error: "SpotiFLAC is not enabled" });
        }

        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({ error: "SpotiFLAC is not available" });
        }

        // Search by name: use the appropriate search method based on type
        let spotifyId: string | null = null;
        if (type === "album") {
            // For albums, treat q as "Artist - Album" or just album name
            const parts = q.includes(" - ") ? q.split(" - ") : ["", q];
            spotifyId = await spotiflacService.searchSpotifyAlbum(parts[0].trim(), parts.slice(1).join(" - ").trim());
        } else if (type === "track") {
            const parts = q.includes(" - ") ? q.split(" - ") : ["", q];
            spotifyId = await spotiflacService.searchSpotifyTrack(parts[0].trim(), parts.slice(1).join(" - ").trim());
        } else {
            spotifyId = await spotiflacService.searchSpotifyArtist(q);
        }

        const results = spotifyId ? [{ id: spotifyId, name: q, type }] : [];
        res.json({ results });
    } catch (error: any) {
        logger.error("[SpotiFLAC] Search error:", error);
        res.status(500).json({ error: error.message || "Search failed" });
    }
});

// POST /spotiflac/download/by-name - Download album/track/artist by name (no Spotify URL needed)
router.post("/download/by-name", async (req, res) => {
    try {
        const {
            artistName,
            albumTitle,
            trackTitle,
            quality,
            preferSource = "auto",
        } = req.body;
        const userId = req.user!.id;

        if (!artistName) {
            return res.status(400).json({ error: "artistName is required" });
        }

        const settings = await getSystemSettings();
        if (!settings?.spotiflacEnabled) {
            return res.status(400).json({ error: "SpotiFLAC is not enabled. Enable it in Settings → Downloads." });
        }

        const isAvailable = await spotiflacService.isAvailable();
        if (!isAvailable) {
            return res.status(400).json({ error: "SpotiFLAC is not available. Enable it in Settings → Downloads." });
        }

        let spotifyId: string | null = null;
        let downloadType: "track" | "album" | "artist" = "artist";

        if (trackTitle) {
            // Track by name
            downloadType = "track";
            spotifyId = await spotiflacService.searchSpotifyTrack(artistName, trackTitle);
        } else if (albumTitle) {
            // Album by name
            downloadType = "album";
            spotifyId = await spotiflacService.searchSpotifyAlbum(artistName, albumTitle);
        } else {
            // Artist by name
            downloadType = "artist";
            spotifyId = await spotiflacService.searchSpotifyArtist(artistName);
        }

        if (!spotifyId) {
            return res.status(404).json({
                error: `Could not find "${trackTitle || albumTitle || artistName}" on Spotify`,
            });
        }

        // Create download job
        const subject = trackTitle
            ? `${artistName} - ${trackTitle}`
            : albumTitle
                ? `${artistName} - ${albumTitle}`
                : `Artist: ${artistName}`;

        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `SpotiFLAC: ${subject}`,
                type: downloadType,
                status: "pending",
                metadata: {
                    spotifyId,
                    artistName,
                    albumTitle,
                    trackTitle,
                    quality,
                    preferSource,
                    downloadType: "spotiflac",
                },
            },
        });

        // Start download in background
        const dlOpts = { quality, preferSource: preferSource as any, jobId: job.id };
        if (downloadType === "track") {
            spotiflacService.downloadTrack(spotifyId, dlOpts).catch((error: any) => {
                logger.error(`[SpotiFLAC] Background track download failed:`, error);
            });
        } else if (downloadType === "album") {
            spotiflacService.downloadAlbum(spotifyId, dlOpts).catch((error: any) => {
                logger.error(`[SpotiFLAC] Background album download failed:`, error);
            });
        } else {
            spotiflacService.downloadArtist(spotifyId, dlOpts).catch((error: any) => {
                logger.error(`[SpotiFLAC] Background artist download failed:`, error);
            });
        }

        res.json({
            success: true,
            jobId: job.id,
            spotifyId,
            downloadType,
            message: `${downloadType} download started`,
        });
    } catch (error: any) {
        logger.error("[SpotiFLAC] By-name download error:", error);
        res.status(500).json({ error: error.message || "Failed to start download" });
    }
});

export default router;
