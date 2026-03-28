#!/usr/bin/env node
// Standalone Express server — no Firebase dependency.
// Works on Spark (free) plan or any host (Railway, Render, Fly.io, etc).
import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ipodHandler, getMetrics } from "./handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8080);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? true : false);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ============================================================
// WAF — BLOCK MALICIOUS REQUESTS
// ============================================================

// Patterns that should NEVER appear in query params or paths
const WAF_BLOCKED_PATTERNS = [
  // File / path traversal
  /\.\.\//,                       // ../
  /\.\.\\/,                       // ..\
  /\.env/i,                       // .env access
  /\.git/i,                       // .git exposure
  /\.htaccess/i,
  /\.htpasswd/i,
  /\.ssh/i,
  /\.aws/i,
  /\.docker/i,
  /\.npmrc/i,
  /\.bash_history/i,
  /config\.json/i,
  /credentials/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /shadow$/i,
  // SQL injection
  /(\b(union|select|insert|update|delete|drop|alter)\b.*\b(from|into|table|where)\b)/i,
  /('|"|;)\s*--/,
  /\bOR\b\s+\d+\s*=\s*\d+/i,
  // Command injection
  /[;&|`$]\s*(cat|ls|rm|wget|curl|bash|sh|python|node|nc|ncat)\b/i,
  /\$\(.*\)/,                     // $(command)
  /`[^`]+`/,                      // `command`
  // XSS
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on(error|load|click|mouseover)\s*=/i,
  // PHP/CGI probes
  /\.php/i,
  /\.cgi/i,
  /\.asp/i,
  /wp-admin/i,
  /wp-login/i,
  /wp-content/i,
  /xmlrpc/i,
  /phpmyadmin/i,
  // Server internals
  /\/proc\//i,
  /\/etc\/(passwd|shadow|hosts)/i,
  /\/dev\/null/i,
  // Encoded traversal
  /%2e%2e/i,                      // encoded ../
  /%252e/i,                       // double-encoded
  /%00/,                          // null byte
];

// IPs that tripped WAF — auto-ban for 15 minutes
const bannedIps = new Map();  // ip -> { until, count }
const BAN_DURATION = 15 * 60 * 1000;
const BAN_THRESHOLD = 5;      // strikes before ban

function wafCheck(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "?";

  // Check ban list
  const ban = bannedIps.get(ip);
  if (ban && Date.now() < ban.until) {
    console.warn(`[waf] blocked banned IP: ${ip} (${ban.count} strikes)`);
    return res.status(403).send("Forbidden");
  }
  if (ban && Date.now() >= ban.until) {
    bannedIps.delete(ip);
  }

  // Build full scan target: URL + query string values
  const scanTargets = [
    req.originalUrl || req.url || "",
    ...Object.values(req.query || {}).map(String),
  ];
  const fullScan = scanTargets.join(" ");

  for (const pattern of WAF_BLOCKED_PATTERNS) {
    if (pattern.test(fullScan)) {
      console.warn(`[waf] BLOCKED ${ip}: pattern=${pattern} url=${(req.originalUrl || "").slice(0, 120)}`);

      // Track strikes
      const existing = bannedIps.get(ip) || { until: 0, count: 0 };
      existing.count++;
      if (existing.count >= BAN_THRESHOLD) {
        existing.until = Date.now() + BAN_DURATION;
        console.warn(`[waf] BANNED ${ip} for ${BAN_DURATION / 60000}m (${existing.count} strikes)`);
      }
      bannedIps.set(ip, existing);

      return res.status(403).send("Forbidden");
    }
  }

  next();
}

// Apply WAF to all routes
app.use(wafCheck);

// ============================================================
// RATE LIMITING (in-memory, no dependencies)
// ============================================================

const rateLimits = new Map();  // ip -> { tokens, lastRefill }
const RATE_LIMIT_MAX = 30;     // max requests per window
const RATE_LIMIT_WINDOW = 60 * 1000;  // 1 minute window
const RATE_LIMIT_REFILL = RATE_LIMIT_MAX;

// Stricter limit for downloads (expensive)
const downloadLimits = new Map();
const DL_RATE_MAX = 5;         // max 5 concurrent-ish downloads per minute
const DL_RATE_WINDOW = 60 * 1000;

function rateLimitCheck(limitsMap, max, window) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "?";
    const now = Date.now();

    let bucket = limitsMap.get(ip);
    if (!bucket || now - bucket.lastRefill > window) {
      bucket = { tokens: max, lastRefill: now };
    }

    if (bucket.tokens <= 0) {
      console.warn(`[rate] limited ${ip}: 0 tokens remaining`);
      res.setHeader("Retry-After", Math.ceil(window / 1000));
      return res.status(429).send("Too many requests");
    }

    bucket.tokens--;
    limitsMap.set(ip, bucket);
    next();
  };
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimits) {
    if (now - bucket.lastRefill > RATE_LIMIT_WINDOW * 2) rateLimits.delete(ip);
  }
  for (const [ip, bucket] of downloadLimits) {
    if (now - bucket.lastRefill > DL_RATE_WINDOW * 2) downloadLimits.delete(ip);
  }
  // Clean expired WAF bans
  for (const [ip, ban] of bannedIps) {
    if (now >= ban.until && ban.until > 0) bannedIps.delete(ip);
  }
}, 5 * 60 * 1000);

// ============================================================
// CONCURRENT STREAM LIMIT
// ============================================================

const MAX_STREAMS_PER_IP = 3;
const activeStreamsByIp = new Map(); // ip -> count

function streamLimitCheck(req, res, next) {
  const isDownload = req.query?.id || req.query?.url;
  if (!isDownload) return next();

  const ip = req.ip || req.socket?.remoteAddress || "?";
  const current = activeStreamsByIp.get(ip) || 0;

  if (current >= MAX_STREAMS_PER_IP) {
    console.warn(`[stream] rejected ${ip}: ${current}/${MAX_STREAMS_PER_IP} streams active`);
    return res.status(429).send("Too many active streams");
  }

  activeStreamsByIp.set(ip, current + 1);
  res.on("close", () => {
    const c = activeStreamsByIp.get(ip) || 1;
    if (c <= 1) activeStreamsByIp.delete(ip);
    else activeStreamsByIp.set(ip, c - 1);
  });

  next();
}

// ============================================================
// SESSION MANAGEMENT (in-memory, no dependencies)
// ============================================================

const sessions = new Map(); // token -> { createdAt, ip }
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24h

function createSession(ip) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now(), ip });
  return token;
}

function validateSession(token) {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_MAX_AGE) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ============================================================
// DASHBOARD AUTH MIDDLEWARE
// ============================================================

function requireAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    // No password set — warn and allow (dev mode)
    return next();
  }
  const token = parseCookie(req.headers.cookie, "dash_session");
  if (token && validateSession(token)) {
    return next();
  }
  // Not authenticated — redirect to login
  if (req.path === "/dashboard/api/stats") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/dashboard/login");
}

// ============================================================
// DASHBOARD ROUTES
// ============================================================

let dashboardHtml = null;
try {
  dashboardHtml = readFileSync(join(__dirname, "dashboard.html"), "utf-8");
} catch {
  console.warn("[init] dashboard.html not found, dashboard disabled");
}

// Login page
app.get("/dashboard/login", (_req, res) => {
  if (!DASHBOARD_PASSWORD) return res.redirect("/dashboard");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(buildLoginPage());
});

// Login POST
app.post("/dashboard/login", (req, res) => {
  const password = req.body?.password || "";
  if (!DASHBOARD_PASSWORD) return res.redirect("/dashboard");

  if (password === DASHBOARD_PASSWORD) {
    const token = createSession(req.ip || "?");
    res.setHeader("Set-Cookie", `dash_session=${token}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE / 1000}`);
    console.log(`[dashboard] login ok from ${req.ip}`);
    return res.redirect("/dashboard");
  }

  console.log(`[dashboard] login failed from ${req.ip}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(401).send(buildLoginPage("Invalid password"));
});

// Logout
app.get("/dashboard/logout", (req, res) => {
  const token = parseCookie(req.headers.cookie, "dash_session");
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "dash_session=; Path=/dashboard; HttpOnly; Max-Age=0");
  res.redirect("/dashboard/login");
});

// Dashboard (protected)
app.get("/dashboard", requireAuth, (_req, res) => {
  if (!dashboardHtml) return res.status(404).send("Dashboard not available");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHtml);
});

// Stats API (protected)
app.get("/dashboard/api/stats", requireAuth, (_req, res) => {
  res.json(getMetrics());
});

// ============================================================
// API ROUTE
// ============================================================

app.all("/",
  rateLimitCheck(rateLimits, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW),
  rateLimitCheck(downloadLimits, DL_RATE_MAX, DL_RATE_WINDOW),
  streamLimitCheck,
  async (req, res) => {
    const start = Date.now();
    console.log(`--> ${req.method} ${req.originalUrl} from ${req.ip}`);
    res.on("finish", () => {
      console.log(`<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    return ipodHandler(req, res);
  },
);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`standalone ipod api listening on :${port}`);
  console.log(`dashboard available at http://localhost:${port}/dashboard`);
  if (!DASHBOARD_PASSWORD) {
    console.warn("[!] DASHBOARD_PASSWORD not set — dashboard is unprotected. Set it in .env");
  }
});

// ============================================================
// LOGIN PAGE
// ============================================================

function buildLoginPage(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dashboard Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-card {
    background: #12121f;
    border: 1px solid #1e1e2e;
    border-radius: 16px;
    padding: 40px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  }
  .login-card h1 {
    font-size: 22px;
    color: #00d4ff;
    margin-bottom: 6px;
    text-align: center;
  }
  .login-card .sub {
    font-size: 13px;
    color: #555;
    text-align: center;
    margin-bottom: 28px;
  }
  .field {
    margin-bottom: 20px;
  }
  .field label {
    display: block;
    font-size: 12px;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .field input {
    width: 100%;
    padding: 12px 14px;
    background: #0a0a14;
    border: 1px solid #2a2a3a;
    border-radius: 8px;
    color: #e0e0e0;
    font-size: 15px;
    outline: none;
    transition: border-color 0.2s;
  }
  .field input:focus {
    border-color: #00d4ff;
  }
  .error {
    background: #f8717122;
    border: 1px solid #f8717144;
    color: #f87171;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    margin-bottom: 16px;
    text-align: center;
  }
  .btn {
    width: 100%;
    padding: 12px;
    background: linear-gradient(135deg, #00b4d8, #0090b0);
    border: none;
    border-radius: 8px;
    color: #fff;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn:hover { opacity: 0.9; }
  .btn:active { opacity: 0.8; }
  .icon {
    text-align: center;
    font-size: 40px;
    margin-bottom: 16px;
  }
</style>
</head>
<body>
<form class="login-card" method="POST" action="/dashboard/login">
  <div class="icon">\u{1F3B5}</div>
  <h1>iPod Dashboard</h1>
  <p class="sub">Enter password to access the dashboard</p>
  ${errorMsg ? `<div class="error">${errorMsg}</div>` : ""}
  <div class="field">
    <label>Password</label>
    <input type="password" name="password" autofocus required placeholder="Enter dashboard password">
  </div>
  <button type="submit" class="btn">Sign In</button>
</form>
</body>
</html>`;
}
