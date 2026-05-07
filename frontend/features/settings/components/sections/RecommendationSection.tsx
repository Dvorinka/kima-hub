"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsSelect, SettingsInput } from "../ui";
import { SystemSettings } from "../../types";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface RecommendationSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function RecommendationSection({
    settings,
    onUpdate,
}: RecommendationSectionProps) {
    const [newArtist, setNewArtist] = useState("");
    const [newGenre, setNewGenre] = useState("");

    const addExcludedArtist = () => {
        if (!newArtist.trim()) return;
        const excluded = settings.excludedArtists || [];
        if (!excluded.includes(newArtist.trim())) {
            onUpdate({
                excludedArtists: [...excluded, newArtist.trim()],
            });
        }
        setNewArtist("");
    };

    const removeExcludedArtist = (artist: string) => {
        const excluded = settings.excludedArtists || [];
        onUpdate({
            excludedArtists: excluded.filter((a) => a !== artist),
        });
    };

    const addExcludedGenre = () => {
        if (!newGenre.trim()) return;
        const excluded = settings.excludedGenres || [];
        if (!excluded.includes(newGenre.trim())) {
            onUpdate({
                excludedGenres: [...excluded, newGenre.trim()],
            });
        }
        setNewGenre("");
    };

    const removeExcludedGenre = (genre: string) => {
        const excluded = settings.excludedGenres || [];
        onUpdate({
            excludedGenres: excluded.filter((g) => g !== genre),
        });
    };

    return (
        <SettingsSection
            id="recommendation-settings"
            title="Recommendation Settings"
            description="Configure how recommendations are generated for Discover Weekly"
        >
            <SettingsRow
                label="Recommendation Mode"
                description="Balance between familiar music and new discoveries"
            >
                <SettingsSelect
                    value={settings.recommendationMode || "balanced"}
                    onChange={(v) =>
                        onUpdate({
                            recommendationMode: v as "comfort" | "discovery" | "balanced",
                        })
                    }
                    options={[
                        { value: "comfort", label: "Comfort (More familiar)" },
                        { value: "balanced", label: "Balanced (Mix of both)" },
                        { value: "discovery", label: "Discovery (More new)" },
                    ]}
                />
            </SettingsRow>

            <SettingsRow
                label="Excluded Artists"
                description="Artists you don't want in recommendations"
            >
                <div className="space-y-2">
                    <div className="flex gap-2">
                        <SettingsInput
                            placeholder="Artist name"
                            value={newArtist}
                            onChange={(v) => setNewArtist(v)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    addExcludedArtist();
                                }
                            }}
                        />
                        <Button
                            type="button"
                            onClick={addExcludedArtist}
                            disabled={!newArtist.trim()}
                        >
                            Add
                        </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {(settings.excludedArtists || []).map((artist) => (
                            <div
                                key={artist}
                                className="flex items-center gap-1 px-3 py-1 bg-secondary rounded-full text-sm"
                            >
                                {artist}
                                <button
                                    type="button"
                                    onClick={() => removeExcludedArtist(artist)}
                                    className="hover:text-destructive"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                        {(settings.excludedArtists || []).length === 0 && (
                            <span className="text-muted-foreground text-sm">
                                No excluded artists
                            </span>
                        )}
                    </div>
                </div>
            </SettingsRow>

            <SettingsRow
                label="Excluded Genres"
                description="Genres you don't want in recommendations"
            >
                <div className="space-y-2">
                    <div className="flex gap-2">
                        <SettingsInput
                            placeholder="Genre name"
                            value={newGenre}
                            onChange={(v) => setNewGenre(v)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    addExcludedGenre();
                                }
                            }}
                        />
                        <Button
                            type="button"
                            onClick={addExcludedGenre}
                            disabled={!newGenre.trim()}
                        >
                            Add
                        </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {(settings.excludedGenres || []).map((genre) => (
                            <div
                                key={genre}
                                className="flex items-center gap-1 px-3 py-1 bg-secondary rounded-full text-sm"
                            >
                                {genre}
                                <button
                                    type="button"
                                    onClick={() => removeExcludedGenre(genre)}
                                    className="hover:text-destructive"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            </div>
                        ))}
                        {(settings.excludedGenres || []).length === 0 && (
                            <span className="text-muted-foreground text-sm">
                                No excluded genres
                            </span>
                        )}
                    </div>
                </div>
            </SettingsRow>
        </SettingsSection>
    );
}
