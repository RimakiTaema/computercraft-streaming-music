// PM2-compatible Next.js start script (works on Windows + Linux)
// Avoids .cmd shim issues on Windows
process.argv.push("start");
require("next/dist/bin/next");
