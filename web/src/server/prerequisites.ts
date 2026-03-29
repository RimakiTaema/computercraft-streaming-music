import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface PrereqResult {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
	detail?: string;
}

const API_BASE = process.env.API_URL || "http://localhost:8080";
const IS_WINDOWS = process.platform === "win32";

// Common install locations per platform
const WIN_EXTRA_PATHS = [
	// winget
	join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
	join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages"),
	// chocolatey
	join(process.env.PROGRAMDATA || "C:\\ProgramData", "chocolatey", "bin"),
	// scoop
	process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "shims") : "",
	// manual / common locations
	join(process.env.LOCALAPPDATA || "", "Programs", "yt-dlp"),
	join(process.env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin"),
	join(process.env.PROGRAMFILES || "", "yt-dlp"),
	join(process.env.PROGRAMFILES || "", "ffmpeg", "bin"),
	join(process.env.PROGRAMFILES || "", "ffmpeg"),
	"C:\\ffmpeg\\bin",
	"C:\\ffmpeg",
	"C:\\yt-dlp",
	"C:\\Tools",
	// pip / python scripts
	process.env.LOCALAPPDATA
		? join(process.env.LOCALAPPDATA, "Programs", "Python", "Python311", "Scripts")
		: "",
	process.env.LOCALAPPDATA
		? join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "Scripts")
		: "",
	process.env.LOCALAPPDATA
		? join(process.env.LOCALAPPDATA, "Programs", "Python", "Python313", "Scripts")
		: "",
	process.env.USERPROFILE ? join(process.env.USERPROFILE, ".local", "bin") : "",
	process.env.APPDATA ? join(process.env.APPDATA, "Python", "Scripts") : "",
];

const UNIX_EXTRA_PATHS = [
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/snap/bin",
	process.env.HOME ? join(process.env.HOME, ".local", "bin") : "",
];

const EXTRA_PATH = (IS_WINDOWS ? WIN_EXTRA_PATHS : UNIX_EXTRA_PATHS)
	.filter(Boolean)
	.join(delimiter);

function execWithPath(cmd: string, timeout = 10000): string {
	const env = {
		...process.env,
		PATH: `${process.env.PATH || ""}${delimiter}${EXTRA_PATH}`,
	};
	return execSync(cmd, {
		timeout,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		env,
		shell: IS_WINDOWS ? "cmd.exe" : "/bin/bash",
	}).trim();
}

function checkBinary(name: string, versionFlag: string): PrereqResult {
	// First try: run directly with expanded PATH
	try {
		const output = execWithPath(`${name} ${versionFlag}`);
		const firstLine = output.split("\n")[0] ?? "";
		return { name, status: "pass", message: "Installed", detail: firstLine };
	} catch {
		// ignore
	}

	// Second try on Windows: use 'where' to find it system-wide
	if (IS_WINDOWS) {
		try {
			const wherePath = execWithPath(`where ${name}`);
			if (wherePath) {
				// Found it — try running from full path
				const fullPath = wherePath.split("\n")[0]?.trim() || "";
				try {
					const output = execSync(`"${fullPath}" ${versionFlag}`, {
						timeout: 10000,
						encoding: "utf-8",
						stdio: ["ignore", "pipe", "pipe"],
						shell: "cmd.exe",
					}).trim();
					const firstLine = output.split("\n")[0] ?? "";
					return {
						name,
						status: "pass",
						message: "Installed",
						detail: `${firstLine} (${fullPath})`,
					};
				} catch {
					return {
						name,
						status: "warn",
						message: `Found at ${fullPath} but failed to get version`,
					};
				}
			}
		} catch {
			// where command failed — not found
		}
	}

	return {
		name,
		status: "fail",
		message: IS_WINDOWS
			? "Not found — install it and make sure it's in your PATH"
			: "Not found — install it first",
		detail: IS_WINDOWS
			? "Try: winget install yt-dlp / winget install ffmpeg"
			: "",
	};
}

function checkRapidApi(): PrereqResult {
	try {
		const envPath = join(process.cwd(), "..", "functions", ".env");
		const envContent = readFileSync(envPath, "utf-8");
		const match = envContent.match(/RAPIDAPI_API_KEYS=(.+)/);
		const keys = (match?.[1] || "")
			.split(",")
			.map((k: string) => k.trim())
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
	} catch {
		// fall through
	}

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

function checkApiServer(): PrereqResult {
	try {
		const fetchCmd = IS_WINDOWS
			? `powershell -NoProfile -Command "(Invoke-WebRequest -Uri '${API_BASE}/healthz' -TimeoutSec 5 -UseBasicParsing).Content"`
			: `curl -sf --max-time 5 ${API_BASE}/healthz`;
		const output = execWithPath(fetchCmd, 10000);
		const parsed = JSON.parse(output);
		if (parsed.ok) {
			return {
				name: "API Server",
				status: "pass",
				message: `Running at ${API_BASE}`,
			};
		}
		return { name: "API Server", status: "fail", message: "API returned unexpected response" };
	} catch {
		return {
			name: "API Server",
			status: "fail",
			message: `Not reachable at ${API_BASE}`,
			detail: "Start the API server first: node functions/standalone-server.js",
		};
	}
}

function checkConnectivity(): PrereqResult {
	try {
		const output = execWithPath(
			'yt-dlp --dump-json --flat-playlist --skip-download "ytsearch1:test audio"',
			30000,
		);
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

export function runAllChecks(): PrereqResult[] {
	return [
		checkBinary("yt-dlp", "--version"),
		checkBinary("ffmpeg", "-version"),
		checkRapidApi(),
		checkApiServer(),
		checkConnectivity(),
	];
}
