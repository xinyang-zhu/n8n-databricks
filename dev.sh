#!/bin/bash
# Fast n8n development restart script
# Usage: ./dev.sh [build|restart|watch]

set -e

# Load N8N env vars from user's shell config
for rc in ~/.zshrc ~/.bashrc ~/.bash_profile; do
    if [ -f "$rc" ]; then
        eval "$(grep '^export N8N_' "$rc" 2>/dev/null)" || true
        break
    fi
done

N8N_DIR="$(cd "$(dirname "$0")" && pwd)"
N8N_BIN="$N8N_DIR/packages/cli/bin/n8n"
PID_FILE="/tmp/n8n-dev.pid"

stop_n8n() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping n8n (PID: $PID)..."
            kill "$PID" 2>/dev/null || true
            sleep 1
        fi
        rm -f "$PID_FILE"
    fi
    # Also kill any orphaned n8n processes
    pkill -f "packages/cli/bin/n8n" 2>/dev/null || true
}

clear_cache() {
    echo "Clearing frontend cache..."
    rm -rf ~/.cache/n8n/public/*
}

build_cli() {
    echo "Building CLI package..."
    cd "$N8N_DIR"
    pnpm --filter=n8n build 2>&1 | tail -5
}

start_n8n() {
    echo "Starting n8n..."
    cd "$N8N_DIR"
    "$N8N_BIN" &
    echo $! > "$PID_FILE"
    echo "n8n started (PID: $(cat $PID_FILE))"
    echo "Editor: http://localhost:5678"
}

case "${1:-restart}" in
    build)
        build_cli
        ;;
    restart)
        stop_n8n
        clear_cache
        build_cli
        start_n8n
        ;;
    start)
        stop_n8n
        clear_cache
        start_n8n
        ;;
    stop)
        stop_n8n
        echo "n8n stopped"
        ;;
    watch)
        echo "Starting watch mode for CLI..."
        clear_cache
        cd "$N8N_DIR/packages/cli"
        pnpm run watch &
        WATCH_PID=$!
        cd "$N8N_DIR"

        # Wait for initial build
        sleep 3
        start_n8n

        echo ""
        echo "Watch mode active. Changes to packages/cli will auto-rebuild."
        echo "Press Ctrl+C to stop."
        wait $WATCH_PID
        ;;
    *)
        echo "Usage: $0 [build|restart|start|stop|watch]"
        echo "  build   - Build CLI package only"
        echo "  restart - Stop, build, and start (default)"
        echo "  start   - Start without building"
        echo "  stop    - Stop n8n"
        echo "  watch   - Watch mode with auto-rebuild"
        exit 1
        ;;
esac
