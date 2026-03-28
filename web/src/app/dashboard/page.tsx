"use client";

import { trpc } from "@/lib/trpc";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
	if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
	return `${(b / 1073741824).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function StatusBadge({ code }: { code: number }) {
	const color = code < 300 ? "text-green-400" : code < 500 ? "text-yellow-400" : "text-red-400";
	return <span className={color}>{code}</span>;
}

function TypeTag({ type }: { type: string }) {
	const colors: Record<string, string> = {
		search: "bg-cyan-500/15 text-cyan-400",
		download: "bg-purple-500/15 text-purple-400",
		changelog: "bg-green-500/15 text-green-400",
		other: "bg-gray-500/15 text-gray-400",
	};
	return (
		<span
			className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${colors[type] || colors.other}`}
		>
			{type}
		</span>
	);
}

export default function DashboardPage() {
	const router = useRouter();
	const { data: branding } = trpc.branding.useQuery();
	const { data: stats, refetch } = trpc.stats.useQuery(undefined, {
		refetchInterval: 5000,
	});
	const logout = trpc.auth.logout.useMutation();

	const accent = branding?.branding?.accentColor || "#00d4ff";
	const name = branding?.branding?.serverName || "iPod Dashboard";
	const motd = branding?.branding?.motd;
	const logo = branding?.branding?.logoUrl;

	useEffect(() => {
		if (branding && !branding.setupComplete) router.replace("/setup");
	}, [branding, router]);

	const handleLogout = async () => {
		try {
			await logout.mutateAsync();
		} catch {
			// ignore
		}
		document.cookie = "dash_session=; path=/; max-age=0";
		router.push("/login");
	};

	if (!stats) {
		return (
			<div className="flex items-center justify-center min-h-screen">
				<div className="animate-pulse text-gray-500">Loading dashboard...</div>
			</div>
		);
	}

	const bw = stats.bandwidthByMinute || [];
	const last60 = bw.slice(-60);
	const maxBucket = Math.max(1, ...last60.map((b: { bytes: number }) => b.bytes));
	const ep = stats.byEndpoint || {};

	const maxEpBytes = Math.max(
		1,
		...Object.values(ep as Record<string, { bytes: number }>)
			.filter((_, i) => Object.keys(ep)[i] !== "dashboard")
			.map((e) => e.bytes),
	);

	return (
		<div className="min-h-screen">
			{/* Header */}
			<div className="bg-gradient-to-r from-[#1a1a2e] to-[#0d0d1a] px-6 py-4 border-b border-[#2a2a3a] flex items-center justify-between">
				<div className="flex items-center gap-3">
					{logo && (
						<img
							src={logo}
							alt=""
							className="w-8 h-8 rounded-lg"
							onError={(e) => {
								(e.target as HTMLImageElement).style.display = "none";
							}}
						/>
					)}
					<h1 className="text-lg font-bold" style={{ color: accent }}>
						{name}
					</h1>
					<span className="text-gray-600 text-sm">Up {formatDuration(stats.uptime || 0)}</span>
				</div>
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={() => refetch()}
						className="px-3 py-1.5 bg-[#1a2a3a] border border-[#2a3a4a] rounded-md text-sm hover:bg-[#2a3a4a] transition-colors"
						style={{ color: accent }}
					>
						Refresh
					</button>
					<button
						type="button"
						onClick={() => router.push("/dashboard/settings")}
						className="px-3 py-1.5 bg-[#1a2a3a] border border-[#2a3a4a] rounded-md text-sm text-gray-400 hover:bg-[#2a3a4a] transition-colors"
					>
						Settings
					</button>
					<button
						type="button"
						onClick={handleLogout}
						className="px-3 py-1.5 border border-red-500/20 rounded-md text-sm text-red-400 hover:bg-red-500/10 transition-colors"
					>
						Logout
					</button>
				</div>
			</div>

			{/* MOTD */}
			{motd && (
				<div className="mx-6 mt-4 p-3 rounded-lg bg-[#12121f] border border-[#1e1e2e] text-sm text-gray-400">
					{motd}
				</div>
			)}

			{/* Stats Grid */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-6">
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-2">Total Requests</div>
					<div className="text-3xl font-bold" style={{ color: accent }}>
						{(stats.totalRequests || 0).toLocaleString()}
					</div>
					{bw.length > 0 && (
						<div className="text-xs text-gray-600 mt-1">{bw[bw.length - 1].requests} req/min</div>
					)}
				</div>
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-2">Bandwidth Out</div>
					<div className="text-3xl font-bold" style={{ color: accent }}>
						{formatBytes(stats.totalBytesOut || 0)}
					</div>
					{bw.length > 0 && (
						<div className="text-xs text-gray-600 mt-1">
							{formatBytes(bw[bw.length - 1].bytes)}/min
						</div>
					)}
				</div>
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-2">Active Streams</div>
					<div className="text-3xl font-bold text-green-400">
						{(stats.activeStreams || []).length}
					</div>
					<div className="text-xs text-gray-600 mt-1">
						{(stats.activeStreams || []).length === 0 ? "No active streams" : "Streaming now"}
					</div>
				</div>
			</div>

			{/* Endpoint bars + Bandwidth chart */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4 px-6">
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-4">
						Bandwidth by Endpoint
					</div>
					{Object.entries(ep as Record<string, { bytes: number; count: number; errors: number }>)
						.filter(([name]) => name !== "dashboard")
						.map(([name, val]) => (
							<div key={name} className="flex items-center gap-3 mb-2">
								<span className="w-20 text-xs text-gray-500">{name}</span>
								<div className="flex-1 h-4 bg-[#0a0a14] rounded overflow-hidden">
									<div
										className="h-full rounded transition-all"
										style={{
											width: `${(val.bytes / maxEpBytes) * 100}%`,
											backgroundColor:
												name === "search"
													? accent
													: name === "download"
														? "#a855f7"
														: name === "changelog"
															? "#4ade80"
															: "#666",
										}}
									/>
								</div>
								<span className="text-xs text-gray-500 w-28 text-right">
									{formatBytes(val.bytes)} ({val.count})
								</span>
							</div>
						))}
				</div>
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-4">
						Bandwidth / Minute
					</div>
					<div className="h-28 flex items-end gap-px">
						{last60.length === 0 && (
							<div className="flex-1 text-center text-gray-600 text-xs py-8">No data yet</div>
						)}
						{last60.map((b: { ts: number; bytes: number }, i: number) => (
							<div
								key={b.ts}
								className="flex-1 min-w-[2px] rounded-t opacity-70 hover:opacity-100 transition-opacity"
								style={{
									height: `${Math.max(2, (b.bytes / maxBucket) * 100)}%`,
									backgroundColor: accent,
								}}
								title={formatBytes(b.bytes)}
							/>
						))}
					</div>
				</div>
			</div>

			{/* Active Streams */}
			<div className="px-6 mt-4">
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-4">Active Streams</div>
					{(stats.activeStreams || []).length === 0 ? (
						<div className="text-gray-600 text-sm text-center py-6">No active streams</div>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="text-left text-gray-600">
									<th className="pb-2 font-medium">Source</th>
									<th className="pb-2 font-medium">Client</th>
									<th className="pb-2 font-medium">Duration</th>
									<th className="pb-2 font-medium">Sent</th>
								</tr>
							</thead>
							<tbody>
								{(
									stats.activeStreams as Array<{
										source: string;
										clientIp: string;
										startedAt: number;
										bytesOut: number;
									}>
								).map((s, i) => (
									<tr key={i} className="border-t border-[#0d0d18]">
										<td className="py-2 truncate max-w-[200px]">{s.source}</td>
										<td className="py-2">{s.clientIp}</td>
										<td className="py-2">{formatDuration(Date.now() - s.startedAt)}</td>
										<td className="py-2">{formatBytes(s.bytesOut)}</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			</div>

			{/* Request Log */}
			<div className="px-6 mt-4 pb-8">
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-5">
					<div className="text-xs uppercase tracking-wider text-gray-600 mb-4">
						Request Log (latest 100)
					</div>
					<div className="max-h-96 overflow-y-auto">
						{(stats.requestLog || []).length === 0 ? (
							<div className="text-gray-600 text-sm text-center py-6">No requests yet</div>
						) : (
							<table className="w-full text-sm">
								<thead>
									<tr className="text-left text-gray-600">
										<th className="pb-2 font-medium">Time</th>
										<th className="pb-2 font-medium">Type</th>
										<th className="pb-2 font-medium">Path</th>
										<th className="pb-2 font-medium">Status</th>
										<th className="pb-2 font-medium">Time</th>
										<th className="pb-2 font-medium">Size</th>
									</tr>
								</thead>
								<tbody>
									{[
										...(stats.requestLog as Array<{
											ts: number;
											type: string;
											path: string;
											status: number;
											ms: number;
											bytes: number;
										}>),
									]
										.reverse()
										.slice(0, 100)
										.map((l, i) => (
											<tr key={i} className="border-t border-[#0d0d18]">
												<td className="py-1.5">{new Date(l.ts).toLocaleTimeString()}</td>
												<td className="py-1.5">
													<TypeTag type={l.type} />
												</td>
												<td className="py-1.5 truncate max-w-[200px]" title={l.path}>
													{l.path.length > 40 ? `${l.path.slice(0, 40)}...` : l.path}
												</td>
												<td className="py-1.5">
													<StatusBadge code={l.status} />
												</td>
												<td className="py-1.5">{l.ms}ms</td>
												<td className="py-1.5">{formatBytes(l.bytes)}</td>
											</tr>
										))}
								</tbody>
							</table>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
