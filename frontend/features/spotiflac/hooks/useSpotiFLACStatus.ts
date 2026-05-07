import { api } from "@/lib/api";
import { useEffect, useState } from "react";

export interface SpotiFLACStatus {
    available: boolean;
    enabled: boolean;
    zeroConfig: boolean;
    sources: string[];
    message: string;
}

export function useSpotiFLACStatus(refreshInterval?: number) {
    const [status, setStatus] = useState<SpotiFLACStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchStatus = async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await api.getSpotiFLACStatus();
            setStatus(data);
        } catch (err: unknown) {
            console.error("Failed to fetch SpotiFLAC status:", err);
            const error = err as Error;
            setError(error.message || "Failed to fetch status");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchStatus();

        if (refreshInterval) {
            const interval = setInterval(fetchStatus, refreshInterval);
            return () => clearInterval(interval);
        }
    }, [refreshInterval]);

    return { status, loading, error, refetch: fetchStatus };
}
