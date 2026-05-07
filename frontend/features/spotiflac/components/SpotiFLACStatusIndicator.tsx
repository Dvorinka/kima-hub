"use client";

import { useSpotiFLACStatus } from "../hooks";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, AlertCircle } from "lucide-react";

export function SpotiFLACStatusIndicator() {
    const { status, loading } = useSpotiFLACStatus();

    if (loading) {
        return (
            <Badge variant="outline" className="gap-2">
                <AlertCircle className="h-3 w-3 animate-pulse" />
                Checking...
            </Badge>
        );
    }

    if (!status) {
        return null;
    }

    if (!status.enabled) {
        return (
            <Badge variant="secondary" className="gap-2">
                <XCircle className="h-3 w-3" />
                Disabled
            </Badge>
        );
    }

    if (status.available) {
        return (
            <Badge variant="default" className="gap-2 bg-green-600">
                <CheckCircle className="h-3 w-3" />
                Available
            </Badge>
        );
    }

    return (
        <Badge variant="destructive" className="gap-2">
            <XCircle className="h-3 w-3" />
            {status.message}
        </Badge>
    );
}
