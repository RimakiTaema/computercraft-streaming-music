# Standalone API mode (non-Firebase host)

You can run the same API handler outside Firebase Gen2.
This repo now supports both Firebase **Gen2** (`ipod`) and **Gen1** (`ipodGen1`) exports from the same core handler.

## Run locally

```bash
cd functions
npm install
npm run start:standalone
```

Server listens on `PORT` (default `8080`).

## Endpoints

- `GET /?id=<youtube_video_id>`
- `GET /?search=<query_or_youtube_url>&v=2.2.1_vibe`
- `GET /?changelogs=1&v=2.2.1_vibe`
- `GET /healthz`

## Required environment

- `RAPIDAPI_API_KEYS` (comma-separated keys)

## Optional environment

- `GITHUB_OWNER` (default `AngryManTV`)
- `GITHUB_REPO` (default `computercraft-streaming-music`)
- `GITHUB_CHANGELOG_DIR` (default `changelog`)
- `PORT` (default `8080`)

## Executable usage

The server entry has a node shebang and a package bin alias:

```bash
npm install
npx ipod-api
```
