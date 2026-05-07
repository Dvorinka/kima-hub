# Feature: SpotiFLAC Integration + Recommendation Engine

This PR adds two major features to Kima with full frontend and backend implementation:

1. **SpotiFLAC Integration** - A zero-configuration lossless music downloader from Spotify URLs
2. **Recommendation Engine** - User taste profiling with interaction tracking and hybrid similarity model

---

## Part 1: SpotiFLAC Integration

I've integrated [SpotiFLAC](https://github.com/spotbye/SpotiFLAC) - a Go-based tool that downloads lossless music from Spotify URLs - into Kima as a TypeScript backend service with full frontend UI.

### Why SpotiFLAC?

SpotiFLAC is **zero-configuration**: no API keys, no user setup, no environment variables. You just toggle it on in settings and it works. It downloads from Qobuz and Tidal using credentials embedded in the code (reverse-engineered from the original Go implementation).

### Backend Changes

**New Files:**
- `backend/src/services/spotiflac.ts` (~460 lines) - Core SpotiFLAC service ported from Go
- `backend/src/routes/spotiflac.ts` (~700 lines) - API endpoints for downloads
- `backend/prisma/migrations/20260420000000_add_spotiflac_enabled/migration.sql` - DB migration for SpotiFLAC toggle
- `reference/SpotiFLAC` (git submodule) - Original Go implementation for reference

**Modified Files:**
- `backend/prisma/schema.prisma` - Added `spotiflacEnabled` Boolean to SystemSettings
- `backend/src/routes/systemSettings.ts` - Added SpotiFLAC to download source enum
- `backend/src/services/acquisitionService.ts` - Integrated SpotiFLAC as download source
- `backend/src/index.ts` - Registered SpotiFLAC routes

### Frontend Changes

**New Files:**
- `frontend/features/spotiflac/hooks/useSpotiFLAC.ts` - Hook for SpotiFLAC download actions with toast notifications
- `frontend/features/spotiflac/hooks/useSpotiFLACStatus.ts` - Hook for SpotiFLAC status polling
- `frontend/features/spotiflac/hooks/index.ts` - Exports for SpotiFLAC hooks
- `frontend/features/spotiflac/components/SpotiFLACDownloader.tsx` - UI component for direct SpotiFLAC downloads (track/album/artist/playlist/by-name)
- `frontend/features/spotiflac/components/SpotiFLACStatusIndicator.tsx` - Badge component showing SpotiFLAC availability
- `frontend/features/spotiflac/components/SpotiFLACJobStatus.tsx` - Component displaying SpotiFLAC download jobs with progress
- `frontend/features/spotiflac/components/index.ts` - Exports for SpotiFLAC components

**Modified Files:**
- `frontend/features/settings/types.ts` - Added `spotiflacEnabled` to SystemSettings; updated downloadSource and primaryFailureFallback types to include "spotiflac"
- `frontend/features/settings/components/sections/DownloadPreferencesSection.tsx` - Added SpotiFLAC toggle and included SpotiFLAC in download source selector
- `frontend/lib/api.ts` - Added SpotiFLAC API methods (status, downloads, jobs, search)

### How SpotiFLAC Works

1. User enables SpotiFLAC in System Settings
2. When a download is requested, acquisition service checks if SpotiFLAC is available
3. SpotiFLAC initializes by getting Spotify session/access token (embedded TOTP secret)
4. Extracts ISRC from Spotify's internal metadata API
5. Tries Qobuz first - searches ISRC, gets download URL, downloads FLAC
6. If Qobuz fails, tries Tidal using APIs from GitHub gist
7. Uses FFmpeg to embed metadata (ISRC, UPC, cover art)

### SpotiFLAC API Endpoints

- `GET /api/spotiflac/status` - Check availability
- `POST /api/spotiflac/download/track` - Download single track
- `POST /api/spotiflac/download/album` - Download album
- `POST /api/spotiflac/download/artist` - Download all albums by artist
- `POST /api/spotiflac/download/playlist` - Download playlist
- `POST /api/spotiflac/download/by-name` - Download by artist/album name (no URL needed)
- `GET /api/spotiflac/jobs` - List all download jobs
- `GET /api/spotiflac/jobs/:jobId` - Get specific job details
- `GET /api/spotiflac/search` - Search Spotify by name

---

## Part 2: Recommendation Engine

I've implemented a recommendation system with user taste profiling, interaction tracking, and mode-aware recommendations.

### Backend Changes

**New Files:**
- `backend/src/services/recommendationService.ts` (~460 lines) - Recommendation engine with interaction tracking, taste profiling, hybrid similarity model, and MMR-style diversity
- `backend/prisma/migrations/20260507000000_add_recommendation_mode/migration.sql` - Migration for recommendation mode

**Modified Files:**
- `backend/prisma/schema.prisma` - Added `recommendationMode` String to SystemSettings (comfort/discovery/balanced)
- `backend/src/routes/systemSettings.ts` - Added recommendationMode to settings schema and validation
- `backend/src/routes/recommendations.ts` - Added interaction tracking, taste profile, settings, and generation endpoints

### Frontend Changes

**New Files:**
- `frontend/features/settings/components/sections/RecommendationSection.tsx` - UI for recommendation mode selector and artist/genre exclusion controls

**Modified Files:**
- `frontend/features/settings/types.ts` - Added `recommendationMode`, `excludedArtists`, `excludedGenres` to SystemSettings
- `frontend/app/settings/page.tsx` - Added RecommendationSection to settings page sidebar for admin users

### How Recommendations Work

1. **Interactions are tracked** when users play, skip, like, dislike, or save tracks (with weighted scoring)
2. **Taste profile builds** based on recent interactions (genres, artists, audio features)
3. **Hybrid similarity model** compares user taste to track profiles (genre + audio feature similarity)
4. **MMR-style diversity algorithm** ensures varied recommendations
5. **Mode selector** adjusts comfort/discovery balance:
   - Comfort: Boost similar items (1.2x similarity)
   - Discovery: Boost diverse items (0.3 base + 0.4x similarity)
   - Balanced: No adjustment
6. **User controls** allow excluding specific artists/genres from recommendations

### Recommendation API Endpoints

- `POST /api/recommendations/track-interaction` - Track user interactions (play, skip, like, dislike, save)
- `GET /api/recommendations/taste-profile` - Get user's taste profile (genres, artists, audio features)
- `GET /api/recommendations/settings` - Get recommendation settings (mode, exclusions)
- `PUT /api/recommendations/settings` - Update recommendation settings (excluded artists/genres)
- `GET /api/recommendations/generate` - Generate personalized recommendations

---

## Zero-Config Implementation

SpotiFLAC works without configuration because:
- Spotify TOTP secret is hardcoded (from original Go implementation)
- Qobuz credentials auto-scraped from JS bundle with hardcoded fallback
- Tidal API URLs fetched from public GitHub gist
- MusicDL debug key decrypted from embedded ciphertext

---

## Testing

### Automated Tests
- **Frontend lint**: `npm run lint` - ✅ Passed
- **Backend TypeScript**: `npx tsc --noEmit` - ✅ Passed
- **Docker**: FFmpeg already installed (needed for metadata embedding) - ✅ Confirmed
- **Code patterns**: Followed existing patterns (singleton service, isAvailable(), error handling) - ✅ Confirmed

### Manual Test Plan

To test SpotiFLAC:
```bash
# 1. Enable SpotiFLAC
curl -X POST http://localhost:3006/api/system-settings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"spotiflacEnabled": true}'

# 2. Check status
curl http://localhost:3006/api/spotiflac/status \
  -H "Authorization: Bearer <token>"

# 3. Download a track
curl -X POST http://localhost:3006/api/spotiflac/download/track \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"spotifyUrl": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"}'
```

---

## What's Implemented

**SpotiFLAC:**
- ✅ Settings toggle for SpotiFLAC
- ✅ SpotiFLAC as download source option
- ✅ SpotiFLAC download UI components (track/album/artist/playlist/by-name)
- ✅ SpotiFLAC download job status display
- ✅ SpotiFLAC status indicator

**Recommendations:**
- ✅ Recommendation mode selector (comfort/discovery/balanced)
- ✅ User controls for excluding artists/genres
- ✅ Interaction tracking backend
- ✅ Taste profiling backend
- ✅ Hybrid similarity model
- ✅ MMR-style diversity algorithm
- ❌ Taste profile visualization (requires additional UI work)

---

## Security Considerations

SpotiFLAC credentials are hardcoded (TOTP secret, Qobuz fallback, MusicDL key). These are from the original Go implementation - reverse-engineered from the services, not user-specific. No user data is exposed or stored.

---

## Known Limitations

- Taste profile visualization not implemented (requires additional UI work)
- SpotiFLAC relies on Spotify's internal API (could break if Spotify changes)
- Qobuz scraping might need updates if they change their JS bundle
- Tidal relies on public GitHub gist for API URLs
- No rate limiting (inherits from external services)
- No retry logic for failed downloads

---

## Breaking Changes

None. All changes are additive and backward compatible.

---

## Migration Required

Two database migrations are included:
```bash
npx prisma migrate deploy
```

Or automatically on Docker startup. Requires DATABASE_URL environment variable to be set.

---

## Questions I Have

- Should I add taste profile visualization in a follow-up PR?
- Are there specific tests I should run that I haven't thought of?
- Is the zero-config approach acceptable, or would you prefer user-configurable credentials?
