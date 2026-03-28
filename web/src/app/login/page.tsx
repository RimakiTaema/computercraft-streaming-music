"use client";

import { trpc } from "@/lib/trpc";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
	const router = useRouter();
	const { data: brandingData } = trpc.branding.useQuery();
	const branding = brandingData?.branding;
	const login = trpc.auth.login.useMutation();

	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");

	const accent = branding?.accentColor || "#00d4ff";

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		try {
			const result = await login.mutateAsync({ username, password });
			// Set cookie client-side for the session token
			document.cookie = `dash_session=${result.token}; path=/; max-age=${86400}; samesite=strict`;
			router.push("/dashboard");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login failed");
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<form
				onSubmit={handleLogin}
				className="w-full max-w-sm bg-[#12121f] border border-[#1e1e2e] rounded-2xl p-10 shadow-2xl"
			>
				{/* Logo / Icon */}
				<div className="text-center mb-6">
					{branding?.logoUrl ? (
						<img
							src={branding.logoUrl}
							alt=""
							className="w-16 h-16 mx-auto rounded-xl mb-3"
							onError={(e) => {
								(e.target as HTMLImageElement).style.display = "none";
							}}
						/>
					) : (
						<div className="text-5xl mb-3">&#127925;</div>
					)}
					<h1 className="text-xl font-bold" style={{ color: accent }}>
						{branding?.serverName || "iPod Dashboard"}
					</h1>
					<p className="text-gray-500 text-sm mt-1">Sign in to continue</p>
				</div>

				{error && (
					<div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
						{error}
					</div>
				)}

				<div className="space-y-4">
					<div>
						<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
							Username
						</label>
						<input
							type="text"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							required
							autoFocus
							className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors"
						/>
					</div>
					<div>
						<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
							Password
						</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors"
						/>
					</div>
				</div>

				<button
					type="submit"
					disabled={login.isPending}
					className="w-full mt-6 py-3 rounded-lg text-white font-semibold transition-opacity disabled:opacity-50"
					style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
				>
					{login.isPending ? "Signing in..." : "Sign In"}
				</button>
			</form>
		</div>
	);
}
