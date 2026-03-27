import { onRequest } from "firebase-functions/v2/https";
import fetch from "node-fetch";
import prism from "prism-media";
import { pipeline } from "node:stream/promises";

const DEFAULT_RAPIDAPI_KEYS = ["YOUR API KEY HERE"];
const RAPIDAPI_KEYS = (process.env.RAPIDAPI_API_KEYS || "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const rapidapi_api_keys = RAPIDAPI_KEYS.length > 0 ? RAPIDAPI_KEYS : DEFAULT_RAPIDAPI_KEYS;
const YT_API_BASE = "https://yt-api.p.rapidapi.com";
const REQUEST_TIMEOUT_MS = 20000;
const API_VERSION = "2.2.1_vibe";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "AngryManTV";
const GITHUB_REPO = process.env.GITHUB_REPO || "computercraft-streaming-music";
const GITHUB_CHANGELOG_DIR = process.env.GITHUB_CHANGELOG_DIR || "changelog";

export const ipod = onRequest({ memory: "512MiB", maxInstances: 3, cors: true }, async (req, res) => {
  try {
    res.setHeader("X-IPod-Version", API_VERSION);
    res.setHeader("X-IPod-Build", "vibecoded");

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

    if (id) {
      return await handleAudioDownload(id, res);
    }

    if (changelogs) {
      return await handleChangelogRequest(res);
    }

    if (search) {
      return await handleSearch(search, res, requestMajor);
    }

    return res.status(400).send("Bad request");
  } catch (error) {
    console.error(error);
    return res.status(500).send("Error 500");
  }
});

async function handleAudioDownload(id, res) {
  const json = await makeAPIRequestWithRetries(`${YT_API_BASE}/dl?id=${encodeURIComponent(id)}&cgeo=US`);
  const url = pickPlayableFormatUrl(json?.formats);

  if (!url) {
    return res.status(502).send("Error 500");
  }

  const response = await fetchWithTimeout(url, { method: "GET" });
  if (!response.ok || !response.body) {
    return res.status(502).send("Error 500");
  }

  const transcoder = new prism.FFmpeg({
    args: ["-analyzeduration", "0", "-loglevel", "0", "-f", "dfpwm", "-ar", "48000", "-ac", "1"],
  });

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");

  await pipeline(response.body, transcoder, res);
}

async function handleSearch(search, res, requestMajor) {
  const youtube_id_match = search.match(/((?:https?:)?\/\/)?((?:www|m|music)\.)?((?:youtube\.com|youtu.be))(\/(?:[\w\-]+\?v=|embed\/|v\/)?)([\w\-]+)(\S+)?$/)?.[5];
  if (youtube_id_match?.length === 11) {
    const item = await makeAPIRequestWithRetries(`${YT_API_BASE}/video/info?id=${youtube_id_match}`);

    return respondWithLatin1Json(
      res,
      !item?.title
        ? []
        : [
            {
              id: item.id,
              name: replaceNonExtendedASCII(item.title),
              artist: `${toHMS(Number(item.lengthSeconds || 0))} · ${replaceNonExtendedASCII((item.channelTitle || "Unknown Artist").split(" - Topic")[0])}`,
            },
          ]
    );
  }

  const youtube_playlist_match = search.match(/((?:https?:)?\/\/)?((?:www|m|music)\.)?((?:youtube\.com|youtu.be))\/playlist(\S+)list=([\w\-]+)(\S+)?$/)?.[5];
  if (youtube_playlist_match?.length === 34 && requestMajor >= 2) {
    const item = await makeAPIRequestWithRetries(`${YT_API_BASE}/playlist?id=${youtube_playlist_match}`);

    return respondWithLatin1Json(
      res,
      item?.error || item?.data?.length === 0
        ? []
        : [
            {
              id: item.meta.playlistId,
              name: replaceNonExtendedASCII(item.meta.title),
              artist: `Playlist · ${item.meta.videoCount} videos · ${replaceNonExtendedASCII(item.meta.channelTitle)}`,
              type: "playlist",
              playlist_items: item.data.map((playlistItem) => ({
                id: playlistItem.videoId,
                name: replaceNonExtendedASCII(playlistItem.title),
                artist: `${playlistItem.lengthText || "0:00"} · ${replaceNonExtendedASCII((playlistItem.channelTitle || "Unknown Artist").split(" - Topic")[0])}`,
              })),
            },
          ]
    );
  }

  const json = await makeAPIRequestWithRetries(
    `${YT_API_BASE}/search?query=${encodeURIComponent(search.split("+").join(" "))}&type=video`
  );

  return respondWithLatin1Json(
    res,
    (json?.data || [])
      .filter((item) => item?.type === "video")
      .map((item) => ({
        id: item.videoId,
        name: replaceNonExtendedASCII(item.title),
        artist: `${item.lengthText || "0:00"} · ${replaceNonExtendedASCII((item.channelTitle || "Unknown Artist").split(" - Topic")[0])}`,
      }))
  );
}

async function handleChangelogRequest(res) {
  const payload = await fetchChangelogsFromGitHub();
  return respondWithLatin1Json(res, payload);
}

async function makeAPIRequestWithRetries(url) {
  if (rapidapi_api_keys.length === 0 || rapidapi_api_keys[0] === "YOUR API KEY HERE") {
    throw new Error("RapidAPI key is not configured");
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
        throw new Error(`RapidAPI request failed (${response.status})`);
      }

      return await response.json();
    } catch (error) {
      latestError = error;
      console.error(`Attempt ${attempt}/${max_attempts} failed`, error);
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

function pickPlayableFormatUrl(formats) {
  if (!Array.isArray(formats)) {
    return null;
  }

  const sorted = [...formats]
    .filter((format) => typeof format?.url === "string")
    .sort((a, b) => Number(b?.audioBitrate || 0) - Number(a?.audioBitrate || 0));

  return sorted[0]?.url || null;
}

function replaceNonExtendedASCII(str) {
  return String(str || "")
    .replace(/—/g, "-")
    .replace(/–/g, "-")
    .replace(/‘/g, "'")
    .replace(/’/g, "'")
    .replace(/“/g, '"')
    .replace(/”/g, '"')
    .replace(/…/g, "...")
    .replace(/•/g, "·")
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

  const files = (await listResponse.json()).filter((item) => item?.type === "file" && item?.name?.toLowerCase().endsWith(".md"));

  const items = [];
  for (const file of files) {
    const fileResponse = await fetchWithTimeout(file.download_url, { method: "GET" });
    if (!fileResponse.ok) {
      continue;
    }

    const body = await fileResponse.text();
    const date = parseDateFromFilename(file.name);
    items.push({
      date,
      title: file.name.replace(/\.md$/i, "").replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]/g, " ").trim() || file.name,
      body: replaceNonExtendedASCII(body.slice(0, 3000)),
      source: file.html_url,
      file: file.name,
    });
  }

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
