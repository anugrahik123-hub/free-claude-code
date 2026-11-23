#!/usr/bin/env bash
export FCC_ADMIN_ALLOWED_IPS="0.0.0.0/1,128.0.0.0/1,::/1,8000::/1"
export FCC_TRUSTED_PROXY_IPS="0.0.0.0/1,128.0.0.0/1,::/1,8000::/1"
export FCC_ADMIN_ALLOWED_HOSTS="${CODESPACE_NAME}-8082.app.github.dev"
export PATH="$HOME/.local/bin:$PATH"
set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

BRIDGE_PORT=8765
SERVER_PORT=8082
BRIDGE_LOG="/tmp/bridge.log"
SERVER_LOG="/tmp/fcc-server.log"

log() {
  echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"
}

warn() {
  echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} $*"
}

error() {
  echo -e "${RED}[$(date '+%H:%M:%S')]${NC} $*"
}

# Wait for a port to be listening (up to timeout seconds)
wait_for_port() {
  local port=$1
  local name=$2
  local timeout=${3:-15}
  local start_time
  start_time=$(date +%s)
  log "Waiting for $name on port $port..."
  while ! (echo > /dev/tcp/127.0.0.1/"$port") 2>/dev/null; do
    local elapsed
    elapsed=$(($(date +%s) - start_time))
    if [[ $elapsed -ge $timeout ]]; then
      error "Timeout waiting for $name on port $port after ${timeout}s"
      return 1
    fi
    sleep 0.5
  done
  log "$name is listening on port $port"
  return 0
}

# Kill processes on specific ports
kill_port() {
  local port=$1
  local name=$2
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    warn "Stopping $name on port $port (PIDs: $pids)..."
    kill $pids 2>/dev/null || true
    sleep 1
    # Force kill if still alive
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      warn "Force killing $name (PIDs: $pids)..."
      kill -9 $pids 2>/dev/null || true
      sleep 0.5
    fi
  else
    log "No $name process found on port $port"
  fi
}

# Kill by process name pattern
kill_pattern() {
  local pattern=$1
  local name=$2
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    warn "Stopping $name processes (PIDs: $pids)..."
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      warn "Force killing $name (PIDs: $pids)..."
      kill -9 $pids 2>/dev/null || true
      sleep 0.5
    fi
  else
    log "No $name processes found"
  fi
}

# Set Codespace port visibility with retries
set_port_visibility() {
  local port=$1
  local max_attempts=3
  local attempt=1
  while [[ $attempt -le $max_attempts ]]; do
    if gh codespace ports visibility "$port:public" -c "$CODESPACE_NAME" 2>/dev/null; then
      log "Port $port set to public visibility"
      return 0
    else
      warn "Attempt $attempt/$max_attempts: Failed to set port $port visibility, retrying in 3s..."
      sleep 3
      ((attempt++))
    fi
  done
  error "Failed to set port $port visibility after $max_attempts attempts"
  return 1
}

main() {
  log "=== Starting free-claude-code services ==="

  # Stop any existing services
  kill_port $BRIDGE_PORT "bridge.js"
  kill_port $SERVER_PORT "fcc-server"
  kill_pattern "node.*bridge\.js" "bridge.js"
  kill_pattern "fcc-server" "fcc-server"

  # Start fcc-server with explicit host binding
  log "Starting fcc-server on port $SERVER_PORT..."
  nohup fcc-server --host 0.0.0.0 --port "$SERVER_PORT" > "$SERVER_LOG" 2>&1 &
  SERVER_PID=$!

  # Start bridge.js
  log "Starting bridge.js on port $BRIDGE_PORT..."
  nohup node bridge.js > "$BRIDGE_LOG" 2>&1 &
  BRIDGE_PID=$!

  # Wait for both ports to be actually listening (up to 15s each)
  wait_for_port $SERVER_PORT "fcc-server" 15 || {
    error "fcc-server failed to start. Check $SERVER_LOG"
    tail -20 "$SERVER_LOG"
    exit 1
  }
  wait_for_port $BRIDGE_PORT "bridge.js" 15 || {
    error "bridge.js failed to start. Check $BRIDGE_LOG"
    tail -20 "$BRIDGE_LOG"
    exit 1
  }

  # Verify processes are still running after ports are confirmed
  sleep 2
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    error "fcc-server crashed after startup. Check $SERVER_LOG"
    tail -20 "$SERVER_LOG"
    exit 1
  fi
  log "fcc-server started (PID: $SERVER_PID)"

  if ! kill -0 $BRIDGE_PID 2>/dev/null; then
    error "bridge.js crashed after startup. Check $BRIDGE_LOG"
    tail -20 "$BRIDGE_LOG"
    exit 1
  fi
  log "bridge.js started (PID: $BRIDGE_PID)"

  # Make Codespace ports public with retry loop
  if [[ -n "${CODESPACE_NAME:-}" ]]; then
    log "Making ports public in Codespace: $CODESPACE_NAME"
    set_port_visibility $SERVER_PORT
    set_port_visibility $BRIDGE_PORT
  else
    warn "CODESPACE_NAME not set; skipping port visibility configuration"
  fi

  # Print status
  echo
  log "=== Service Status ==="
  echo "  fcc-server:  http://localhost:$SERVER_PORT (PID: $SERVER_PID)"
  echo "    Log: $SERVER_LOG"
  echo "  bridge.js:   ws://localhost:$BRIDGE_PORT (PID: $BRIDGE_PID)"
  echo "    Log: $BRIDGE_LOG"
  echo
  log "Use 'tail -f $SERVER_LOG' or 'tail -f $BRIDGE_LOG' to follow logs"
  log "Run './start.sh' again to restart services"
}

main "$@"