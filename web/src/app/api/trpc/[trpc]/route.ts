import { appRouter } from "@/server/router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { cookies } from "next/headers";

const handler = async (req: Request) => {
	const cookieStore = await cookies();
	const sessionToken = cookieStore.get("dash_session")?.value ?? null;

	return fetchRequestHandler({
		endpoint: "/api/trpc",
		req,
		router: appRouter,
		createContext: () => ({ sessionToken }),
	});
};

export { handler as GET, handler as POST };
