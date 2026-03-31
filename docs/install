#!/bin/bash
# JSN CLI Installer
# Installs the latest JSN release from GitHub

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Repository info
REPO="jacebenson/jsn"
BINARY_NAME="jsn"

# Detect OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  linux)
    PLATFORM="linux"
    ;;
  darwin)
    PLATFORM="darwin"
    ;;
  mingw*|msys*|cygwin*)
    PLATFORM="windows"
    BINARY_NAME="jsn.exe"
    ;;
  *)
    echo -e "${RED}Unsupported OS: $OS${NC}"
    exit 1
    ;;
esac

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)
    ARCH="amd64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  armv7l)
    ARCH="arm"
    ;;
  *)
    echo -e "${RED}Unsupported architecture: $ARCH${NC}"
    exit 1
    ;;
esac

echo -e "${GREEN}Installing JSN for $PLATFORM/$ARCH...${NC}"

# Get latest release version
echo "Fetching latest release..."
LATEST_URL="https://api.github.com/repos/$REPO/releases/latest"
VERSION=$(curl -fsSL "$LATEST_URL" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$VERSION" ]; then
  echo -e "${RED}Failed to get latest version${NC}"
  exit 1
fi

echo "Latest version: $VERSION"

# Determine install location
if [ -w "/usr/local/bin" ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

# Build download URL
if [ "$PLATFORM" = "windows" ]; then
  ASSET_NAME="jsn_${VERSION}_${PLATFORM}_${ARCH}.zip"
else
  ASSET_NAME="jsn_${VERSION}_${PLATFORM}_${ARCH}.tar.gz"
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET_NAME"

# Download
echo "Downloading from $DOWNLOAD_URL..."
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

if ! curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_DIR/$ASSET_NAME"; then
  echo -e "${RED}Download failed${NC}"
  exit 1
fi

# Extract
echo "Extracting..."
cd "$TEMP_DIR"
if [ "$PLATFORM" = "windows" ]; then
  unzip -q "$ASSET_NAME"
else
  tar -xzf "$ASSET_NAME"
fi

# Find the binary (support both old format with versioned name and new format)
# Use shell globbing instead of find (Windows has a different find command)
BINARY_FILE=""
for f in jsn jsn.exe jsn_*; do
  if [ -f "$f" ] && [ "$f" != "*.tar.gz" ] && [ "$f" != "*.zip" ]; then
    BINARY_FILE="$f"
    break
  fi
done

if [ -z "$BINARY_FILE" ]; then
  echo -e "${RED}Could not find binary in archive${NC}"
  ls -la
  exit 1
fi
echo "Found binary: $BINARY_FILE"

# Install
echo "Installing to $INSTALL_DIR..."
if [ -w "$INSTALL_DIR" ]; then
  mv "$BINARY_FILE" "$INSTALL_DIR/$BINARY_NAME"
else
  mv "$BINARY_FILE" "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || {
    echo -e "${YELLOW}Need sudo access to install to $INSTALL_DIR${NC}"
    sudo mv "$BINARY_FILE" "$INSTALL_DIR/$BINARY_NAME"
  }
fi

# Verify installation
if command -v "$BINARY_NAME" >/dev/null 2>&1; then
  echo -e "${GREEN}✓ JSN installed successfully!${NC}"
  echo ""
  echo "Run 'jsn setup' to configure your ServiceNow instance"
  echo ""
  echo "Or get started with:"
  echo "  jsn --help"
  echo "  jsn tables list"
else
  echo -e "${YELLOW}⚠ JSN installed to $INSTALL_DIR but not in PATH${NC}"
  echo "Add this to your shell profile:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi
