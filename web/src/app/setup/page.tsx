"use client";

import { trpc } from "@/lib/trpc";
import { useRouter } from "next/navigation";
import { useState } from "react";

type PrereqResult = {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
	detail?: string;
};

export default function SetupPage() {
	const router = useRouter();
	const [step, setStep] = useState(1);
	const [prereqs, setPrereqs] = useState<PrereqResult[]>([]);
	const [checking, setChecking] = useState(false);

	// Admin form
	const [username, setUsername] = useState("admin");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [adminError, setAdminError] = useState("");

	// Branding form
	const [serverName, setServerName] = useState("iPod Dashboard");
	const [accentColor, setAccentColor] = useState("#00d4ff");
	const [logoUrl, setLogoUrl] = useState("");
	const [motd, setMotd] = useState("");

	const checkPrereqs = trpc.setup.checkPrerequisites.useMutation();
	const createAdmin = trpc.setup.createAdmin.useMutation();
	const saveBranding = trpc.setup.saveBranding.useMutation();
	const completeSetup = trpc.setup.complete.useMutation();

	const handleCheckPrereqs = async () => {
		setChecking(true);
		try {
			const results = await checkPrereqs.mutateAsync();
			setPrereqs(results);
		} catch {
			setPrereqs([{ name: "Check", status: "fail", message: "Failed to run checks" }]);
		}
		setChecking(false);
	};

	const handleCreateAdmin = async () => {
		setAdminError("");
		if (password !== confirmPassword) {
			setAdminError("Passwords do not match");
			return;
		}
		if (password.length < 6) {
			setAdminError("Password must be at least 6 characters");
			return;
		}
		try {
			await createAdmin.mutateAsync({ username, password });
			setStep(3);
		} catch (e) {
			setAdminError(e instanceof Error ? e.message : "Failed to create admin");
		}
	};

	const handleSaveBranding = async () => {
		try {
			await saveBranding.mutateAsync({ serverName, accentColor, logoUrl, motd });
			await completeSetup.mutateAsync();
			setStep(4);
		} catch {
			// ignore
		}
	};

	const statusIcon = (s: string) => {
		if (s === "pass") return <span className="text-green-400 text-lg">&#10003;</span>;
		if (s === "warn") return <span className="text-yellow-400 text-lg">&#9888;</span>;
		return <span className="text-red-400 text-lg">&#10007;</span>;
	};

	return (
		<div className="min-h-screen flex items-center justify-center p-4">
			<div className="w-full max-w-lg">
				{/* Progress bar */}
				<div className="flex items-center gap-2 mb-8">
					{[1, 2, 3, 4].map((s) => (
						<div key={s} className="flex-1">
							<div
								className={`h-1.5 rounded-full transition-colors ${s <= step ? "bg-cyan-500" : "bg-gray-800"}`}
							/>
							<div
								className={`text-[10px] mt-1 text-center ${s === step ? "text-cyan-400" : "text-gray-600"}`}
							>
								{s === 1 && "Prerequisites"}
								{s === 2 && "Admin Account"}
								{s === 3 && "Branding"}
								{s === 4 && "Complete"}
							</div>
						</div>
					))}
				</div>

				<div className="bg-[#12121f] border border-[#1e1e2e] rounded-2xl p-8 shadow-2xl">
					{/* Step 1: Prerequisites */}
					{step === 1 && (
						<>
							<h1 className="text-2xl font-bold text-cyan-400 mb-2">Server Setup</h1>
							<p className="text-gray-500 text-sm mb-6">
								Check that all required dependencies are installed.
							</p>

							{prereqs.length === 0 && !checking && (
								<button
									type="button"
									onClick={handleCheckPrereqs}
									className="w-full py-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-colors"
								>
									Run Prerequisite Check
								</button>
							)}

							{checking && (
								<div className="text-center py-8 text-gray-400 animate-pulse">
									Checking prerequisites...
								</div>
							)}

							{prereqs.length > 0 && (
								<div className="space-y-3 mb-6">
									{prereqs.map((p) => (
										<div
											key={p.name}
											className="flex items-start gap-3 p-3 rounded-lg bg-[#0a0a14]"
										>
											<div className="mt-0.5">{statusIcon(p.status)}</div>
											<div className="flex-1 min-w-0">
												<div className="text-sm font-medium text-white">{p.name}</div>
												<div className="text-xs text-gray-400">{p.message}</div>
												{p.detail && (
													<div className="text-xs text-gray-600 truncate mt-0.5">{p.detail}</div>
												)}
											</div>
										</div>
									))}
								</div>
							)}

							{prereqs.length > 0 && (
								<div className="flex gap-3">
									<button
										type="button"
										onClick={handleCheckPrereqs}
										className="flex-1 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
									>
										Re-check
									</button>
									<button
										type="button"
										onClick={() => setStep(2)}
										disabled={prereqs.some((p) => p.status === "fail")}
										className="flex-1 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-cyan-600"
									>
										{prereqs.some((p) => p.status === "fail")
											? "Fix issues first"
											: "Continue"}
									</button>
								</div>
							)}
						</>
					)}

					{/* Step 2: Create Admin */}
					{step === 2 && (
						<>
							<h1 className="text-2xl font-bold text-cyan-400 mb-2">Create Admin Account</h1>
							<p className="text-gray-500 text-sm mb-6">
								This account will be used to access the dashboard.
							</p>

							{adminError && (
								<div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
									{adminError}
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
										placeholder="Min 6 characters"
										className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors"
									/>
								</div>
								<div>
									<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
										Confirm Password
									</label>
									<input
										type="password"
										value={confirmPassword}
										onChange={(e) => setConfirmPassword(e.target.value)}
										className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors"
									/>
								</div>
							</div>

							<div className="flex gap-3 mt-6">
								<button
									type="button"
									onClick={() => setStep(1)}
									className="flex-1 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
								>
									Back
								</button>
								<button
									type="button"
									onClick={handleCreateAdmin}
									disabled={createAdmin.isPending}
									className="flex-1 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-colors disabled:opacity-50"
								>
									{createAdmin.isPending ? "Creating..." : "Create Account"}
								</button>
							</div>
						</>
					)}

					{/* Step 3: Branding */}
					{step === 3 && (
						<>
							<h1 className="text-2xl font-bold text-cyan-400 mb-2">Customize Branding</h1>
							<p className="text-gray-500 text-sm mb-6">Personalize how your dashboard looks.</p>

							<div className="space-y-4">
								<div>
									<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
										Server Name
									</label>
									<input
										type="text"
										value={serverName}
										onChange={(e) => setServerName(e.target.value)}
										className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors"
									/>
								</div>
								<div>
									<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
										Accent Color
									</label>
									<div className="flex items-center gap-3">
										<input
											type="color"
											value={accentColor}
											onChange={(e) => setAccentColor(e.target.value)}
											className="w-12 h-10 rounded-lg border border-[#2a2a3a] cursor-pointer bg-transparent"
										/>
										<input
											type="text"
											value={accentColor}
											onChange={(e) => setAccentColor(e.target.value)}
											className="flex-1 px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors font-mono text-sm"
										/>
									</div>
								</div>
								<div>
									<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
										Logo URL <span className="text-gray-600">(optional)</span>
									</label>
									<input
										type="url"
										value={logoUrl}
										onChange={(e) => setLogoUrl(e.target.value)}
										placeholder="https://example.com/logo.png"
										className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors"
									/>
								</div>
								<div>
									<label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">
										Message of the Day <span className="text-gray-600">(optional)</span>
									</label>
									<textarea
										value={motd}
										onChange={(e) => setMotd(e.target.value)}
										rows={2}
										placeholder="Welcome to the server!"
										className="w-full px-4 py-3 bg-[#0a0a14] border border-[#2a2a3a] rounded-lg text-white outline-none focus:border-cyan-500 transition-colors resize-none"
									/>
								</div>
							</div>

							{/* Preview */}
							<div className="mt-4 p-4 rounded-lg bg-[#0a0a14] border border-[#1a1a2a]">
								<div className="text-xs text-gray-600 mb-2 uppercase tracking-wider">Preview</div>
								<div className="flex items-center gap-2">
									{logoUrl && (
										<img
											src={logoUrl}
											alt=""
											className="w-6 h-6 rounded"
											onError={(e) => {
												(e.target as HTMLImageElement).style.display = "none";
											}}
										/>
									)}
									<span style={{ color: accentColor }} className="font-bold">
										{serverName}
									</span>
								</div>
								{motd && <p className="text-gray-500 text-xs mt-1">{motd}</p>}
							</div>

							<div className="flex gap-3 mt-6">
								<button
									type="button"
									onClick={() => setStep(2)}
									className="flex-1 py-2.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm transition-colors"
								>
									Back
								</button>
								<button
									type="button"
									onClick={handleSaveBranding}
									disabled={saveBranding.isPending || completeSetup.isPending}
									className="flex-1 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-colors disabled:opacity-50"
								>
									{saveBranding.isPending ? "Saving..." : "Complete Setup"}
								</button>
							</div>
						</>
					)}

					{/* Step 4: Done */}
					{step === 4 && (
						<div className="text-center py-4">
							<div className="text-5xl mb-4">&#10003;</div>
							<h1 className="text-2xl font-bold text-green-400 mb-2">Setup Complete!</h1>
							<p className="text-gray-500 text-sm mb-6">
								Your server is ready. Sign in with your admin account.
							</p>
							<button
								type="button"
								onClick={() => router.push("/login")}
								className="px-8 py-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition-colors"
							>
								Go to Login
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
