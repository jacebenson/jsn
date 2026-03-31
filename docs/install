#!/usr/bin/env bash
# JSN CLI Installer
# Installs the latest JSN release from GitHub
#
# Usage:
#   curl -fsSL https://jsn.jace.pro/install | bash
#
# Environment:
#   JSN_VERSION    Install specific version (e.g., 0.4.1)
#   NO_COLOR       Disable colored output (https://no-color.org)

set -euo pipefail

REPO="jacebenson/jsn"
BINARY_NAME="jsn"
INSTALL_DIR="${JSN_INSTALL_DIR:-}"
VERSION="${JSN_VERSION:-}"

# Colors - respect NO_COLOR (https://no-color.org)
if [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
  BOLD='\033[1m'
else
  RED=''
  GREEN=''
  YELLOW=''
  NC=''
  BOLD=''
fi

info() { echo -e "${GREEN}✓${NC} $1"; }
step() { echo -e "${BOLD}→${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1" >&2; exit 1; }

detect_platform() {
  local os arch
  
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux) PLATFORM="linux" ;;
    darwin) PLATFORM="darwin" ;;
    mingw*|msys*|cygwin*) 
      PLATFORM="windows"
      BINARY_NAME="jsn.exe"
      ;;
    *) error "Unsupported OS: $os" ;;
  esac
  
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) ARCH="amd64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    armv7l) ARCH="arm" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac
}

get_latest_version() {
  # Use redirect URL instead of API to avoid rate limits
  local url
  url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null) || true
  local version="${url##*/}"
  version="${version#v}"
  
  if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    error "Could not determine latest version. Check your network connection."
  fi
  
  echo "$version"
}

setup_install_dir() {
  if [[ -z "$INSTALL_DIR" ]]; then
    if [[ -w "/usr/local/bin" ]]; then
      INSTALL_DIR="/usr/local/bin"
    else
      INSTALL_DIR="$HOME/.local/bin"
    fi
  fi
  mkdir -p "$INSTALL_DIR"
}

download_and_install() {
  local version="$1"
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf '$tmp_dir'" EXIT
  
  # Determine archive extension
  local ext
  if [[ "$PLATFORM" == "windows" ]]; then
    ext="zip"
  else
    ext="tar.gz"
  fi
  
  local filename="jsn_${version}_${PLATFORM}_${ARCH}.${ext}"
  local url="https://github.com/${REPO}/releases/download/v${version}/${filename}"
  
  step "Downloading JSN v${version} for ${PLATFORM}/${ARCH}..."
  if ! curl -fsSL "$url" -o "${tmp_dir}/${filename}"; then
    error "Download failed from $url"
  fi
  
  step "Extracting..."
  cd "$tmp_dir"
  if [[ "$PLATFORM" == "windows" ]]; then
    unzip -q "$filename"
  else
    tar -xzf "$filename"
  fi
  
  # Find binary using shell globbing (Windows find is different)
  local binary_file=""
  for f in jsn jsn.exe jsn_*; do
    if [[ -f "$f" ]] && [[ "$f" != "*.tar.gz" ]] && [[ "$f" != "*.zip" ]]; then
      binary_file="$f"
      break
    fi
  done
  
  if [[ -z "$binary_file" ]]; then
    error "Could not find binary in archive"
    ls -la
    exit 1
  fi
  
  step "Installing to $INSTALL_DIR..."
  if [[ -w "$INSTALL_DIR" ]]; then
    mv "$binary_file" "$INSTALL_DIR/$BINARY_NAME"
  else
    mv "$binary_file" "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || {
      warn "Need sudo access to install to $INSTALL_DIR"
      sudo mv "$binary_file" "$INSTALL_DIR/$BINARY_NAME"
    }
  fi
  
  chmod +x "$INSTALL_DIR/$BINARY_NAME" 2>/dev/null || true
}

setup_path() {
  # Skip on Windows - user needs to add to PATH manually
  if [[ "$PLATFORM" == "windows" ]]; then
    return 0
  fi
  
  # Check if already in PATH
  if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
    return 0
  fi
  
  # Determine shell config file
  local shell_rc=""
  case "${SHELL:-}" in
    */zsh) shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *) shell_rc="$HOME/.profile" ;;
  esac
  
  # Check if already in config
  if [[ -f "$shell_rc" ]] && grep -qF "$INSTALL_DIR" "$shell_rc" 2>/dev/null; then
    return 0
  fi
  
  step "Adding $INSTALL_DIR to PATH in $shell_rc"
  echo "" >> "$shell_rc"
  echo "# Added by JSN installer" >> "$shell_rc"
  echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_rc"
  info "Added to $shell_rc"
  warn "Run: source $shell_rc"
}

verify_install() {
  local installed_version
  if installed_version=$("$INSTALL_DIR/$BINARY_NAME" --version 2>/dev/null); then
    info "${installed_version} installed"
    return 0
  fi
  error "Installation failed - JSN not working"
}

main() {
  step "Installing JSN..."
  
  detect_platform
  
  if [[ -n "$VERSION" ]]; then
    # Strip leading 'v' if present
    VERSION="${VERSION#v}"
    if [[ ! $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      error "Invalid version format: $VERSION (expected: 0.4.1)"
    fi
  else
    VERSION=$(get_latest_version)
  fi
  
  setup_install_dir
  download_and_install "$VERSION"
  setup_path
  verify_install "$PLATFORM"
  
  echo ""
  info "JSN installed successfully!"
  echo ""
  echo "  Run 'jsn' to get started (setup will run automatically on first use)"
  echo ""
  
  if [[ "$PLATFORM" == "windows" ]]; then
    warn "Windows users: Add $INSTALL_DIR to your PATH manually:"
    echo "  setx PATH \"%PATH%;$INSTALL_DIR\""
    echo ""
  fi
}

main "$@"
