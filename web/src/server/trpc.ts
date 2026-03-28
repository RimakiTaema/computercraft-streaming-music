import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import { validateSession } from "./session";

export interface TRPCContext {
	sessionToken: string | null;
}

const t = initTRPC.context<TRPCContext>().create({
	transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!validateSession(ctx.sessionToken)) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
	}
	return next({ ctx });
});
