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
pause() { echo ""; read -r -p "Press Enter to continue..." _; }

API_PORT="${API_PORT:-}"
WEB_PORT="${WEB_PORT:-}"
API_URL_OVERRIDE="${API_URL:-}"
UDP_PORT_VALUE="${UDP_PORT:-19132}"
PLAYIT_UDP_HOST_VALUE="${PLAYIT_UDP_HOST:-}"
PLAYIT_UDP_PORT_VALUE="${PLAYIT_UDP_PORT:-}"
RELAY_PORT_VALUE="${RELAY_PORT:-8081}"
INSTALL_MODE="${INSTALL_MODE:-auto}"
MENU_MODE=1

if [ $# -gt 0 ]; then
    MENU_MODE=0
fi

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
        --udp-port)
            if [ -z "${2:-}" ]; then
                error "--udp-port requires a value"
                exit 1
            fi
            UDP_PORT_VALUE="$2"
            shift 2
            ;;
        --playit-udp-host)
            if [ -z "${2:-}" ]; then
                error "--playit-udp-host requires a value"
                exit 1
            fi
            PLAYIT_UDP_HOST_VALUE="$2"
            shift 2
            ;;
        --playit-udp-port)
            if [ -z "${2:-}" ]; then
                error "--playit-udp-port requires a value"
                exit 1
            fi
            PLAYIT_UDP_PORT_VALUE="$2"
            shift 2
            ;;
        --relay-port)
            if [ -z "${2:-}" ]; then
                error "--relay-port requires a value"
                exit 1
            fi
            RELAY_PORT_VALUE="$2"
            shift 2
            ;;
        --install)
            INSTALL_MODE="always"
            shift
            ;;
        --skip-install)
            INSTALL_MODE="never"
            shift
            ;;
        *)
            warn "Unknown option: $1"
            shift
            ;;
    esac
done

require_pm2() {
    if ! command -v pm2 &>/dev/null; then
        error "pm2 not found. Install with: npm i -g pm2"
        exit 1
    fi
}

install_api_dependencies() {
    if [ "$INSTALL_MODE" = "never" ]; then
        info "Skipping API dependency install"
        return
    fi
    if [ "$INSTALL_MODE" = "auto" ] && [ -d functions/node_modules ]; then
        info "API dependencies already installed"
        return
    fi

    info "Installing API dependencies..."
    cd functions
    if command -v bun &>/dev/null && { [ -f bun.lock ] || [ -f bun.lockb ]; }; then
        bun install --frozen-lockfile
    else
        npm install
    fi
    cd ..
}

install_web_dependencies_and_build() {
    if [ "$INSTALL_MODE" = "never" ]; then
        info "Skipping web dependency install"
    elif [ "$INSTALL_MODE" = "auto" ] && [ -d web/node_modules ]; then
        info "Web dependencies already installed"
    else
        info "Installing web dependencies..."
        cd web
        if command -v bun &>/dev/null && { [ -f bun.lock ] || [ -f bun.lockb ]; }; then
            bun install --frozen-lockfile
        else
            npm install
        fi
        cd ..
    fi

    info "Building web dashboard..."
    cd web
    if command -v bun &>/dev/null; then
        bun run build
    else
        npx next build
    fi
    cd ..
}

load_runtime_config() {
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
}

prepare_common() {
    require_pm2
    mkdir -p logs
    install_api_dependencies
    load_runtime_config
}

print_service_summary() {
    info "Services started!"
    echo ""
    pm2 status
    echo ""
    info "API:        http://localhost:${API_PORT}"
    info "Dashboard:  http://localhost:${WEB_PORT}"
    info "Web -> API: ${API_URL}"
    echo ""
    info "Useful commands:"
    echo "  pm2 logs                  # View all logs"
    echo "  pm2 logs ipod-api         # View API logs only"
    echo "  pm2 logs ipod-udp-bridge  # View UDP bridge logs"
    echo "  pm2 monit                 # Real-time monitoring"
    echo "  pm2 restart all           # Restart services"
    echo "  pm2 stop all              # Stop services"
    echo "  pm2 save                  # Save process list for boot"
    echo "  pm2 startup               # Generate boot startup script"
}

start_app_services() {
    prepare_common
    install_web_dependencies_and_build
    info "Starting API + dashboard with pm2..."
    pm2 start ecosystem.config.cjs --update-env
    print_service_summary
}

start_udp_bridge() {
    prepare_common
    info "Starting local UDP bridge with pm2..."
    UDP_PORT="$UDP_PORT_VALUE" PORT="$API_PORT" pm2 start functions/udp-bridge-server.js \
        --name ipod-udp-bridge \
        --interpreter node \
        --update-env
    pm2 status
    info "UDP bridge: 0.0.0.0:${UDP_PORT_VALUE} -> http://127.0.0.1:${API_PORT}"
}

start_http_udp_relay() {
    prepare_common
    if [ -z "$PLAYIT_UDP_HOST_VALUE" ]; then
        read -r -p "PLAYIT UDP host: " PLAYIT_UDP_HOST_VALUE
    fi
    if [ -z "$PLAYIT_UDP_PORT_VALUE" ]; then
        read -r -p "PLAYIT UDP port: " PLAYIT_UDP_PORT_VALUE
    fi
    if [ -z "$PLAYIT_UDP_HOST_VALUE" ] || [ -z "$PLAYIT_UDP_PORT_VALUE" ]; then
        error "PLAYIT UDP host and port are required for the public relay"
        return 1
    fi

    info "Starting public HTTP -> UDP relay with pm2..."
    RELAY_PORT="$RELAY_PORT_VALUE" PLAYIT_UDP_HOST="$PLAYIT_UDP_HOST_VALUE" PLAYIT_UDP_PORT="$PLAYIT_UDP_PORT_VALUE" pm2 start functions/http-udp-relay.js \
        --name ipod-http-udp-relay \
        --interpreter node \
        --update-env
    pm2 status
    info "HTTP relay: http://localhost:${RELAY_PORT_VALUE} -> ${PLAYIT_UDP_HOST_VALUE}:${PLAYIT_UDP_PORT_VALUE}/udp"
}

show_menu() {
    clear 2>/dev/null || true
    echo "iPod API Launcher"
    echo "================="
    echo ""
    echo "1) Start API + dashboard"
    echo "2) Start local UDP bridge for Playit free"
    echo "3) Start public HTTP -> UDP relay"
    echo "4) Start API + dashboard + local UDP bridge"
    echo "5) PM2 status"
    echo "6) PM2 logs"
    echo "7) Stop all PM2 services"
    echo "8) Toggle dependency install mode (${INSTALL_MODE})"
    echo "q) Quit"
    echo ""
}

run_menu() {
    while true; do
        show_menu
        read -r -p "Choose an option: " choice
        case "$choice" in
            1)
                start_app_services
                pause
                ;;
            2)
                read -r -p "UDP bridge port [${UDP_PORT_VALUE}]: " input_udp_port
                UDP_PORT_VALUE="${input_udp_port:-$UDP_PORT_VALUE}"
                start_udp_bridge
                pause
                ;;
            3)
                read -r -p "Relay HTTP port [${RELAY_PORT_VALUE}]: " input_relay_port
                RELAY_PORT_VALUE="${input_relay_port:-$RELAY_PORT_VALUE}"
                start_http_udp_relay
                pause
                ;;
            4)
                read -r -p "UDP bridge port [${UDP_PORT_VALUE}]: " input_udp_port
                UDP_PORT_VALUE="${input_udp_port:-$UDP_PORT_VALUE}"
                start_app_services
                start_udp_bridge
                pause
                ;;
            5)
                require_pm2
                pm2 status
                pause
                ;;
            6)
                require_pm2
                pm2 logs
                ;;
            7)
                require_pm2
                pm2 stop all
                pause
                ;;
            8)
                if [ "$INSTALL_MODE" = "auto" ]; then
                    INSTALL_MODE="never"
                elif [ "$INSTALL_MODE" = "never" ]; then
                    INSTALL_MODE="always"
                else
                    INSTALL_MODE="auto"
                fi
                info "Dependency install mode: ${INSTALL_MODE}"
                pause
                ;;
            q|Q)
                exit 0
                ;;
            *)
                warn "Unknown option: $choice"
                pause
                ;;
        esac
    done
}

if [ "$MENU_MODE" -eq 1 ] && [ -t 0 ]; then
    run_menu
else
    start_app_services
fi
