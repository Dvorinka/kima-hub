"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";

interface SpotiFLACJob {
    id: string;
    type: string;
    status: "pending" | "running" | "completed" | "failed";
    progress?: number;
    error?: string;
    createdAt: string;
}

export function SpotiFLACJobStatus() {
    const [jobs, setJobs] = useState<SpotiFLACJob[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchJobs = async () => {
        try {
            const data = await api.getSpotiFLACJobs();
            setJobs(data.jobs || []);
        } catch (error) {
            console.error("Failed to fetch SpotiFLAC jobs:", error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchJobs();
        const interval = setInterval(fetchJobs, 5000);
        return () => clearInterval(interval);
    }, []);

    const getStatusIcon = (status: string) => {
        switch (status) {
            case "completed":
                return <CheckCircle className="h-4 w-4 text-green-500" />;
            case "failed":
                return <XCircle className="h-4 w-4 text-red-500" />;
            case "running":
                return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
            default:
                return <Clock className="h-4 w-4 text-gray-500" />;
        }
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case "completed":
                return <Badge variant="default" className="bg-green-600">Completed</Badge>;
            case "failed":
                return <Badge variant="destructive">Failed</Badge>;
            case "running":
                return <Badge variant="outline" className="text-blue-500">Running</Badge>;
            default:
                return <Badge variant="secondary">Pending</Badge>;
        }
    };

    if (loading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>SpotiFLAC Downloads</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin" />
                    </div>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>SpotiFLAC Downloads</CardTitle>
            </CardHeader>
            <CardContent>
                {jobs.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No active downloads</p>
                ) : (
                    <div className="space-y-3">
                        {jobs.map((job) => (
                            <div key={job.id} className="border rounded-lg p-3 space-y-2">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        {getStatusIcon(job.status)}
                                        <span className="font-medium capitalize">{job.type}</span>
                                        {getStatusBadge(job.status)}
                                    </div>
                                    <span className="text-xs text-muted-foreground">
                                        {new Date(job.createdAt).toLocaleString()}
                                    </span>
                                </div>
                                {job.status === "running" && job.progress !== undefined && (
                                    <Progress value={job.progress} className="h-2" />
                                )}
                                {job.status === "failed" && job.error && (
                                    <p className="text-sm text-red-500">{job.error}</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
