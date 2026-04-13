#!/bin/bash
# claude-monitor one-line installer
# Usage: curl -fsSL https://github.com/bboutayeb/claude-system/releases/latest/download/install.sh | bash
set -euo pipefail

GITHUB_REPO="bboutayeb/claude-system"
INSTALL_DIR="$HOME/.claude-monitor/bin"
BIN_NAME="claude-monitor"

# Detect OS and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux*)
    case "$ARCH" in
      x86_64) PLATFORM="linux-x64" ;;
      *)
        echo "Unsupported architecture: $ARCH"
        echo "Supported: x86_64 on Linux, arm64/x86_64 on macOS"
        exit 1
        ;;
    esac
    ;;
  Darwin*)
    case "$ARCH" in
      arm64)   PLATFORM="darwin-arm64" ;;
      x86_64)  PLATFORM="darwin-x64" ;;
      *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS"
    echo "Supported: Linux (x64), macOS (arm64, x64)"
    exit 1
    ;;
esac

BINARY_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/claude-monitor-${PLATFORM}"

echo "Installing claude-monitor..."
echo "  Platform: $PLATFORM"
echo "  From:     $BINARY_URL"

mkdir -p "$INSTALL_DIR"
curl -fsSL "$BINARY_URL" -o "$INSTALL_DIR/$BIN_NAME"
chmod +x "$INSTALL_DIR/$BIN_NAME"

echo "  Binary downloaded to $INSTALL_DIR/$BIN_NAME"

# Add to PATH hint
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo ""
  echo "Add to your PATH by adding this line to ~/.bashrc or ~/.zshrc:"
  echo "  export PATH=\"\$HOME/.claude-monitor/bin:\$PATH\""
  echo ""
  export PATH="$INSTALL_DIR:$PATH"
fi

# Run install
"$INSTALL_DIR/$BIN_NAME" install
