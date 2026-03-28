#!/usr/bin/env bash
set -e

# Load shell profile for PATH (bun, node, etc.)
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null
[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null
[ -f "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" 2>/dev/null

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; }

# Check pm2
if ! command -v pm2 &>/dev/null; then
    error "pm2 not found. Install with: npm i -g pm2"
    exit 1
fi

# Create logs dir
mkdir -p logs

# Install API dependencies
info "Installing API dependencies..."
cd functions
if command -v bun &>/dev/null; then
    bun install --frozen-lockfile 2>/dev/null || bun install
else
    npm install --omit=dev
fi
cd ..

# Build web dashboard
info "Installing web dependencies..."
cd web
if command -v bun &>/dev/null; then
    bun install --frozen-lockfile 2>/dev/null || bun install
else
    npm install --omit=dev
fi
info "Building web dashboard..."
if command -v bun &>/dev/null; then
    bun run build
else
    npx next build
fi
cd ..

# Check .env
if [ ! -f functions/.env ]; then
    warn "functions/.env not found — creating from template"
    cat > functions/.env <<'EOF'
RAPIDAPI_API_KEYS=
GITHUB_OWNER=
GITHUB_REPO=
PORT=8080
EOF
    warn "Edit functions/.env with your settings before first use"
fi

# Start with pm2
info "Starting services with pm2..."
pm2 start ecosystem.config.cjs

info "Services started!"
echo ""
pm2 status
echo ""
info "API:       http://localhost:8080"
info "Dashboard: http://localhost:3000"
echo ""
info "Useful commands:"
echo "  pm2 logs          # View all logs"
echo "  pm2 logs ipod-api # View API logs only"
echo "  pm2 monit         # Real-time monitoring"
echo "  pm2 restart all   # Restart services"
echo "  pm2 stop all      # Stop services"
echo "  pm2 save          # Save process list for boot"
echo "  pm2 startup       # Generate boot startup script"
