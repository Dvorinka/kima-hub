/**
 * Interaction & Recommendation Controls Routes
 *
 * POST /interactions         — Record a user interaction (play, skip, like, dislike, hide, save)
 * GET  /interactions         — Get recent interactions for user
 * GET  /taste-profile        — Get user's taste profile
 * POST /taste-profile/refresh — Force recompute taste profile
 * GET  /rec-controls         — Get user recommendation controls
 * PUT  /rec-controls         — Update user recommendation controls
 */

import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import {
    recordInteraction,
    computeTasteVector,
    saveTasteProfile,
    getTasteProfile,
    getUserControls,
    updateUserControls,
} from "../services/tasteProfile";

const router = Router();
router.use(requireAuth);

// ── Interaction schemas ──

const interactionSchema = z.object({
    trackId: z.string(),
    type: z.enum(["PLAY", "SKIP", "LIKE", "DISLIKE", "HIDE", "SAVE"]),
    completedMs: z.number().int().optional(),
    weight: z.number().optional(),
});

// POST /interactions — Record interaction
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { trackId, type, completedMs, weight } = interactionSchema.parse(req.body);

        // Verify track exists
        const track = await prisma.track.findUnique({ where: { id: trackId } });
        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        await recordInteraction(userId, trackId, type, completedMs, weight);

        res.json({ success: true, type, trackId });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Record interaction error:", error);
        res.status(500).json({ error: "Failed to record interaction" });
    }
});

// GET /interactions — Get recent interactions
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { limit = "50", type } = req.query;

        const where: any = { userId };
        if (type && typeof type === "string") {
            where.type = type;
        }

        const interactions = await prisma.interaction.findMany({
            where,
            orderBy: { occurredAt: "desc" },
            take: Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 200),
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: { select: { id: true, name: true, mbid: true } },
                            },
                        },
                    },
                },
            },
        });

        res.json(interactions);
    } catch (error) {
        logger.error("Get interactions error:", error);
        res.status(500).json({ error: "Failed to get interactions" });
    }
});

// ── Taste Profile ──

// GET /taste-profile — Get user's taste profile
router.get("/taste-profile", async (req, res) => {
    try {
        const userId = req.user!.id;
        const taste = await getTasteProfile(userId);
        res.json(taste);
    } catch (error) {
        logger.error("Get taste profile error:", error);
        res.status(500).json({ error: "Failed to get taste profile" });
    }
});

// POST /taste-profile/refresh — Force recompute taste profile
router.post("/taste-profile/refresh", async (req, res) => {
    try {
        const userId = req.user!.id;
        const taste = await computeTasteVector(userId);
        await saveTasteProfile(userId, taste);
        res.json(taste);
    } catch (error) {
        logger.error("Refresh taste profile error:", error);
        res.status(500).json({ error: "Failed to refresh taste profile" });
    }
});

// ── Recommendation Controls ──

const recControlsSchema = z.object({
    allowExplicit: z.boolean().optional(),
    addExcludedTrackIds: z.array(z.string()).optional(),
    removeExcludedTrackIds: z.array(z.string()).optional(),
    addExcludedArtistIds: z.array(z.string()).optional(),
    removeExcludedArtistIds: z.array(z.string()).optional(),
    addExcludedGenres: z.array(z.string()).optional(),
    removeExcludedGenres: z.array(z.string()).optional(),
    addPostponedTrackIds: z.array(z.string()).optional(),
    removePostponedTrackIds: z.array(z.string()).optional(),
});

// GET /rec-controls — Get user recommendation controls
router.get("/rec-controls", async (req, res) => {
    try {
        const userId = req.user!.id;
        const controls = await getUserControls(userId);
        res.json(controls);
    } catch (error) {
        logger.error("Get rec controls error:", error);
        res.status(500).json({ error: "Failed to get recommendation controls" });
    }
});

// PUT /rec-controls — Update user recommendation controls
router.put("/rec-controls", async (req, res) => {
    try {
        const userId = req.user!.id;
        const updates = recControlsSchema.parse(req.body);
        await updateUserControls(userId, updates);
        const controls = await getUserControls(userId);
        res.json(controls);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Update rec controls error:", error);
        res.status(500).json({ error: "Failed to update recommendation controls" });
    }
});

export default router;
