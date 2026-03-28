import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(process.cwd(), "..", "functions", "config.json");

export interface AdminConfig {
	username: string;
	passwordHash: string;
	salt: string;
	createdAt: string;
}

export interface BrandingConfig {
	serverName: string;
	accentColor: string;
	logoUrl: string;
	motd: string;
}

export interface AppConfig {
	setupComplete: boolean;
	admin: AdminConfig | null;
	branding: BrandingConfig;
}

const DEFAULT_CONFIG: AppConfig = {
	setupComplete: false,
	admin: null,
	branding: {
		serverName: "iPod Dashboard",
		accentColor: "#00d4ff",
		logoUrl: "",
		motd: "",
	},
};

export function loadConfig(): AppConfig {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = readFileSync(CONFIG_PATH, "utf-8");
			const parsed = JSON.parse(raw);
			return { ...DEFAULT_CONFIG, ...parsed };
		}
	} catch {
		console.error("[config] failed to load config.json, using defaults");
	}
	return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: AppConfig): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
	console.log("[config] saved config.json");
}

export function hashPassword(password: string): { hash: string; salt: string } {
	const salt = crypto.randomBytes(16).toString("hex");
	const hash = crypto.scryptSync(password, salt, 64).toString("hex");
	return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
	const derived = crypto.scryptSync(password, salt, 64).toString("hex");
	return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(hash, "hex"));
}
