"use client";

import { trpc } from "@/lib/trpc";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function SettingsPage() {
	const router = useRouter();
	const { data: branding, refetch } = trpc.settings.getBranding.useQuery();
	const updateBranding = trpc.settings.updateBranding.useMutation();
	const changePassword = trpc.settings.changePassword.useMutation();

	const [serverName, setServerName] = useState("");
	const [accentColor, setAccentColor] = useState("#00d4ff");
	const [logoUrl, setLogoUrl] = useState("");
	const [motd, setMotd] = useState("");
	const [saved, setSaved] = useState(false);

	const [curPassword, setCurPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [pwError, setPwError] = useState("");
	const [pwSaved, setPwSaved] = useState(false);

	useEffect(() => {
		if (branding) {
			setServerName(branding.serverName);
			setAccentColor(branding.accentColor);
			setLogoUrl(branding.logoUrl);
			setMotd(branding.motd);
		}
	}, [branding]);

	const handleSave = async () => {
		setSaved(false);
		await updateBranding.mutateAsync({ serverName, accentColor, logoUrl, motd });
		await refetch();
		setSaved(true);
		setTimeout(() => setSaved(false), 2000);
	};

	const handleChangePassword = async () => {
		setPwError("");
		setPwSaved(false);
		try {
			await changePassword.mutateAsync({ currentPassword: curPassword, newPassword });
			setCurPassword("");
			setNewPassword("");
			setPwSaved(true);
			setTimeout(() => setPwSaved(false), 2000);
		} catch (e) {
			setPwError(e instanceof Error ? e.message : "Failed");
		}
	};

	return (
		<div className="min-h-screen">
			<div className="bg-gradient-to-r from-[#1a1a2e] to-[#0d0d1a] px-6 py-4 border-b border-[#2a2a3a] flex items-center justify-between">
				<h1 className="text-lg font-bold text-cyan-400">Settings</h1>
				<button
					type="button"
					onClick={() => router.push("/home")}
					className="px-3 py-1.5 bg-[#1a2a3a] border border-[#2a3a4a] rounded-md text-sm text-gray-400 hover:bg-[#2a3a4a] transition-colors"
				>
					Back to Dashboard
				</button>
			</div>

			<div className="max-w-2xl mx-auto p-6 space-y-8">
				{/* Branding */}
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-6">
					<h2 className="text-sm uppercase tracking-wider text-gray-500 mb-4">Branding</h2>
					<div className="space-y-4">
						<div>
							<label className="block text-xs text-gray-500 mb-1.5">Server Name</label>
							<input
								type="text"
								value={serverName}
								onChange={(e) => setServerName(e.target.value)}
								className="w-full px-4 py-2.5 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500"
							/>
						</div>
						<div>
							<label className="block text-xs text-gray-500 mb-1.5">Accent Color</label>
							<div className="flex gap-3">
								<input
									type="color"
									value={accentColor}
									onChange={(e) => setAccentColor(e.target.value)}
									className="w-10 h-10 rounded border border-[#2a2a3a] cursor-pointer bg-transparent"
								/>
								<input
									type="text"
									value={accentColor}
									onChange={(e) => setAccentColor(e.target.value)}
									className="flex-1 px-4 py-2.5 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 font-mono text-sm"
								/>
							</div>
						</div>
						<div>
							<label className="block text-xs text-gray-500 mb-1.5">Logo URL</label>
							<input
								type="url"
								value={logoUrl}
								onChange={(e) => setLogoUrl(e.target.value)}
								placeholder="https://..."
								className="w-full px-4 py-2.5 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500"
							/>
						</div>
						<div>
							<label className="block text-xs text-gray-500 mb-1.5">MOTD</label>
							<textarea
								value={motd}
								onChange={(e) => setMotd(e.target.value)}
								rows={2}
								className="w-full px-4 py-2.5 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 resize-none"
							/>
						</div>
					</div>
					<button
						type="button"
						onClick={handleSave}
						disabled={updateBranding.isPending}
						className="mt-4 px-6 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
					>
						{updateBranding.isPending ? "Saving..." : saved ? "Saved!" : "Save Branding"}
					</button>
				</div>

				{/* Change Password */}
				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-xl p-6">
					<h2 className="text-sm uppercase tracking-wider text-gray-500 mb-4">Change Password</h2>
					{pwError && (
						<div className="mb-3 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
							{pwError}
						</div>
					)}
					<div className="space-y-3">
						<input
							type="password"
							value={curPassword}
							onChange={(e) => setCurPassword(e.target.value)}
							placeholder="Current password"
							className="w-full px-4 py-2.5 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500"
						/>
						<input
							type="password"
							value={newPassword}
							onChange={(e) => setNewPassword(e.target.value)}
							placeholder="New password (min 6 chars)"
							className="w-full px-4 py-2.5 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500"
						/>
					</div>
					<button
						type="button"
						onClick={handleChangePassword}
						disabled={changePassword.isPending || !curPassword || newPassword.length < 6}
						className="mt-4 px-6 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
					>
						{changePassword.isPending ? "Changing..." : pwSaved ? "Changed!" : "Change Password"}
					</button>
				</div>
			</div>
		</div>
	);
}
