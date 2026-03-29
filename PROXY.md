# Reverse Proxy & Security Guide

Production deployment guide for the iPod API + Dashboard behind nginx.

## Architecture

```
Internet → nginx (:443) → API  (localhost:8080)
                        → Web  (localhost:3000)
```

---

## Prerequisites

```bash
# Install nginx
sudo apt install nginx    # Debian/Ubuntu
sudo yum install nginx    # RHEL/CentOS
brew install nginx        # macOS

# Install certbot for SSL
sudo apt install certbot python3-certbot-nginx
```

---

## Nginx Configuration

Create `/etc/nginx/sites-available/ipod-api`:

```nginx
# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api_general:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=api_download:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=api_search:10m rate=15r/m;
limit_conn_zone $binary_remote_addr zone=stream_conn:10m;

# Block bad user agents
map $http_user_agent $bad_agent {
    default 0;
    ~*sqlmap 1;
    ~*nikto 1;
    ~*nmap 1;
    ~*dirbuster 1;
    ~*gobuster 1;
    ~*masscan 1;
    ~*nuclei 1;
    ~*wpscan 1;
    ~*zgrab 1;
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL (certbot auto-generates these)
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';" always;

    # Block bad user agents
    if ($bad_agent) {
        return 403;
    }

    # Block sensitive file access
    location ~* \.(env|git|htaccess|htpasswd|ini|log|sh|sql|bak|swp|config|pem|key)$ {
        return 403;
    }

    # Block path traversal
    location ~* \.\./ {
        return 403;
    }

    # Block PHP/CGI/ASP probes
    location ~* \.(php|cgi|asp|aspx|jsp)$ {
        return 403;
    }

    # Block wp-* scanner probes
    location ~* (wp-admin|wp-login|wp-content|xmlrpc|phpmyadmin) {
        return 403;
    }

    # ─── API (port 8080) ───────────────────────────────────

    # Download endpoint — strictest limits
    location ~ ^/\?.*(\bid=|\burl=) {
        limit_req zone=api_download burst=2 nodelay;
        limit_conn stream_conn 3;

        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Stream-friendly: no buffering, 4hr timeout for long songs
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 14400s;
        proxy_send_timeout 14400s;
    }

    # General API — moderate limits
    location = / {
        limit_req zone=api_general burst=10 nodelay;

        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Health check — no limits
    location = /healthz {
        proxy_pass http://127.0.0.1:8080;
    }

    # ─── Web Dashboard (port 3000, basePath=/dashboard) ────

    location /dashboard {
        limit_req zone=api_general burst=20 nodelay;

        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support for Next.js HMR (dev only)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Next.js static assets
    location /_next {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_cache_valid 200 365d;
        add_header Cache-Control "public, immutable";
    }

    # Deny everything else
    location / {
        return 404;
    }

    # Logging
    access_log /var/log/nginx/ipod-access.log;
    error_log  /var/log/nginx/ipod-error.log warn;
}
```

## Enable & Start

```bash
# Symlink config
sudo ln -s /etc/nginx/sites-available/ipod-api /etc/nginx/sites-enabled/

# Test config
sudo nginx -t

# Get SSL certificate
sudo certbot --nginx -d your-domain.com

# Reload
sudo systemctl reload nginx
```

---

## Express Trust Proxy

When behind nginx, set in `functions/.env`:

```env
TRUST_PROXY=true
```

This makes Express read `X-Real-IP` / `X-Forwarded-For` so rate limiting uses the real client IP instead of `127.0.0.1`.

---

## Security Layers Summary

```
Layer 1: nginx
  ├─ SSL/TLS termination
  ├─ Rate limiting (per zone: general/download/search)
  ├─ Connection limits (max 3 streams per IP)
  ├─ Bad user-agent blocking (scanners)
  ├─ Sensitive file blocking (.env, .git, .pem, etc.)
  ├─ Path traversal blocking
  ├─ CMS probe blocking (wp-*, phpmyadmin)
  └─ Security headers (CSP, X-Frame, XSS)

Layer 2: Express WAF middleware (standalone-server.js)
  ├─ Pattern matching (SQL injection, XSS, command injection)
  ├─ File/path traversal patterns (.env, ../,  etc.)
  ├─ Auto-ban IPs after 5 strikes (15 min ban)
  ├─ Rate limiting (30 req/min general, 5 downloads/min)
  └─ Concurrent stream limit (3 per IP)

Layer 3: handler.js sanitization
  ├─ sanitizeUrl() — blocks file://, private IPs, cloud metadata
  ├─ Video ID regex validation (11 alphanumeric chars only)
  ├─ yt-dlp --no-exec --no-batch flags
  └─ Platform-aware URL validation
```

---

## Firewall (Optional)

```bash
# Allow only HTTP/HTTPS + SSH
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Block ports 8080/3000 from external access
# (nginx handles all external traffic)
sudo ufw deny 8080/tcp
sudo ufw deny 3000/tcp
```

---

## Fail2ban (Optional)

Create `/etc/fail2ban/jail.d/ipod-api.conf`:

```ini
[ipod-api]
enabled  = true
port     = http,https
filter   = ipod-api
logpath  = /var/log/nginx/ipod-access.log
maxretry = 20
findtime = 60
bantime  = 3600
```

Create `/etc/fail2ban/filter.d/ipod-api.conf`:

```ini
[Definition]
failregex = ^<HOST> .* "(GET|POST|HEAD) .+" (403|429) .*$
ignoreregex =
```

```bash
sudo systemctl restart fail2ban
```

---

## Monitoring

```bash
# PM2 status
pm2 status
pm2 monit

# Nginx logs
tail -f /var/log/nginx/ipod-access.log
tail -f /var/log/nginx/ipod-error.log

# API logs
pm2 logs ipod-api

# Check active bans (fail2ban)
sudo fail2ban-client status ipod-api
```
