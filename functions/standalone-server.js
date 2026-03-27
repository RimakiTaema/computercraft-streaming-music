#!/usr/bin/env node
// Standalone Express server — no Firebase dependency.
// Works on Spark (free) plan or any host (Railway, Render, Fly.io, etc).
import "dotenv/config";
import express from "express";
import { ipodHandler } from "./handler.js";

const app = express();
const port = Number(process.env.PORT || 8080);

app.disable("x-powered-by");

app.all("/", async (req, res) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.originalUrl} from ${req.ip}`);
  res.on("finish", () => {
    console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  return ipodHandler(req, res);
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`standalone ipod api listening on :${port}`);
});
