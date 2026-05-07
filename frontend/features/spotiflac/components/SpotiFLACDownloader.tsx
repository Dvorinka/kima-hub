"use client";

import { useState } from "react";
import { useSpotiFLAC } from "../hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Loader2 } from "lucide-react";

interface SpotiFLACDownloaderProps {
    type?: "track" | "album" | "artist" | "playlist" | "by-name";
}

export function SpotiFLACDownloader({ type = "track" }: SpotiFLACDownloaderProps) {
    const { downloadTrack, downloadAlbum, downloadArtist, downloadPlaylist, downloadByArtistAlbum } = useSpotiFLAC();
    const [spotifyUrl, setSpotifyUrl] = useState("");
    const [artistName, setArtistName] = useState("");
    const [albumTitle, setAlbumTitle] = useState("");
    const [loading, setLoading] = useState(false);

    const handleDownload = async () => {
        if (!spotifyUrl && type !== "by-name") {
            return;
        }
        if (type === "by-name" && (!artistName || !albumTitle)) {
            return;
        }

        setLoading(true);
        try {
            switch (type) {
                case "track":
                    await downloadTrack(spotifyUrl);
                    break;
                case "album":
                    await downloadAlbum(spotifyUrl);
                    break;
                case "artist":
                    await downloadArtist(spotifyUrl);
                    break;
                case "playlist":
                    await downloadPlaylist(spotifyUrl);
                    break;
                case "by-name":
                    await downloadByArtistAlbum(artistName, albumTitle);
                    break;
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-4">
            {type !== "by-name" ? (
                <div>
                    <Label htmlFor="spotify-url">Spotify URL</Label>
                    <Input
                        id="spotify-url"
                        placeholder="https://open.spotify.com/track/..."
                        value={spotifyUrl}
                        onChange={(e) => setSpotifyUrl(e.target.value)}
                        disabled={loading}
                    />
                </div>
            ) : (
                <div className="space-y-4">
                    <div>
                        <Label htmlFor="artist-name">Artist Name</Label>
                        <Input
                            id="artist-name"
                            placeholder="The Beatles"
                            value={artistName}
                            onChange={(e) => setArtistName(e.target.value)}
                            disabled={loading}
                        />
                    </div>
                    <div>
                        <Label htmlFor="album-title">Album Title</Label>
                        <Input
                            id="album-title"
                            placeholder="Abbey Road"
                            value={albumTitle}
                            onChange={(e) => setAlbumTitle(e.target.value)}
                            disabled={loading}
                        />
                    </div>
                </div>
            )}
            <Button
                onClick={handleDownload}
                disabled={
                    loading ||
                    (type !== "by-name" ? !spotifyUrl : !artistName || !albumTitle)
                }
                className="w-full"
            >
                {loading ? (
                    <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Downloading...
                    </>
                ) : (
                    <>
                        <Download className="mr-2 h-4 w-4" />
                        Download {type === "track" ? "Track" : type === "album" ? "Album" : type === "artist" ? "Artist" : type === "playlist" ? "Playlist" : "Album"}
                    </>
                )}
            </Button>
        </div>
    );
}
