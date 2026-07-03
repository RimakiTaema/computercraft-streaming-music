#!/usr/bin/env node
// Experimental UDP bridge for Playit free/UDP tunnels.
// Runs next to standalone-server.js and forwards bridge requests to the local HTTP API.
import "dotenv/config";
import dgram from "node:dgram";
import { setTimeout as delay } from "node:timers/promises";

const udpHost = process.env.UDP_HOST || "0.0.0.0";
const udpPort = Number(process.env.UDP_PORT || 19132);
const apiBase = process.env.API_BASE || `http://127.0.0.1:${process.env.API_PORT || process.env.PORT || 8080}`;

const retryMs = Number(process.env.UDP_RETRY_MS || 750);
const maxRetries = Number(process.env.UDP_MAX_RETRIES || 8);
const chunkBytes = Number(process.env.UDP_CHUNK_BYTES || 1000);
const requestTimeoutMs = Number(process.env.UDP_REQUEST_TIMEOUT_MS || 14400 * 1000);

const socket = dgram.createSocket("udp4");
const requests = new Map();

function encodePacket(packet) {
  return Buffer.from(JSON.stringify(packet));
}

function sendPacket(packet, port, address) {
  socket.send(encodePacket(packet), port, address);
}

function sendAck(requestId, seq, port, address) {
  sendPacket({ type: "ack", requestId, seq }, port, address);
}

function makeSender(requestId, port, address) {
  let nextSeq = 0;
  const pending = new Map();

  function sendReliable(packet) {
    const seq = nextSeq++;
    const reliablePacket = { ...packet, requestId, seq };
    return new Promise((resolve, reject) => {
      const state = { packet: reliablePacket, attempts: 0, closed: false, resolve, reject };
      pending.set(seq, state);

      const tick = () => {
        if (state.closed) return;
        if (state.attempts > maxRetries) {
          state.closed = true;
          pending.delete(seq);
          reject(new Error(`packet retry exhausted request=${requestId} seq=${seq}`));
          return;
        }
        state.attempts++;
        sendPacket(reliablePacket, port, address);
        state.timer = setTimeout(tick, retryMs);
      };

      tick();
    });
  }

  function ack(seq) {
    const state = pending.get(seq);
    if (!state) return;
    state.closed = true;
    clearTimeout(state.timer);
    pending.delete(seq);
    state.resolve();
  }

  function close() {
    for (const state of pending.values()) {
      state.closed = true;
      clearTimeout(state.timer);
      state.reject(new Error(`request closed before ack request=${requestId}`));
    }
    pending.clear();
  }

  return { sendReliable, ack, close };
}

async function sendTerminal(sender, packet, requestId) {
  try {
    await sender.sendReliable(packet);
  } catch (error) {
    console.warn(`[udp-bridge] terminal packet was not acknowledged request=${requestId}: ${error.message}`);
  }
}

function safeRequestPath(rawPath) {
  const path = typeof rawPath === "string" && rawPath.startsWith("/") ? rawPath : "/";
  const parsed = new URL(path, "http://bridge.local");
  if (parsed.pathname !== "/" && parsed.pathname !== "/healthz") {
    return null;
  }
  return `${parsed.pathname}${parsed.search}`;
}

function safeHeaders(headers = {}) {
  const allowed = new Set(["accept", "accept-encoding", "range", "user-agent"]);
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (allowed.has(lower) && typeof value === "string") out[lower] = value;
  }
  return out;
}

function publicHeaders(headers) {
  const blocked = new Set([
    "connection",
    "content-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const out = {};
  headers.forEach((value, key) => {
    if (!blocked.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

async function handleOpen(packet, remote) {
  const { requestId } = packet;
  if (!requestId || requests.has(requestId)) return;

  const path = safeRequestPath(packet.path);
  const method = packet.method === "HEAD" ? "HEAD" : "GET";
  const sender = makeSender(requestId, remote.port, remote.address);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  requests.set(requestId, { sender, controller, expectedSeq: 0 });

  try {
    if (!path) {
      await sendTerminal(sender, { type: "error", status: 400, message: "Unsupported bridge path" }, requestId);
      return;
    }

    const upstream = await fetch(new URL(path, apiBase), {
      method,
      headers: safeHeaders(packet.headers),
      signal: controller.signal,
    });

    await sender.sendReliable({
      type: "open",
      status: upstream.status,
      headers: publicHeaders(upstream.headers),
    });

    if (method === "HEAD" || !upstream.body) {
      await sendTerminal(sender, { type: "end", eof: true }, requestId);
      return;
    }

    const reader = upstream.body.getReader();
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i += chunkBytes) {
        const chunk = Buffer.from(value.slice(i, i + chunkBytes));
        await sender.sendReliable({
          type: "data",
          offset,
          eof: false,
          data: chunk.toString("base64"),
        });
        offset += chunk.length;
      }
    }

    await sendTerminal(sender, { type: "end", offset, eof: true }, requestId);
  } catch (error) {
    const status = error.name === "AbortError" ? 504 : 502;
    await sendTerminal(sender, { type: "error", status, message: error.message || "Bridge upstream error" }, requestId);
  } finally {
    clearTimeout(timeout);
    await delay(retryMs * Math.min(maxRetries, 2));
    sender.close();
    requests.delete(requestId);
  }
}

socket.on("message", (message, remote) => {
  let packet;
  try {
    packet = JSON.parse(message.toString("utf8"));
  } catch {
    return;
  }

  if (!packet || typeof packet !== "object" || !packet.requestId) return;

  if (packet.type === "ack") {
    requests.get(packet.requestId)?.sender.ack(packet.seq);
    return;
  }

  if (Number.isInteger(packet.seq)) {
    sendAck(packet.requestId, packet.seq, remote.port, remote.address);
  }

  if (packet.type === "ping") {
    const sender = makeSender(packet.requestId, remote.port, remote.address);
    sender.sendReliable({ type: "pong" });
    setTimeout(() => sender.close(), retryMs * Math.min(maxRetries, 2));
    return;
  }

  if (packet.type === "open") {
    handleOpen(packet, remote);
  }
});

socket.on("listening", () => {
  const address = socket.address();
  console.log(`[udp-bridge] listening on ${address.address}:${address.port}`);
  console.log(`[udp-bridge] forwarding to ${apiBase}`);
});

socket.bind(udpPort, udpHost);
