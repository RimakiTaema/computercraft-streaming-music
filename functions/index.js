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

export const ipod = onRequest({ memory: "512MiB", maxInstances: 3, cors: true }, async (req, res) => {
  try {
    if (req.method !== "GET") {
      return res.status(405).send("Method not allowed");
    }

    const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

    if (id) {
      return await handleAudioDownload(id, res);
    }

    if (search) {
      return await handleSearch(search, req, res);
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

async function handleSearch(search, req, res) {
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
  if (youtube_playlist_match?.length === 34 && Number(req.query.v || 0) >= 2) {
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

async function makeAPIRequestWithRetries(url) {
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
    .sort((a, b) => Number(b?.audioQuality || 0) - Number(a?.audioQuality || 0));

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
