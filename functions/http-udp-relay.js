#!/usr/bin/env node
// Experimental HTTP to reliable-UDP relay for Playit free/UDP tunnels.
// Exposes the ComputerCraft HTTP API and forwards requests to udp-bridge-server.js.
import "dotenv/config";
import crypto from "node:crypto";
import dgram from "node:dgram";
import express from "express";

const relayPort = Number(process.env.RELAY_PORT || process.env.PORT || 8081);
const playitHost = process.env.PLAYIT_UDP_HOST || "127.0.0.1";
const playitPort = Number(process.env.PLAYIT_UDP_PORT || process.env.UDP_PORT || 19132);

const retryMs = Number(process.env.UDP_RETRY_MS || 750);
const maxRetries = Number(process.env.UDP_MAX_RETRIES || 8);
const requestTimeoutMs = Number(process.env.UDP_REQUEST_TIMEOUT_MS || 14400 * 1000);

const app = express();
const socket = dgram.createSocket("udp4");
const requests = new Map();

app.disable("x-powered-by");

function encodePacket(packet) {
  return Buffer.from(JSON.stringify(packet));
}

function sendPacket(packet) {
  socket.send(encodePacket(packet), playitPort, playitHost);
}

function sendAck(requestId, seq) {
  sendPacket({ type: "ack", requestId, seq });
}

function safeRequestHeaders(req) {
  const allowed = new Set(["accept", "range", "user-agent"]);
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (allowed.has(key.toLowerCase()) && typeof value === "string") out[key] = value;
  }
  return out;
}

function makeRequestState(req, res, timeoutMs) {
  const requestId = crypto.randomUUID();
  const state = {
    requestId,
    req,
    res,
    createdAt: Date.now(),
    attempts: 0,
    expectedSeq: 0,
    buffer: new Map(),
    opened: false,
    closed: false,
  };

  state.close = () => {
    state.closed = true;
    clearTimeout(state.retryTimer);
    clearTimeout(state.timeoutTimer);
    requests.delete(requestId);
  };

  state.timeoutTimer = setTimeout(() => {
    if (state.closed) return;
    if (!res.headersSent) res.status(504).send("Gateway timeout");
    else res.destroy(new Error("Gateway timeout"));
    state.close();
  }, timeoutMs);

  const openPacket = {
    type: "open",
    requestId,
    seq: 0,
    method: req.method,
    path: req.originalUrl || req.url || "/",
    headers: safeRequestHeaders(req),
  };

  state.sendOpen = () => {
    if (state.closed) return;
    if (state.attempts > maxRetries) {
      if (!res.headersSent) res.status(504).send("Gateway timeout");
      else res.destroy(new Error("Gateway timeout"));
      state.close();
      return;
    }
    state.attempts++;
    sendPacket(openPacket);
    state.retryTimer = setTimeout(state.sendOpen, retryMs);
  };

  requests.set(requestId, state);
  state.sendOpen();
  res.on("close", state.close);
  return state;
}

function applyHeaders(res, headers = {}) {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase()) && value != null) res.setHeader(key, value);
  }
}

function processPacket(state, packet) {
  if (state.closed || !Number.isInteger(packet.seq)) return;
  state.buffer.set(packet.seq, packet);

  while (state.buffer.has(state.expectedSeq)) {
    const current = state.buffer.get(state.expectedSeq);
    state.buffer.delete(state.expectedSeq);
    state.expectedSeq++;

    if (current.type === "open") {
      if (!state.res.headersSent) {
        applyHeaders(state.res, current.headers);
        state.res.status(current.status || 200);
      }
      state.opened = true;
      continue;
    }

    if (current.type === "data") {
      if (!state.opened && !state.res.headersSent) {
        state.res.setHeader("Content-Type", "application/octet-stream");
        state.res.status(200);
        state.opened = true;
      }
      const chunk = Buffer.from(current.data || "", "base64");
      state.res.write(chunk);
      continue;
    }

    if (current.type === "end") {
      state.res.end();
      state.close();
      return;
    }

    if (current.type === "error") {
      const status = current.status === 504 ? 504 : 502;
      if (!state.res.headersSent) state.res.status(status).send(current.message || "Bad gateway");
      else state.res.destroy(new Error(current.message || "Bad gateway"));
      state.close();
      return;
    }
  }
}

socket.on("message", (message) => {
  let packet;
  try {
    packet = JSON.parse(message.toString("utf8"));
  } catch {
    return;
  }

  if (!packet || typeof packet !== "object" || !packet.requestId) return;
  const state = requests.get(packet.requestId);
  if (!state) return;

  if (packet.type === "ack") {
    if (packet.seq === 0) {
      clearTimeout(state.retryTimer);
    }
    return;
  }

  if (Number.isInteger(packet.seq)) {
    sendAck(packet.requestId, packet.seq);
  }

  processPacket(state, packet);
});

app.all("/healthz", (req, res) => {
  makeRequestState(req, res, Number(process.env.UDP_HEALTH_TIMEOUT_MS || 5000));
});

app.all("/", (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).send("Method not allowed");
  }
  makeRequestState(req, res, requestTimeoutMs);
});

app.use((_req, res) => {
  res.status(404).send("Not found");
});

app.listen(relayPort, () => {
  console.log(`[http-udp-relay] listening on :${relayPort}`);
  console.log(`[http-udp-relay] forwarding UDP to ${playitHost}:${playitPort}`);
});
