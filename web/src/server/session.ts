import crypto from "node:crypto";

interface Session {
	createdAt: number;
	username: string;
}

const sessions = new Map<string, Session>();
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;

export function createSession(username: string): string {
	const token = crypto.randomBytes(32).toString("hex");
	sessions.set(token, { createdAt: Date.now(), username });
	return token;
}

export function validateSession(token: string | undefined | null): boolean {
	if (!token) return false;
	const session = sessions.get(token);
	if (!session) return false;
	if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
		sessions.delete(token);
		return false;
	}
	return true;
}

export function destroySession(token: string): void {
	sessions.delete(token);
}

// Cleanup expired sessions every hour
setInterval(
	() => {
		const now = Date.now();
		for (const [token, session] of sessions) {
			if (now - session.createdAt > SESSION_MAX_AGE) sessions.delete(token);
		}
	},
	60 * 60 * 1000,
);
