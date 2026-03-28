import { execSync } from "node:child_process";

export interface PrereqResult {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
	detail?: string;
}

function checkBinary(name: string, versionFlag: string): PrereqResult {
	try {
		const output = execSync(`${name} ${versionFlag}`, {
			timeout: 10000,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const firstLine = output.split("\n")[0] ?? "";
		return { name, status: "pass", message: `Installed`, detail: firstLine };
	} catch {
		return { name, status: "fail", message: "Not found — install it first", detail: "" };
	}
}

function checkRapidApi(): PrereqResult {
	const keys = (process.env.RAPIDAPI_API_KEYS || "")
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	const hasKey = keys.length > 0 && keys[0] !== "YOUR API KEY HERE";
	if (hasKey) {
		return {
			name: "RapidAPI Key",
			status: "pass",
			message: `${keys.length} key(s) configured`,
			detail: `First key: ${keys[0]?.slice(0, 8)}...`,
		};
	}
	return {
		name: "RapidAPI Key",
		status: "warn",
		message: "Not configured — yt-dlp fallback will be used",
		detail: "Set RAPIDAPI_API_KEYS in functions/.env for faster search",
	};
}

function checkConnectivity(): PrereqResult {
	try {
		const output = execSync(
			'yt-dlp --dump-json --flat-playlist --skip-download "ytsearch1:test audio"',
			{ timeout: 30000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
		const parsed = JSON.parse(output.split("\n")[0] ?? "{}");
		if (parsed.id) {
			return {
				name: "Connectivity",
				status: "pass",
				message: "YouTube search works",
				detail: `Found: ${parsed.title ?? parsed.id}`,
			};
		}
		return { name: "Connectivity", status: "fail", message: "yt-dlp returned no results" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			name: "Connectivity",
			status: "fail",
			message: "Connection test failed",
			detail: msg.slice(0, 200),
		};
	}
}

function checkPort(): PrereqResult {
	return {
		name: "Server Port",
		status: "pass",
		message: `Listening on :${process.env.PORT || 8080}`,
	};
}

export function runAllChecks(): PrereqResult[] {
	return [
		checkBinary("yt-dlp", "--version"),
		checkBinary("ffmpeg", "-version"),
		checkRapidApi(),
		checkPort(),
		checkConnectivity(),
	];
}
