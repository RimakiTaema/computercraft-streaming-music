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

## Experimental Playit free UDP bridge

ComputerCraft still needs an HTTP URL in `music.lua`. Playit free/UDP-only tunnels cannot be used as that HTTP URL directly, so this repo includes an experimental bridge:

```
music.lua HTTP -> public http-udp-relay -> Playit UDP tunnel -> local udp-bridge-server -> standalone API
```

On the machine running the real API:

```bash
cd functions
npm install
npm start
UDP_PORT=19132 npm run start:udp-bridge
```

Create a Playit UDP tunnel that points at the bridge UDP port. On a public HTTP host, run the relay:

```bash
cd functions
PLAYIT_UDP_HOST=<your-playit-host> PLAYIT_UDP_PORT=<your-playit-port> RELAY_PORT=8081 npm run start:http-udp-relay
```

Then set `api_base_url` in `music.lua` to the public HTTP relay URL, not the Playit UDP address.

Bridge/relay environment:

- `UDP_PORT` (default `19132`) for the local bridge UDP listener.
- `API_BASE` (default `http://127.0.0.1:${PORT}`) for the bridge to call the standalone API.
- `PLAYIT_UDP_HOST` and `PLAYIT_UDP_PORT` for the relay target.
- `RELAY_PORT` (default `8081`) for the public HTTP relay.
- `UDP_RETRY_MS` (default `750`), `UDP_MAX_RETRIES` (default `8`), `UDP_CHUNK_BYTES` (default `1000`).

This mode is experimental. Long audio over reliable UDP is more fragile than normal HTTP/TCP. Playit Premium HTTP(S)/TCP tunnels are still the simpler production path.
