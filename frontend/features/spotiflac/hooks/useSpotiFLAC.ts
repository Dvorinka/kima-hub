import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

export function useSpotiFLAC() {
    const { toast } = useToast();

    const downloadTrack = async (spotifyUrl: string) => {
        try {
            toast.info("Starting SpotiFLAC download...");
            const result = await api.downloadSpotiFLACTrack(spotifyUrl);
            toast.success(`Download started: ${result.message}`);
            return result;
        } catch (error: unknown) {
            console.error("SpotiFLAC track download failed:", error);
            const err = error as Error & { data?: { details?: string } };
            toast.error(err.data?.details || err.message || "Failed to download track");
            throw error;
        }
    };

    const downloadAlbum = async (spotifyUrl: string) => {
        try {
            toast.info("Starting SpotiFLAC album download...");
            const result = await api.downloadSpotiFLACAlbum(spotifyUrl);
            toast.success(`Album download started: ${result.message}`);
            return result;
        } catch (error: unknown) {
            console.error("SpotiFLAC album download failed:", error);
            const err = error as Error & { data?: { details?: string } };
            toast.error(err.data?.details || err.message || "Failed to download album");
            throw error;
        }
    };

    const downloadArtist = async (spotifyUrl: string) => {
        try {
            toast.info("Starting SpotiFLAC artist download...");
            const result = await api.downloadSpotiFLACArtist(spotifyUrl);
            toast.success(`Artist download started: ${result.message}`);
            return result;
        } catch (error: unknown) {
            console.error("SpotiFLAC artist download failed:", error);
            const err = error as Error & { data?: { details?: string } };
            toast.error(err.data?.details || err.message || "Failed to download artist");
            throw error;
        }
    };

    const downloadPlaylist = async (spotifyUrl: string) => {
        try {
            toast.info("Starting SpotiFLAC playlist download...");
            const result = await api.downloadSpotiFLACPlaylist(spotifyUrl);
            toast.success(`Playlist download started: ${result.message}`);
            return result;
        } catch (error: unknown) {
            console.error("SpotiFLAC playlist download failed:", error);
            const err = error as Error & { data?: { details?: string } };
            toast.error(err.data?.details || err.message || "Failed to download playlist");
            throw error;
        }
    };

    const downloadByArtistAlbum = async (artistName: string, albumTitle: string) => {
        try {
            toast.info(`Starting SpotiFLAC download for ${artistName} - ${albumTitle}...`);
            const result = await api.downloadSpotiFLACByArtistAlbum(artistName, albumTitle);
            toast.success(`Download started: ${result.message}`);
            return result;
        } catch (error: unknown) {
            console.error("SpotiFLAC download by name failed:", error);
            const err = error as Error & { data?: { details?: string } };
            toast.error(err.data?.details || err.message || "Failed to download");
            throw error;
        }
    };

    return {
        downloadTrack,
        downloadAlbum,
        downloadArtist,
        downloadPlaylist,
        downloadByArtistAlbum,
    };
}
