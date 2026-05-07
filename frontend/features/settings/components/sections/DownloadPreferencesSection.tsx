"use client";

import { SettingsSection, SettingsRow, SettingsSelect, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";

interface DownloadPreferencesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function DownloadPreferencesSection({
    settings,
    onUpdate,
}: DownloadPreferencesSectionProps) {
    // Service configuration detection
    const isLidarrConfigured =
        settings.lidarrEnabled === true &&
        settings.lidarrUrl.trim() !== "" &&
        settings.lidarrApiKey.trim() !== "";

    const isSoulseekConfigured =
        settings.soulseekUsername.trim() !== "" &&
        settings.soulseekPassword.trim() !== "";

    const isSpotiFLACEnabled = settings.spotiflacEnabled === true;

    const areBothServicesConfigured = isLidarrConfigured && isSoulseekConfigured;
    const isDisabled = !areBothServicesConfigured;

    // Dynamic fallback options based on primary source
    const getFallbackOptions = () => {
        if (settings.downloadSource === "soulseek") {
            return [
                { value: "none", label: "Skip track" },
                { value: "lidarr", label: "Download full album via Lidarr" },
                ...(isSpotiFLACEnabled ? [{ value: "spotiflac", label: "Try SpotiFLAC (Lossless)" }] : []),
            ];
        } else if (settings.downloadSource === "lidarr") {
            return [
                { value: "none", label: "Skip album" },
                { value: "soulseek", label: "Try Soulseek for individual tracks" },
                ...(isSpotiFLACEnabled ? [{ value: "spotiflac", label: "Try SpotiFLAC (Lossless)" }] : []),
            ];
        } else {
            return [
                { value: "none", label: "Skip download" },
                { value: "soulseek", label: "Try Soulseek" },
                ...(isLidarrConfigured ? [{ value: "lidarr", label: "Try Lidarr" }] : []),
            ];
        }
    };

    return (
        <SettingsSection
            id="download-preferences"
            title="Download Preferences"
            description="Configure how music is downloaded for playlists and discovery"
        >
            <SettingsRow
                label="Enable SpotiFLAC"
                description="Zero-configuration lossless music downloader from Spotify URLs (Qobuz/Tidal)"
            >
                <SettingsToggle
                    checked={settings.spotiflacEnabled || false}
                    onChange={(checked) =>
                        onUpdate({
                            spotiflacEnabled: checked,
                            // Reset to soulseek if spotiflac was primary and is being disabled
                            ...(settings.downloadSource === "spotiflac" && !checked
                                ? { downloadSource: "soulseek" as const }
                                : {}),
                        })
                    }
                />
            </SettingsRow>

            <SettingsRow
                label="Primary Download Source"
                description={
                    isDisabled && !isSpotiFLACEnabled
                        ? "Requires Soulseek, Lidarr, or SpotiFLAC to be configured"
                        : "Choose how to download music for imported playlists"
                }
            >
                <SettingsSelect
                    value={settings.downloadSource || "soulseek"}
                    onChange={(v) =>
                        onUpdate({
                            downloadSource: v as "soulseek" | "lidarr" | "spotiflac",
                            primaryFailureFallback: "none"
                        })
                    }
                    options={[
                        { value: "soulseek", label: "Soulseek (Per-track)" },
                        { value: "lidarr", label: "Lidarr (Full albums)" },
                        ...(isSpotiFLACEnabled ? [{ value: "spotiflac", label: "SpotiFLAC (Lossless)" }] : []),
                    ]}
                    disabled={isDisabled && !isSpotiFLACEnabled}
                />
            </SettingsRow>

            <SettingsRow
                label={
                    settings.downloadSource === "soulseek"
                        ? "When Soulseek Fails"
                        : settings.downloadSource === "lidarr"
                        ? "When Lidarr Fails"
                        : "When SpotiFLAC Fails"
                }
                description={
                    isDisabled && !isSpotiFLACEnabled
                        ? "Requires Soulseek, Lidarr, or SpotiFLAC to be configured"
                        : settings.downloadSource === "soulseek"
                        ? "What to do if a track can't be found on Soulseek"
                        : settings.downloadSource === "lidarr"
                        ? "What to do if an album can't be found on Lidarr"
                        : "What to do if a download fails on SpotiFLAC"
                }
            >
                <SettingsSelect
                    value={settings.primaryFailureFallback || "none"}
                    onChange={(v) =>
                        onUpdate({
                            primaryFailureFallback: v as "none" | "lidarr" | "soulseek" | "spotiflac",
                        })
                    }
                    options={getFallbackOptions()}
                    disabled={isDisabled && !isSpotiFLACEnabled}
                />
            </SettingsRow>

            <SettingsRow
                label="Soulseek Concurrent Downloads"
                description="Number of simultaneous downloads when using Soulseek (1-10)"
            >
                <SettingsSelect
                    value={settings.soulseekConcurrentDownloads?.toString() || "4"}
                    onChange={(v) =>
                        onUpdate({
                            soulseekConcurrentDownloads: parseInt(v),
                        })
                    }
                    options={[
                        { value: "1", label: "1" },
                        { value: "2", label: "2" },
                        { value: "3", label: "3" },
                        { value: "4", label: "4 (Default)" },
                        { value: "5", label: "5" },
                        { value: "6", label: "6" },
                        { value: "7", label: "7" },
                        { value: "8", label: "8" },
                        { value: "9", label: "9" },
                        { value: "10", label: "10" },
                    ]}
                    disabled={!isSoulseekConfigured}
                />
            </SettingsRow>
        </SettingsSection>
    );
}
