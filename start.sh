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

API_PORT="${API_PORT:-}"
WEB_PORT="${WEB_PORT:-}"
API_URL_OVERRIDE="${API_URL:-}"

get_env_value() {
    local file="$1"
    local key="$2"

    [ -f "$file" ] || return 0

    sed -n "s/^${key}=//p" "$file" | tail -n 1
}

setup_functions_env() {
    local rapidapi_api_keys=""
    local github_owner=""
    local github_repo=""
    local api_port="8080"
    local web_port="3000"
    local api_url=""

    warn "functions/.env not found — starting first-time setup"

    if [ -t 0 ]; then
        echo ""
        info "First boot setup (press Enter to keep defaults)"
        read -r -p "RAPIDAPI_API_KEYS (comma-separated): " rapidapi_api_keys
        read -r -p "GITHUB_OWNER: " github_owner
        read -r -p "GITHUB_REPO: " github_repo
        read -r -p "API PORT [8080]: " api_port_input
        read -r -p "WEB PORT [3000]: " web_port_input
        read -r -p "API URL for web (optional, e.g. https://your.domain/api): " api_url

        if [ -n "${api_port_input:-}" ]; then
            api_port="$api_port_input"
        fi
        if [ -n "${web_port_input:-}" ]; then
            web_port="$web_port_input"
        fi
    else
        warn "No interactive terminal detected — writing default functions/.env template"
    fi

    cat > functions/.env <<EOF
RAPIDAPI_API_KEYS=${rapidapi_api_keys}
GITHUB_OWNER=${github_owner}
GITHUB_REPO=${github_repo}
PORT=${api_port}
WEB_PORT=${web_port}
API_URL=${api_url}
EOF

    info "Created functions/.env"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --api-port)
            if [ -z "${2:-}" ]; then
                error "--api-port requires a value"
                exit 1
            fi
            API_PORT="$2"
            shift 2
            ;;
        --web-port)
            if [ -z "${2:-}" ]; then
                error "--web-port requires a value"
                exit 1
            fi
            WEB_PORT="$2"
            shift 2
            ;;
        --api-url)
            if [ -z "${2:-}" ]; then
                error "--api-url requires a value"
                exit 1
            fi
            API_URL_OVERRIDE="$2"
            shift 2
            ;;
        *)
            warn "Unknown option: $1"
            shift
            ;;
    esac
done

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
    npm install
fi
cd ..

# Build web dashboard
info "Installing web dependencies..."
cd web
if command -v bun &>/dev/null; then
    bun install --frozen-lockfile 2>/dev/null || bun install
else
    npm install
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
    setup_functions_env
fi

ENV_API_PORT="$(get_env_value functions/.env PORT)"
ENV_WEB_PORT_FUNCTIONS="$(get_env_value functions/.env WEB_PORT)"
ENV_WEB_PORT_WEB="$(get_env_value web/.env WEB_PORT)"
ENV_WEB_PORT_WEB_LOCAL="$(get_env_value web/.env.local WEB_PORT)"
ENV_API_URL_FUNCTIONS="$(get_env_value functions/.env API_URL)"
ENV_API_URL_WEB="$(get_env_value web/.env API_URL)"
ENV_API_URL_WEB_LOCAL="$(get_env_value web/.env.local API_URL)"

if [ -z "$API_PORT" ]; then
    API_PORT="${ENV_API_PORT:-8080}"
fi
if [ -z "$WEB_PORT" ]; then
    WEB_PORT="${ENV_WEB_PORT_WEB_LOCAL:-${ENV_WEB_PORT_WEB:-${ENV_WEB_PORT_FUNCTIONS:-3000}}}"
fi

export API_PORT WEB_PORT
export PORT="$API_PORT"
if [ -z "$API_URL_OVERRIDE" ]; then
    API_URL_OVERRIDE="${ENV_API_URL_WEB_LOCAL:-${ENV_API_URL_WEB:-${ENV_API_URL_FUNCTIONS:-}}}"
fi
export API_URL="${API_URL_OVERRIDE:-http://localhost:${API_PORT}}"

# Start with pm2
info "Starting services with pm2..."
pm2 start ecosystem.config.cjs --update-env

info "Services started!"
echo ""
pm2 status
echo ""
info "API:       http://localhost:${API_PORT}"
info "Dashboard: http://localhost:${WEB_PORT}"
info "Web -> API: ${API_URL}"
echo ""
info "Useful commands:"
echo "  pm2 logs          # View all logs"
echo "  pm2 logs ipod-api # View API logs only"
echo "  pm2 monit         # Real-time monitoring"
echo "  pm2 restart all   # Restart services"
echo "  pm2 stop all      # Stop services"
echo "  pm2 save          # Save process list for boot"
echo "  pm2 startup       # Generate boot startup script"
