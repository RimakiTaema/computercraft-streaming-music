"use client";

import { trpc } from "@/lib/trpc";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Home() {
	const router = useRouter();
	const { data: branding, isLoading } = trpc.branding.useQuery();
	const { data: authStatus } = trpc.auth.check.useQuery();

	useEffect(() => {
		if (isLoading) return;
		if (!branding?.setupComplete) {
			router.replace("/setup");
		} else if (!authStatus?.authenticated) {
			router.replace("/login");
		} else {
			router.replace("/dashboard");
		}
	}, [branding, authStatus, isLoading, router]);

	return (
		<div className="flex items-center justify-center min-h-screen">
			<div className="animate-pulse text-gray-500">Loading...</div>
		</div>
	);
}
