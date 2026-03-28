import { z } from "zod";
import { hashPassword, loadConfig, saveConfig, verifyPassword } from "./config";
import { runAllChecks } from "./prerequisites";
import { createSession, destroySession, validateSession } from "./session";
import { protectedProcedure, publicProcedure, router } from "./trpc";

const API_BASE = process.env.API_URL || "http://localhost:8080";

export const appRouter = router({
	// ============================================================
	// PUBLIC: branding + setup status
	// ============================================================

	branding: publicProcedure.query(() => {
		const config = loadConfig();
		return {
			setupComplete: config.setupComplete,
			branding: config.branding,
		};
	}),

	// ============================================================
	// SETUP: prerequisites, create admin, branding
	// ============================================================

	setup: router({
		status: publicProcedure.query(() => {
			const config = loadConfig();
			return { setupComplete: config.setupComplete };
		}),

		checkPrerequisites: publicProcedure.mutation(() => {
			return runAllChecks();
		}),

		createAdmin: publicProcedure
			.input(
				z.object({
					username: z.string().min(3).max(32),
					password: z.string().min(6).max(128),
				}),
			)
			.mutation(({ input }) => {
				const config = loadConfig();
				if (config.setupComplete) {
					throw new Error("Setup already completed");
				}
				const { hash, salt } = hashPassword(input.password);
				config.admin = {
					username: input.username,
					passwordHash: hash,
					salt,
					createdAt: new Date().toISOString(),
				};
				saveConfig(config);
				return { ok: true };
			}),

		saveBranding: publicProcedure
			.input(
				z.object({
					serverName: z.string().min(1).max(64),
					accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
					logoUrl: z.string().max(512).optional().default(""),
					motd: z.string().max(512).optional().default(""),
				}),
			)
			.mutation(({ input }) => {
				const config = loadConfig();
				if (config.setupComplete) {
					throw new Error("Setup already completed — use settings to change branding");
				}
				config.branding = {
					serverName: input.serverName,
					accentColor: input.accentColor,
					logoUrl: input.logoUrl || "",
					motd: input.motd || "",
				};
				saveConfig(config);
				return { ok: true };
			}),

		complete: publicProcedure.mutation(() => {
			const config = loadConfig();
			if (!config.admin) {
				throw new Error("Create an admin account first");
			}
			config.setupComplete = true;
			saveConfig(config);
			return { ok: true };
		}),
	}),

	// ============================================================
	// AUTH: login / logout
	// ============================================================

	auth: router({
		login: publicProcedure
			.input(z.object({ username: z.string(), password: z.string() }))
			.mutation(({ input }) => {
				const config = loadConfig();
				if (!config.admin) {
					throw new Error("No admin account configured");
				}
				if (
					input.username !== config.admin.username ||
					!verifyPassword(input.password, config.admin.passwordHash, config.admin.salt)
				) {
					throw new Error("Invalid credentials");
				}
				const token = createSession(input.username);
				return { token };
			}),

		logout: protectedProcedure.mutation(({ ctx }) => {
			if (ctx.sessionToken) destroySession(ctx.sessionToken);
			return { ok: true };
		}),

		check: publicProcedure.query(({ ctx }) => {
			return { authenticated: validateSession(ctx.sessionToken) };
		}),
	}),

	// ============================================================
	// DASHBOARD: stats (proxied from API server)
	// ============================================================

	stats: protectedProcedure.query(async () => {
		try {
			const res = await fetch(`${API_BASE}/dashboard/api/stats`);
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	}),

	// ============================================================
	// SETTINGS: update branding (protected)
	// ============================================================

	settings: router({
		getBranding: protectedProcedure.query(() => {
			const config = loadConfig();
			return config.branding;
		}),

		updateBranding: protectedProcedure
			.input(
				z.object({
					serverName: z.string().min(1).max(64).optional(),
					accentColor: z
						.string()
						.regex(/^#[0-9a-fA-F]{6}$/)
						.optional(),
					logoUrl: z.string().max(512).optional(),
					motd: z.string().max(512).optional(),
				}),
			)
			.mutation(({ input }) => {
				const config = loadConfig();
				config.branding = {
					...config.branding,
					...(input.serverName !== undefined && { serverName: input.serverName }),
					...(input.accentColor !== undefined && { accentColor: input.accentColor }),
					...(input.logoUrl !== undefined && { logoUrl: input.logoUrl }),
					...(input.motd !== undefined && { motd: input.motd }),
				};
				saveConfig(config);
				return config.branding;
			}),

		changePassword: protectedProcedure
			.input(
				z.object({
					currentPassword: z.string(),
					newPassword: z.string().min(6).max(128),
				}),
			)
			.mutation(({ input }) => {
				const config = loadConfig();
				if (!config.admin) throw new Error("No admin account");
				if (!verifyPassword(input.currentPassword, config.admin.passwordHash, config.admin.salt)) {
					throw new Error("Current password is incorrect");
				}
				const { hash, salt } = hashPassword(input.newPassword);
				config.admin.passwordHash = hash;
				config.admin.salt = salt;
				saveConfig(config);
				return { ok: true };
			}),
	}),
});

export type AppRouter = typeof appRouter;
