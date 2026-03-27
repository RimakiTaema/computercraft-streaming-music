import { onRequest } from "firebase-functions/v2/https";
import fetch from "node-fetch";
import prism from "prism-media";
import { pipeline } from "node:stream/promises";

const DEFAULT_RAPIDAPI_KEYS = ["YOUR API KEY HERE"];
const RAPIDAPI_KEYS = (process.env.RAPIDAPI_API_KEYS || "")
.split(",")
.map((key) => key.trim())
.filter(Boolean);

const rapidapi_api_keys =
RAPIDAPI_KEYS.length > 0 ? RAPIDAPI_KEYS : DEFAULT_RAPIDAPI_KEYS;

const YT_API_BASE = "https://yt-api.p.rapidapi.com";
const REQUEST_TIMEOUT_MS = 20000;

const API_VERSION = "2.2.1_vibe";
const API_BUILD = "vibecoded";

const GITHUB_OWNER = process.env.GITHUB_OWNER || "AngryManTV";
const GITHUB_REPO =
process.env.GITHUB_REPO || "computercraft-streaming-music";
const GITHUB_CHANGELOG_DIR =
process.env.GITHUB_CHANGELOG_DIR || "changelog";

export const ipod = onRequest(
{ memory: "512MiB", maxInstances: 3, cors: true },
async (req, res) => {
try {
res.setHeader("X-IPod-Version", API_VERSION);
res.setHeader("X-IPod-Build", API_BUILD);

```
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  const search =
    typeof req.query.search === "string"
      ? req.query.search.trim()
      : "";
  const changelogs = String(req.query.changelogs || "") === "1";
  const requestMajor = getVersionMajor(req.query.v);

  if (requestMajor > 0 && requestMajor < 2) {
    return res.status(426).send("Please upgrade client");
  }

  if (id) return await handleAudioDownload(id, res);
  if (changelogs) return await handleChangelogRequest(res);
  if (search) return await handleSearch(search, req, res, requestMajor);

  return res.status(400).send("Bad request");
} catch (error) {
  console.error(error);
  return res.status(500).send("Error 500");
}
```

}
);

async function handleAudioDownload(id, res) {
const json = await makeAPIRequestWithRetries(
`${YT_API_BASE}/dl?id=${encodeURIComponent(id)}&cgeo=US`
);

const url = pickPlayableFormatUrl(json?.formats);
if (!url) return res.status(502).send("Error 500");

const response = await fetchWithTimeout(url, { method: "GET" });
if (!response.ok || !response.body)
return res.status(502).send("Error 500");

const transcoder = new prism.FFmpeg({
args: [
"-analyzeduration",
"0",
"-loglevel",
"0",
"-f",
"dfpwm",
"-ar",
"48000",
"-ac",
"1",
],
});

res.setHeader("Content-Type", "application/octet-stream");
res.setHeader("Cache-Control", "no-store");

await pipeline(response.body, transcoder, res);
}

async function handleSearch(search, req, res, requestMajor) {
const youtube_id_match = search.match(
/((?:https?:)?//)?((?:www|m|music).)?((?:youtube.com|youtu.be))(/(?:[\w-]+?v=|embed/|v/)?)([\w-]+)(\S+)?$/
)?.[5];

if (youtube_id_match?.length === 11) {
const item = await makeAPIRequestWithRetries(
`${YT_API_BASE}/video/info?id=${youtube_id_match}`
);

```
return respondWithLatin1Json(res, [
  {
    id: item.id,
    name: replaceNonExtendedASCII(item.title),
    artist: `${toHMS(Number(item.lengthSeconds || 0))} · ${replaceNonExtendedASCII(
      (item.channelTitle || "Unknown Artist").split(" - Topic")[0]
    )}`,
  },
]);
```

}

const youtube_playlist_match = search.match(/list=([\w-]+)/)?.[1];

if (youtube_playlist_match?.length === 34 && requestMajor >= 2) {
const item = await makeAPIRequestWithRetries(
`${YT_API_BASE}/playlist?id=${youtube_playlist_match}`
);

```
return respondWithLatin1Json(res, [
  {
    id: item.meta.playlistId,
    name: replaceNonExtendedASCII(item.meta.title),
    artist: `Playlist · ${item.meta.videoCount} videos · ${replaceNonExtendedASCII(
      item.meta.channelTitle
    )}`,
    type: "playlist",
    playlist_items: item.data.map((p) => ({
      id: p.videoId,
      name: replaceNonExtendedASCII(p.title),
      artist: `${p.lengthText || "0:00"} · ${replaceNonExtendedASCII(
        (p.channelTitle || "Unknown Artist").split(" - Topic")[0]
      )}`,
    })),
  },
]);
```

}

const json = await makeAPIRequestWithRetries(
`${YT_API_BASE}/search?query=${encodeURIComponent(
      search.split("+").join(" ")
    )}&type=video`
);

return respondWithLatin1Json(
res,
(json?.data || [])
.filter((i) => i?.type === "video")
.map((i) => ({
id: i.videoId,
name: replaceNonExtendedASCII(i.title),
artist: `${i.lengthText || "0:00"} · ${replaceNonExtendedASCII(
          (i.channelTitle || "Unknown Artist").split(" - Topic")[0]
        )}`,
}))
);
}

async function handleChangelogRequest(res) {
const payload = await fetchChangelogsFromGitHub();
return respondWithLatin1Json(res, payload);
}

async function makeAPIRequestWithRetries(url) {
const max_attempts = 3;
const which_key = Math.floor(Math.random() * rapidapi_api_keys.length);
let latestError;

for (let attempt = 1; attempt <= max_attempts; attempt++) {
const apiKey =
rapidapi_api_keys[
(which_key + attempt - 1) % rapidapi_api_keys.length
];

```
try {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "yt-api.p.rapidapi.com",
    },
  });

  if (!response.ok)
    throw new Error(`RapidAPI request failed (${response.status})`);

  return await response.json();
} catch (error) {
  latestError = error;
  if (attempt < max_attempts) await sleep(1000 * attempt);
}
```

}

throw latestError || new Error("Unknown request error");
}

function fetchWithTimeout(url, options) {
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

return fetch(url, { ...options, signal: controller.signal }).finally(() =>
clearTimeout(timeout)
);
}

function respondWithLatin1Json(res, payload) {
res.setHeader("Content-Type", "application/json; charset=latin1");
return res
.status(200)
.send(Buffer.from(JSON.stringify(payload), "latin1"));
}

function pickPlayableFormatUrl(formats) {
if (!Array.isArray(formats)) return null;

const sorted = [...formats]
.filter((f) => typeof f?.url === "string")
.sort(
(a, b) =>
Number(b?.audioBitrate || b?.audioQuality || 0) -
Number(a?.audioBitrate || a?.audioQuality || 0)
);

return sorted[0]?.url || null;
}

function replaceNonExtendedASCII(str) {
return String(str || "").replace(/[^\x00-\xFF]/g, "?");
}

function toHMS(totalSeconds) {
const mins = Math.floor(totalSeconds / 60);
const secs = totalSeconds % 60;
return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function sleep(ms) {
return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChangelogsFromGitHub() {
const listUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_CHANGELOG_DIR}`;
const res = await fetch(listUrl);
return (await res.json()).slice(0, 10);
}

function getVersionMajor(v) {
return Number(String(v || "0").split(".")[0]) || 0;
}
