import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "@/lib/trpc-provider";

export const metadata: Metadata = {
	title: "iPod Dashboard",
	description: "Music streaming server dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className="dark">
			<body className="bg-[#0a0a0f] text-gray-200 min-h-screen antialiased">
				<TRPCProvider>{children}</TRPCProvider>
			</body>
		</html>
	);
}
