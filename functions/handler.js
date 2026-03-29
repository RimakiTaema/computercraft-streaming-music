import fetch from "node-fetch";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { accessSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_PATH = join(__dirname, "cookies.txt");

// ============================================================
// METRICS / DASHBOARD STATE
// ============================================================

const MAX_LOG_ENTRIES = 500;
const MAX_BANDWIDTH_BUCKETS = 1440; // 24h of 1-min buckets

const metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  totalBytesOut: 0,
  activeStreams: [],       // { id, source, startedAt, bytesOut, clientIp }
  requestLog: [],          // { ts, method, path, status, ms, ip, type, bytes }
  bandwidthByMinute: [],   // { ts, bytes, requests }
  byEndpoint: {
    search: { count: 0, bytes: 0, errors: 0 },
    download: { count: 0, bytes: 0, errors: 0 },
    changelog: { count: 0, bytes: 0, errors: 0 },
    dashboard: { count: 0, bytes: 0, errors: 0 },
    other: { count: 0, bytes: 0, errors: 0 },
  },
};

function classifyEndpoint(query) {
  if (query.id || query.url) return "download";
  if (query.search) return "search";
  if (String(query.changelogs) === "1") return "changelog";
  return "other";
}

function getBandwidthBucket() {
  const now = Math.floor(Date.now() / 60000); // minute bucket
  const buckets = metrics.bandwidthByMinute;
  if (buckets.length === 0 || buckets[buckets.length - 1].ts !== now) {
    if (buckets.length >= MAX_BANDWIDTH_BUCKETS) buckets.shift();
    buckets.push({ ts: now, bytes: 0, requests: 0 });
  }
  return buckets[buckets.length - 1];
}

function addLogEntry(entry) {
  if (metrics.requestLog.length >= MAX_LOG_ENTRIES) metrics.requestLog.shift();
  metrics.requestLog.push(entry);
}

function registerStream(id, source, ip) {
  const stream = { id, source: source.slice(0, 100), startedAt: Date.now(), bytesOut: 0, clientIp: ip || "unknown" };
  metrics.activeStreams.push(stream);
  return stream;
}

function removeStream(id) {
  metrics.activeStreams = metrics.activeStreams.filter((s) => s.id !== id);
}

export function getMetrics() {
  return {
    ...metrics,
    uptime: Date.now() - metrics.startedAt,
  };
}
let hasCookies = false;
try { accessSync(COOKIES_PATH); hasCookies = true; } catch { /* no cookies */ }
console.log(`[init] cookies.txt: ${hasCookies ? "found" : "not found"}`);

const DEFAULT_RAPIDAPI_KEYS = ["YOUR API KEY HERE"];
const RAPIDAPI_KEYS = (process.env.RAPIDAPI_API_KEYS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const rapidapi_api_keys = RAPIDAPI_KEYS.length > 0 ? RAPIDAPI_KEYS : DEFAULT_RAPIDAPI_KEYS;
console.log(`[init] ${rapidapi_api_keys.length} API key(s) loaded, first key starts with: ${rapidapi_api_keys[0]?.slice(0, 8)}...`);
const YT_API_BASE = "https://yt-api.p.rapidapi.com";
const REQUEST_TIMEOUT_MS = 20000;
const API_VERSION = "4.0.0_vibe";
const API_BUILD = "vibecoded";
const HAS_RAPIDAPI = RAPIDAPI_KEYS.length > 0 && RAPIDAPI_KEYS[0] !== "YOUR API KEY HERE";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "AngryManTV";
const GITHUB_REPO = process.env.GITHUB_REPO || "computercraft-streaming-music";
const GITHUB_CHANGELOG_DIR = process.env.GITHUB_CHANGELOG_DIR || "changelog";

export async function ipodHandler(req, res) {
  const reqStart = Date.now();
  const endpoint = classifyEndpoint(req.query || {});
  metrics.totalRequests++;
  metrics.byEndpoint[endpoint].count++;
  const bucket = getBandwidthBucket();
  bucket.requests++;

  // Track response bytes
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  let bytesOut = 0;

  res.write = function (chunk, ...args) {
    if (chunk) bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    return origWrite(chunk, ...args);
  };
  res.end = function (chunk, ...args) {
    if (chunk) bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    return origEnd(chunk, ...args);
  };

  res.on("finish", () => {
    const ms = Date.now() - reqStart;
    metrics.totalBytesOut += bytesOut;
    metrics.byEndpoint[endpoint].bytes += bytesOut;
    const b = getBandwidthBucket();
    b.bytes += bytesOut;
    if (res.statusCode >= 400) metrics.byEndpoint[endpoint].errors++;
    addLogEntry({
      ts: Date.now(),
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      ms,
      ip: req.ip || req.socket?.remoteAddress || "?",
      type: endpoint,
      bytes: bytesOut,
    });
  });

  try {
    res.setHeader("X-IPod-Version", API_VERSION);
    res.setHeader("X-IPod-Build", API_BUILD);

    if (req.method !== "GET") {
      return res.status(405).send("Method not allowed");
    }

    const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const changelogs = String(req.query.changelogs || "") === "1";
    const requestMajor = getVersionMajor(req.query.v);

    if (requestMajor > 0 && requestMajor < 2) {
      return res.status(426).send("Please upgrade client");
    }

    const dlUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";

    if (id || dlUrl) {
      let source;
      if (dlUrl) {
        source = sanitizeUrl(dlUrl);
        if (!source) {
          console.warn(`[handler] blocked unsafe download url: ${dlUrl.slice(0, 80)}`);
          return res.status(400).send("Invalid or blocked URL");
        }
      } else {
        // id is always a YouTube video ID — safe to construct
        if (!/^[\w-]{11}$/.test(id)) {
          return res.status(400).send("Invalid video ID");
        }
        source = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
      }
      console.log(`[handler] audio download source=${source.slice(0, 80)}`);
      return await handleAudioDownload(source, res, req.ip || req.socket?.remoteAddress);
    }

    if (changelogs) {
      console.log("[handler] changelog request");
      return await handleChangelogRequest(res);
    }

    if (search) {
      console.log(`[handler] search query="${search}"`);
      return await handleSearch(search, res, requestMajor);
    }

    console.log("[handler] bad request - no id/search/changelogs param");
    return res.status(400).send("Bad request");
  } catch (error) {
    console.error("[handler] unhandled error:", error);
    return res.status(500).send("Error 500");
  }
}

const IS_WIN = process.platform === "win32";

// Build expanded PATH so spawn() can find binaries wherever they're installed
const EXTRA_PATHS = IS_WIN
  ? [
      join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links"),
      join(process.env.PROGRAMDATA || "C:\\ProgramData", "chocolatey", "bin"),
      process.env.USERPROFILE ? join(process.env.USERPROFILE, "scoop", "shims") : "",
      join(process.env.LOCALAPPDATA || "", "Programs", "yt-dlp"),
      join(process.env.LOCALAPPDATA || "", "Programs", "ffmpeg", "bin"),
      join(process.env.PROGRAMFILES || "", "yt-dlp"),
      join(process.env.PROGRAMFILES || "", "ffmpeg", "bin"),
      join(process.env.PROGRAMFILES || "", "ffmpeg"),
      "C:\\ffmpeg\\bin", "C:\\ffmpeg", "C:\\yt-dlp", "C:\\Tools",
      process.env.APPDATA ? join(process.env.APPDATA, "Python", "Scripts") : "",
    ]
  : [
      "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin",
      process.env.HOME ? join(process.env.HOME, ".local", "bin") : "",
    ];

const SPAWN_PATH = `${process.env.PATH || ""}${delimiter}${EXTRA_PATHS.filter(Boolean).join(delimiter)}`;
const SPAWN_ENV = { ...process.env, PATH: SPAWN_PATH };

// Resolve binary: try finding full path, fall back to name
function findBin(name) {
  const exeName = IS_WIN ? `${name}.exe` : name;
  // Check expanded PATH directories
  for (const dir of EXTRA_PATHS.filter(Boolean)) {
    const full = join(dir, exeName);
    try { if (existsSync(full)) { console.log(`[init] ${name}: found at ${full}`); return full; } } catch {}
  }
  // Try 'where' (Windows) or 'which' (Unix)
  try {
    const cmd = IS_WIN ? `where ${exeName}` : `which ${name}`;
    const result = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: SPAWN_ENV }).trim().split("\n")[0];
    if (result) { console.log(`[init] ${name}: resolved to ${result}`); return result; }
  } catch {}
  console.log(`[init] ${name}: using name directly (hope it's in PATH)`);
  return exeName;
}

const YTDLP_BIN = findBin("yt-dlp");
const FFMPEG_BIN = findBin("ffmpeg");

function spawnBin(bin, args, opts = {}) {
  return spawn(bin, args, { ...opts, env: { ...SPAWN_ENV, ...opts.env }, ...(IS_WIN ? { shell: true } : {}) });
}

async function handleAudioDownload(sourceUrl, res, clientIp) {
  console.log(`[dl] starting yt-dlp + ffmpeg pipeline for ${sourceUrl.slice(0, 80)}`);
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const streamMeta = registerStream(streamId, sourceUrl, clientIp);

  // Disable socket timeout for long audio streams (default is 2min which kills 2hr+ songs)
  if (res.socket) res.socket.setTimeout(0);
  if (res.req?.socket) res.req.socket.setTimeout(0);

  return new Promise((resolve, reject) => {
    // yt-dlp: extract best audio, output raw audio to stdout
    const ytdlpArgs = ["-f", "bestaudio", "--no-playlist", "--no-exec", "--no-batch", "-o", "-"];
    if (hasCookies) {
      ytdlpArgs.push("--cookies", COOKIES_PATH);
      console.log("[dl] using cookies.txt");
    }
    ytdlpArgs.push(sourceUrl);

    const ytdlp = spawnBin(YTDLP_BIN, ytdlpArgs, { stdio: ["ignore", "pipe", "pipe"] });

    // ffmpeg: convert to DFPWM for ComputerCraft
    const ffmpeg = spawnBin(FFMPEG_BIN, [
      "-i", "pipe:0",
      "-analyzeduration", "0",
      "-loglevel", "warning",
      "-f", "dfpwm",
      "-ar", "48000",
      "-ac", "1",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let ytdlpStderr = "";
    let ffmpegStderr = "";

    ytdlp.stderr.on("data", (chunk) => { ytdlpStderr += chunk.toString(); });
    ffmpeg.stderr.on("data", (chunk) => { ffmpegStderr += chunk.toString(); });

    // Pipe: yt-dlp stdout -> ffmpeg stdin -> response
    ytdlp.stdout.pipe(ffmpeg.stdin);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");

    ffmpeg.stdout.on("data", (chunk) => {
      streamMeta.bytesOut += chunk.length;
    });
    ffmpeg.stdout.pipe(res);

    res.on("close", () => {
      removeStream(streamId);
    });

    ytdlp.on("error", (err) => {
      console.error("[dl] yt-dlp spawn error:", err.message);
      if (!res.headersSent) res.status(502).send("Error 502");
      resolve();
    });

    ffmpeg.on("error", (err) => {
      console.error("[dl] ffmpeg spawn error:", err.message);
      if (!res.headersSent) res.status(502).send("Error 502");
      resolve();
    });

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        console.error(`[dl] yt-dlp exited with code ${code}: ${ytdlpStderr.slice(0, 500)}`);
        ffmpeg.stdin.end();
      } else {
        console.log("[dl] yt-dlp finished ok");
      }
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        console.error(`[dl] ffmpeg exited with code ${code}: ${ffmpegStderr.slice(0, 500)}`);
        if (!res.headersSent) res.status(502).send("Error 502");
      } else {
        console.log("[dl] ffmpeg transcode finished ok");
      }
      resolve();
    });
  });
}

// ============================================================
// URL SANITIZATION — prevent SSRF / local file access
// ============================================================

const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d+\.\d+$/,       // link-local / cloud metadata
  /^\[::1\]$/,                    // IPv6 loopback
  /^\[fd[0-9a-f]{2}:/i,          // IPv6 private
  /^\[fe80:/i,                    // IPv6 link-local
  /metadata\.google\.internal/i,
  /metadata\.internal/i,
];

const ALLOWED_SCHEMES = ["http:", "https:"];

function sanitizeUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();

  // Block non-http schemes (file://, ftp://, data://, etc.)
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null; // not a valid URL — treat as search query, fine
  }

  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    console.warn(`[security] blocked scheme: ${parsed.protocol} in ${trimmed.slice(0, 80)}`);
    return null;
  }

  // Block private/internal hosts
  const host = parsed.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOSTS) {
    if (pattern.test(host)) {
      console.warn(`[security] blocked private host: ${host}`);
      return null;
    }
  }

  return trimmed;
}

function detectPlatform(search) {
  if (/soundcloud\.com\//i.test(search)) return "soundcloud";
  if (/open\.spotify\.com\/|spotify\.com\//i.test(search)) return "spotify";
  if (/(youtube\.com|youtu\.be)\//i.test(search)) return "youtube";
  if (/^https?:\/\//i.test(search)) return "direct";
  return "text";
}

async function handleSearch(search, res, requestMajor) {
  const platform = detectPlatform(search);
  console.log(`[search] detected platform=${platform}`);

  // Sanitize any URL-based search input
  if (platform !== "text" && platform !== "youtube") {
    const safe = sanitizeUrl(search);
    if (!safe) {
      console.warn(`[search] blocked unsafe search url: ${search.slice(0, 80)}`);
      return respondWithLatin1Json(res, []);
    }
    search = safe;
  }

  // --- SoundCloud URL ---
  if (platform === "soundcloud") {
    try {
      const info = await ytdlpGetInfo(search);
      if (info) {
        console.log("[search] soundcloud info via yt-dlp ok");
        return respondWithLatin1Json(res, [{
          id: info.id,
          name: replaceNonExtendedASCII(info.title || "Unknown"),
          artist: `${toHMS(Number(info.duration || 0))} · ${replaceNonExtendedASCII(info.uploader || info.channel || "Unknown Artist")}`,
          platform: "soundcloud",
          download_url: info.webpage_url || search,
        }]);
      }
    } catch (err) {
      console.error(`[search] soundcloud lookup failed: ${err.message}`);
    }
    return respondWithLatin1Json(res, []);
  }

  // --- Spotify URL (metadata -> YouTube match) ---
  if (platform === "spotify") {
    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(search)}`;
      const oembedRes = await fetchWithTimeout(oembedUrl, { method: "GET" });
      if (oembedRes.ok) {
        const meta = await oembedRes.json();
        const trackTitle = replaceNonExtendedASCII(meta.title || "Unknown");
        const searchQuery = trackTitle;
        console.log(`[search] spotify oembed ok, searching youtube for: "${searchQuery}"`);
        const ytResults = await ytdlpSearch(searchQuery, 3);
        if (ytResults.length > 0) {
          const results = ytResults.map((r) => ({
            ...r,
            platform: "spotify",
          }));
          return respondWithLatin1Json(res, results);
        }
      }
    } catch (err) {
      console.error(`[search] spotify lookup failed: ${err.message}`);
    }
    return respondWithLatin1Json(res, []);
  }

  // --- Direct URL (any yt-dlp supported site) ---
  if (platform === "direct") {
    try {
      const info = await ytdlpGetInfo(search);
      if (info) {
        console.log("[search] direct url info via yt-dlp ok");
        return respondWithLatin1Json(res, [{
          id: info.id,
          name: replaceNonExtendedASCII(info.title || "Unknown"),
          artist: `${toHMS(Number(info.duration || 0))} · ${replaceNonExtendedASCII(info.uploader || info.channel || "Unknown")}`,
          platform: "direct",
          download_url: info.webpage_url || search,
        }]);
      }
    } catch (err) {
      console.error(`[search] direct url lookup failed: ${err.message}`);
    }
    return respondWithLatin1Json(res, []);
  }

  // --- YouTube URL: video ---
  const youtube_id_parts = search.match(/((?:https?:)?\/\/)?((?:www|m|music)\.)?((?:youtube\.com|youtu.be))(\/(?:[\w\-]+\?v=|embed\/|v\/)?)([\w\-]+)(\S+)?$/);
  const youtube_id_match = youtube_id_parts && youtube_id_parts[5];
  if (youtube_id_match && youtube_id_match.length === 11) {
    try {
      if (HAS_RAPIDAPI) {
        const item = await makeAPIRequestWithRetries(`${YT_API_BASE}/video/info?id=${youtube_id_match}`);
        if (item && item.title) {
          console.log("[search] video info via RapidAPI ok");
          return respondWithLatin1Json(res, [{
            id: item.id,
            name: replaceNonExtendedASCII(item.title),
            artist: `${toHMS(Number(item.lengthSeconds || 0))} · ${replaceNonExtendedASCII((item.channelTitle || "Unknown Artist").split(" - Topic")[0])}`,
            platform: "youtube",
          }]);
        }
      }
    } catch (err) {
      console.warn(`[search] RapidAPI video info failed, falling back to yt-dlp: ${err.message}`);
    }

    try {
      const info = await ytdlpGetInfo(`https://www.youtube.com/watch?v=${youtube_id_match}`);
      if (info) {
        console.log("[search] video info via yt-dlp fallback ok");
        return respondWithLatin1Json(res, [{
          id: info.id,
          name: replaceNonExtendedASCII(info.title || "Unknown"),
          artist: `${toHMS(Number(info.duration || 0))} · ${replaceNonExtendedASCII((info.channel || info.uploader || "Unknown Artist").split(" - Topic")[0])}`,
          platform: "youtube",
        }]);
      }
    } catch (err2) {
      console.error(`[search] yt-dlp video info fallback also failed: ${err2.message}`);
    }

    return respondWithLatin1Json(res, []);
  }

  // --- YouTube URL: playlist ---
  const youtube_playlist_parts = search.match(/((?:https?:)?\/\/)?((?:www|m|music)\.)?((?:youtube\.com|youtu.be))\/playlist(\S+)list=([\w\-]+)(\S+)?$/);
  const youtube_playlist_match = youtube_playlist_parts && youtube_playlist_parts[5];
  if (youtube_playlist_match && youtube_playlist_match.length === 34 && requestMajor >= 2) {
    try {
      if (HAS_RAPIDAPI) {
        const item = await makeAPIRequestWithRetries(`${YT_API_BASE}/playlist?id=${youtube_playlist_match}`);
        if (item && !item.error && item.data && item.data.length > 0) {
          console.log("[search] playlist via RapidAPI ok");
          return respondWithLatin1Json(res, [{
            id: item.meta.playlistId,
            name: replaceNonExtendedASCII(item.meta.title),
            artist: `Playlist · ${item.meta.videoCount} videos · ${replaceNonExtendedASCII(item.meta.channelTitle)}`,
            type: "playlist",
            platform: "youtube",
            playlist_items: item.data.map((pi) => ({
              id: pi.videoId,
              name: replaceNonExtendedASCII(pi.title),
              artist: `${pi.lengthText || "0:00"} · ${replaceNonExtendedASCII((pi.channelTitle || "Unknown Artist").split(" - Topic")[0])}`,
            })),
          }]);
        }
      }
    } catch (err) {
      console.warn(`[search] RapidAPI playlist failed, falling back to yt-dlp: ${err.message}`);
    }

    try {
      const items = await ytdlpGetPlaylist(`https://www.youtube.com/playlist?list=${youtube_playlist_match}`);
      if (items && items.length > 0) {
        console.log(`[search] playlist via yt-dlp fallback ok (${items.length} items)`);
        return respondWithLatin1Json(res, [{
          id: youtube_playlist_match,
          name: replaceNonExtendedASCII(items[0]._playlist_title || "Playlist"),
          artist: `Playlist · ${items.length} videos`,
          type: "playlist",
          platform: "youtube",
          playlist_items: items.map((pi) => ({
            id: pi.id,
            name: replaceNonExtendedASCII(pi.title || "Unknown"),
            artist: `${toHMS(Number(pi.duration || 0))} · ${replaceNonExtendedASCII((pi.channel || pi.uploader || "Unknown Artist").split(" - Topic")[0])}`,
          })),
        }]);
      }
    } catch (err2) {
      console.error(`[search] yt-dlp playlist fallback also failed: ${err2.message}`);
    }

    return respondWithLatin1Json(res, []);
  }

  // --- Text search (defaults to YouTube) ---
  try {
    if (HAS_RAPIDAPI) {
      const json = await makeAPIRequestWithRetries(
        `${YT_API_BASE}/search?query=${encodeURIComponent(search.split("+").join(" "))}&type=video`
      );
      const results = ((json && json.data) || [])
        .filter((item) => item && item.type === "video")
        .map((item) => ({
          id: item.videoId,
          name: replaceNonExtendedASCII(item.title),
          artist: `${item.lengthText || "0:00"} · ${replaceNonExtendedASCII((item.channelTitle || "Unknown Artist").split(" - Topic")[0])}`,
          platform: "youtube",
        }));
      if (results.length > 0) {
        console.log(`[search] text search via RapidAPI ok (${results.length} results)`);
        return respondWithLatin1Json(res, results);
      }
    }
  } catch (err) {
    console.warn(`[search] RapidAPI text search failed, falling back to yt-dlp: ${err.message}`);
  }

  try {
    const results = await ytdlpSearch(search);
    const tagged = results.map((r) => ({ ...r, platform: "youtube" }));
    console.log(`[search] text search via yt-dlp fallback ok (${tagged.length} results)`);
    return respondWithLatin1Json(res, tagged);
  } catch (err2) {
    console.error(`[search] yt-dlp search fallback also failed: ${err2.message}`);
  }

  return respondWithLatin1Json(res, []);
}

async function handleChangelogRequest(res) {
  const payload = await fetchChangelogsFromGitHub();
  return respondWithLatin1Json(res, payload);
}

async function makeAPIRequestWithRetries(url) {
  if (!HAS_RAPIDAPI) {
    throw new Error("RapidAPI key is not configured — will use yt-dlp fallback");
  }

  const max_attempts = 3;
  const which_key = Math.floor(Math.random() * rapidapi_api_keys.length);
  let latestError;

  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    const apiKey = rapidapi_api_keys[(which_key + attempt - 1) % rapidapi_api_keys.length];

    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": "yt-api.p.rapidapi.com",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`RapidAPI request failed (${response.status}): ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      console.log(`[api] attempt ${attempt} success, url=${url.slice(0, 80)}`);
      return data;
    } catch (error) {
      latestError = error;
      console.error(`[api] attempt ${attempt}/${max_attempts} failed:`, error.message);
      if (attempt < max_attempts) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw latestError || new Error("Unknown request error");
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

function respondWithLatin1Json(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=latin1");
  return res.status(200).send(Buffer.from(JSON.stringify(payload), "latin1"));
}


function replaceNonExtendedASCII(str) {
  return String(str || "")
    .replace(/\u2014/g, "-")
    .replace(/\u2013/g, "-")
    .replace(/\u2018/g, "'")
    .replace(/\u2019/g, "'")
    .replace(/\u201C/g, '"')
    .replace(/\u201D/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u2022/g, "\u00B7")
    .replace(/[^\x00-\xFF]/g, "?");
}

function toHMS(totalSeconds) {
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const formattedMinutes = hrs > 0 && mins < 10 ? `0${mins}` : mins;
  const formattedSeconds = secs < 10 ? `0${secs}` : secs;

  return hrs > 0 ? `${hrs}:${formattedMinutes}:${formattedSeconds}` : `${formattedMinutes}:${formattedSeconds}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// yt-dlp fallback helpers

function ytdlpExec(args) {
  return new Promise((resolve, reject) => {
    const fullArgs = ["--no-exec", "--no-batch", ...args];
    if (hasCookies) fullArgs.push("--cookies", COOKIES_PATH);

    const proc = spawnBin(YTDLP_BIN, fullArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("yt-dlp timed out after 30s"));
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function ytdlpGetInfo(url) {
  const output = await ytdlpExec(["--dump-json", "--no-playlist", "--skip-download", url]);
  return JSON.parse(output);
}

async function ytdlpGetPlaylist(url) {
  const output = await ytdlpExec(["--dump-json", "--flat-playlist", "--skip-download", url]);
  // Each line is a separate JSON object
  const items = output.trim().split("\n").filter(Boolean).map((line) => {
    const parsed = JSON.parse(line);
    return {
      id: parsed.id,
      title: parsed.title,
      duration: parsed.duration,
      channel: parsed.channel || parsed.uploader,
      _playlist_title: parsed.playlist_title,
    };
  });
  return items;
}

async function ytdlpSearch(query, count = 10) {
  const output = await ytdlpExec([
    `ytsearch${count}:${query}`,
    "--dump-json",
    "--flat-playlist",
    "--skip-download",
  ]);
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const item = JSON.parse(line);
    return {
      id: item.id,
      name: replaceNonExtendedASCII(item.title || "Unknown"),
      artist: `${toHMS(Number(item.duration || 0))} · ${replaceNonExtendedASCII((item.channel || item.uploader || "Unknown Artist").split(" - Topic")[0])}`,
    };
  });
}

async function fetchChangelogsFromGitHub() {
  const listUrl = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodeURIComponent(GITHUB_CHANGELOG_DIR)}`;
  const listResponse = await fetchWithTimeout(listUrl, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "computercraft-streaming-music",
    },
  });

  if (!listResponse.ok) {
    throw new Error(`GitHub changelog list request failed (${listResponse.status})`);
  }

  const files = (await listResponse.json())
    .filter((item) => item && item.type === "file" && item.name && item.name.toLowerCase().endsWith(".md"))
    .sort((a, b) => String(b.name || "").localeCompare(String(a.name || "")))
    .slice(0, 20);

  const items = (
    await Promise.all(
      files.map(async (file) => {
        const fileResponse = await fetchWithTimeout(file.download_url, { method: "GET" });
        if (!fileResponse.ok) {
          return null;
        }

        const body = await fileResponse.text();
        const date = parseDateFromFilename(file.name);
        return {
          date,
          title: file.name.replace(/\.md$/i, "").replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]/g, " ").trim() || file.name,
          body: replaceNonExtendedASCII(body.slice(0, 3000)),
          source: file.html_url,
          file: file.name,
        };
      })
    )
  ).filter(Boolean);

  items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return items;
}

function parseDateFromFilename(filename) {
  const match = String(filename || "").match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function getVersionMajor(rawVersion) {
  if (typeof rawVersion === "number" && Number.isFinite(rawVersion)) {
    return Math.max(0, Math.floor(rawVersion));
  }

  if (typeof rawVersion !== "string") {
    return 0;
  }

  const match = rawVersion.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[_-].+)?$/);
  if (!match) {
    return 0;
  }

  return Number(match[1] || 0);
}
