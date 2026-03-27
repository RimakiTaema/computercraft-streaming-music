#!/usr/bin/env node
import express from "express";
import { ipodHandler } from "./index.js";

const app = express();
const port = Number(process.env.PORT || 8080);

app.disable("x-powered-by");

app.all("/", async (req, res) => {
  return ipodHandler(req, res);
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`standalone ipod api listening on :${port}`);
});
