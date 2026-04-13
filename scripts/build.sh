#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_DIR/dist"

mkdir -p "$DIST_DIR"

echo "Building claude-monitor binaries..."

cd "$REPO_DIR"

# Linux x64
echo "  → linux-x64"
bun build --compile --target=bun-linux-x64 \
  src/cli.ts \
  --outfile "$DIST_DIR/claude-monitor-linux-x64"

# macOS Apple Silicon
echo "  → darwin-arm64"
bun build --compile --target=bun-darwin-arm64 \
  src/cli.ts \
  --outfile "$DIST_DIR/claude-monitor-darwin-arm64"

# macOS Intel
echo "  → darwin-x64"
bun build --compile --target=bun-darwin-x64 \
  src/cli.ts \
  --outfile "$DIST_DIR/claude-monitor-darwin-x64"

echo ""
echo "Binaries written to $DIST_DIR/"
ls -lh "$DIST_DIR"/claude-monitor-*
