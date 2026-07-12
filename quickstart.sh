#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_VERSION="1.0.0"
readonly MINIMUM_NODE_MAJOR=20
readonly DEFAULT_NODE_VERSION=22
readonly DEFAULT_PORT=8787
readonly NVM_INSTALL_VERSION="v0.40.3"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
ROOT_DIR="$SCRIPT_DIR"
MODE="production"
PORT="$DEFAULT_PORT"
DATA_DIR="$ROOT_DIR/.nexusharness"
START_SERVER=1
RUN_SMOKE=1
FORCE_REPAIR=0
ALLOW_NODE_INSTALL=1
NODE_VERSION="$DEFAULT_NODE_VERSION"
CHILD_PID=""

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_CYAN=$'\033[38;5;51m'
  C_BLUE=$'\033[38;5;39m'
  C_VIOLET=$'\033[38;5;141m'
  C_GREEN=$'\033[38;5;84m'
  C_YELLOW=$'\033[38;5;220m'
  C_RED=$'\033[38;5;203m'
else
  C_RESET="" C_DIM="" C_CYAN="" C_BLUE="" C_VIOLET=""
  C_GREEN="" C_YELLOW="" C_RED=""
fi

timestamp() { date '+%H:%M:%S'; }
info() { printf '%s[%s] [INFO]%s %s\n' "$C_CYAN" "$(timestamp)" "$C_RESET" "$*"; }
success() { printf '%s[%s] [ OK ]%s %s\n' "$C_GREEN" "$(timestamp)" "$C_RESET" "$*"; }
warn() { printf '%s[%s] [WARN]%s %s\n' "$C_YELLOW" "$(timestamp)" "$C_RESET" "$*" >&2; }
die() { printf '%s[%s] [FAIL]%s %s\n' "$C_RED" "$(timestamp)" "$C_RESET" "$*" >&2; exit 1; }

on_error() {
  local exit_code=$?
  local line=${BASH_LINENO[0]:-unknown}
  printf '%s[%s] [FAIL]%s Bootstrap stopped at line %s (exit %s).\n' "$C_RED" "$(timestamp)" "$C_RESET" "$line" "$exit_code" >&2
  printf '%sRe-run with --repair after resolving the reported prerequisite. User data was not removed.%s\n' "$C_DIM" "$C_RESET" >&2
  exit "$exit_code"
}
trap on_error ERR

banner() {
  printf '%s' "$C_CYAN"
  cat <<'BANNER'
     _   _ ________  ___   _ _____
    | \ | |  ___\  \/  |  | /  ___|
    |  \| | |__  \  / /|  | \ `--.
    | . ` |  __| /  \ \|  | |`--. \
    | |\  | |___/ /\  \ |/ /\__/ /
    \_| \_/____/\/  \/\___/\____/
BANNER
  printf '%s' "$C_VIOLET"
  cat <<'BANNER'
        H A R N E S S   Q U I C K S T A R T
BANNER
  printf '%s\n' "$C_RESET"
  printf '%sLocal-first. Auditable. Ready to build.%s\n\n' "$C_DIM" "$C_RESET"
}

usage() {
  cat <<EOF
NexusHarness quickstart ${SCRIPT_VERSION}

Usage: ./quickstart.sh [options]

  --no-start             Install, migrate, build, and verify without starting.
  --dev                  Start the API and Vite development servers.
  --skip-smoke           Skip the production smoke test.
  --repair               Force a clean, lockfile-based dependency repair.
  --port PORT            Production/API port (default: ${DEFAULT_PORT}).
  --data-dir PATH        Persistent data directory (default: .nexusharness).
  --node-version MAJOR   Node version installed through nvm (default: ${DEFAULT_NODE_VERSION}).
  --no-node-install      Never install Node automatically.
  -h, --help             Show this help.

Environment equivalents:
  NEXUSHARNESS_PORT, NEXUSHARNESS_DATA_DIR, NO_COLOR

Examples:
  ./quickstart.sh
  ./quickstart.sh --no-start
  ./quickstart.sh --repair --port 9000
  ./quickstart.sh --dev --skip-smoke
EOF
}

parse_arguments() {
  while (($#)); do
    case "$1" in
      --no-start) START_SERVER=0 ;;
      --dev) MODE="development"; RUN_SMOKE=0 ;;
      --skip-smoke) RUN_SMOKE=0 ;;
      --repair) FORCE_REPAIR=1 ;;
      --no-node-install) ALLOW_NODE_INSTALL=0 ;;
      --port)
        (($# >= 2)) || die "--port requires a value."
        PORT="$2"; shift ;;
      --port=*) PORT="${1#*=}" ;;
      --data-dir)
        (($# >= 2)) || die "--data-dir requires a value."
        DATA_DIR="$2"; shift ;;
      --data-dir=*) DATA_DIR="${1#*=}" ;;
      --node-version)
        (($# >= 2)) || die "--node-version requires a value."
        NODE_VERSION="$2"; shift ;;
      --node-version=*) NODE_VERSION="${1#*=}" ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1. Run ./quickstart.sh --help." ;;
    esac
    shift
  done

  PORT="${NEXUSHARNESS_PORT:-$PORT}"
  DATA_DIR="${NEXUSHARNESS_DATA_DIR:-$DATA_DIR}"
  [[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || die "Port must be an integer from 1 through 65535."
  [[ "$NODE_VERSION" =~ ^[0-9]+$ ]] || die "--node-version must be a major version number."
}

validate_repository() {
  cd -- "$ROOT_DIR"
  [[ -f package.json && -f package-lock.json && -f server/index.ts ]] || die "Run this script from a complete NexusHarness checkout."
  success "Repository detected at $ROOT_DIR"
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
}

install_node_with_nvm() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*)
      die "Node.js ${MINIMUM_NODE_MAJOR}+ is required. Install Node LTS from https://nodejs.org/ or run quickstart.sh inside WSL, then retry."
      ;;
  esac

  ((ALLOW_NODE_INSTALL == 1)) || die "Node.js ${MINIMUM_NODE_MAJOR}+ is required and automatic installation is disabled."
  if command -v nvm >/dev/null 2>&1; then
    warn "Node.js is missing or too old; installing Node ${NODE_VERSION} through the existing nvm installation."
    nvm install "$NODE_VERSION"
    nvm alias default "$NODE_VERSION"
    nvm use "$NODE_VERSION"
    return
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "Node is unavailable and neither curl nor wget is installed. Install one downloader or Node.js ${MINIMUM_NODE_MAJOR}+."
  fi

  warn "Node.js is missing or too old; installing Node ${NODE_VERSION} through user-scoped nvm ${NVM_INSTALL_VERSION}."
  local installer
  installer="$(mktemp "${TMPDIR:-/tmp}/nexus-nvm.XXXXXX")"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 \
      "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_VERSION}/install.sh" --output "$installer"
  else
    wget --quiet --tries=3 --output-document="$installer" \
      "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_VERSION}/install.sh"
  fi
  bash "$installer"
  rm -f -- "$installer"
  load_nvm
  command -v nvm >/dev/null 2>&1 || die "nvm installation completed but nvm could not be loaded from $NVM_DIR."
  nvm install "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"
  nvm use "$NODE_VERSION"
}

ensure_node() {
  load_nvm
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  fi
  if [[ ! "$major" =~ ^[0-9]+$ ]] || ((major < MINIMUM_NODE_MAJOR)) || ! command -v npm >/dev/null 2>&1; then
    install_node_with_nvm
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  fi
  ((major >= MINIMUM_NODE_MAJOR)) || die "Node.js ${MINIMUM_NODE_MAJOR}+ is required; found $(node --version 2>/dev/null || printf 'none')."
  success "Runtime ready: Node $(node --version), npm $(npm --version)"
}

node_path() {
  local candidate="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -aw "$candidate"
  else
    node -e 'const path=require("node:path"); console.log(path.resolve(process.argv[1]))' "$candidate"
  fi
}

prepare_data_directory() {
  if command -v cygpath >/dev/null 2>&1 && [[ "$DATA_DIR" =~ ^[A-Za-z]:[\\/] ]]; then
    DATA_DIR="$(cygpath -au "$DATA_DIR")"
  fi
  mkdir -p -- "$DATA_DIR"
  local probe="$DATA_DIR/.quickstart-write-test-$$"
  : > "$probe" || die "Data directory is not writable: $DATA_DIR"
  rm -f -- "$probe"
  export NEXUSHARNESS_DATA_DIR="$(node_path "$DATA_DIR")"
  export NEXUSHARNESS_PORT="$PORT"
  success "Persistent data directory: $NEXUSHARNESS_DATA_DIR"
}

dependency_fingerprint() {
  node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); const h=crypto.createHash("sha256"); h.update(fs.readFileSync("package-lock.json")); h.update(process.version+process.platform+process.arch); console.log(h.digest("hex"));'
}

install_dependencies() {
  local state_dir="$DATA_DIR/bootstrap"
  local stamp="$state_dir/dependencies.sha256"
  local fingerprint
  mkdir -p -- "$state_dir"
  fingerprint="$(dependency_fingerprint)"

  if ((FORCE_REPAIR == 0)) && [[ -f "$stamp" ]] && [[ "$(<"$stamp")" == "$fingerprint" ]] && npm ls --depth=0 >/dev/null 2>&1; then
    success "Dependencies match package-lock.json; installation skipped."
    return
  fi

  info "Installing deterministic dependencies with npm ci..."
  if npm ci --include=dev --no-audit --no-fund; then
    printf '%s\n' "$fingerprint" > "$stamp"
    success "Dependencies installed."
    return
  fi

  warn "Initial npm ci failed. Verifying the npm cache and rebuilding generated dependencies."
  npm cache verify || warn "npm cache verification reported a problem; retrying from the registry."
  if [[ -d "$ROOT_DIR/node_modules" ]]; then
    [[ "$ROOT_DIR/node_modules" == "$ROOT_DIR"/* ]] || die "Refusing to repair node_modules outside the repository."
    rm -rf -- "$ROOT_DIR/node_modules"
  fi
  npm ci --include=dev --no-audit --no-fund
  printf '%s\n' "$fingerprint" > "$stamp"
  success "Dependency tree repaired from package-lock.json."
}

build_application() {
  info "Building server and browser production artifacts..."
  if npm run build; then
    success "Production build completed."
    return
  fi
  warn "Build failed. Refreshing dependencies once before retrying."
  FORCE_REPAIR=1
  install_dependencies
  npm run build
  success "Production build repaired and completed."
}

migrate_memory_database() {
  info "Applying idempotent memory-vector database migrations..."
  npm run memory:migrate
  success "Memory database is current and healthy."
}

run_smoke_test() {
  ((RUN_SMOKE == 1)) || { warn "Production smoke test skipped by request."; return; }
  info "Running isolated production smoke verification..."
  npm run test:smoke
  success "Production smoke verification passed."
}

healthy_server_running() {
  node -e 'const port=process.argv[1]; fetch(`http://127.0.0.1:${port}/api/health`, {signal:AbortSignal.timeout(1500)}).then(async r=>{const j=await r.json(); process.exit(r.ok&&j.status==="ok"&&j.version?0:1)}).catch(()=>process.exit(1))' "$PORT" >/dev/null 2>&1
}

port_is_available() {
  node -e 'const net=require("node:net"); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)))' "$PORT"
}

wait_for_health() {
  node -e 'const port=process.argv[1], deadline=Date.now()+20000; (async()=>{while(Date.now()<deadline){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)}); const j=await r.json(); if(r.ok&&j.status==="ok"){console.log(JSON.stringify({version:j.version,mode:j.mode,memory:j.memory?.retrievalMode})); return}}catch{} await new Promise(r=>setTimeout(r,250))} throw new Error(`Timed out waiting for NexusHarness on port ${port}`)})().catch(e=>{console.error(e.message);process.exit(1)})' "$PORT"
}

stop_child() {
  local signal=${1:-TERM}
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    warn "Forwarding $signal to NexusHarness (pid $CHILD_PID)..."
    kill "-$signal" "$CHILD_PID" 2>/dev/null || kill "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  CHILD_PID=""
}

start_application() {
  ((START_SERVER == 1)) || { success "Deployment prepared. Start later with ./quickstart.sh or npm start."; return; }

  if healthy_server_running; then
    success "NexusHarness is already healthy at http://127.0.0.1:${PORT}; no duplicate process started."
    return
  fi
  port_is_available || die "Port ${PORT} is occupied by a process that is not a healthy NexusHarness instance."

  if [[ "$MODE" == "development" ]]; then
    info "Starting development mode. UI: http://127.0.0.1:5173  API: http://127.0.0.1:${PORT}"
    exec npm run dev
  fi

  export NODE_ENV=production
  info "Starting NexusHarness production server..."
  node dist-server/server/index.js &
  CHILD_PID=$!
  trap 'stop_child INT; exit 130' INT
  trap 'stop_child TERM; exit 143' TERM
  trap 'stop_child TERM' EXIT

  local health
  if ! health="$(wait_for_health)"; then
    stop_child TERM
    die "NexusHarness did not become healthy. Review the server output above."
  fi
  success "NexusHarness is ready at http://127.0.0.1:${PORT}"
  info "Health: $health"
  info "Press Ctrl+C to stop. Persistent state remains in $NEXUSHARNESS_DATA_DIR"
  local status=0
  wait "$CHILD_PID" || status=$?
  CHILD_PID=""
  trap - EXIT INT TERM
  return "$status"
}

main() {
  parse_arguments "$@"
  banner
  info "Bootstrap version ${SCRIPT_VERSION}; mode=${MODE}; port=${PORT}"
  validate_repository
  ensure_node
  prepare_data_directory
  install_dependencies
  build_application
  migrate_memory_database
  run_smoke_test
  start_application
}

main "$@"
