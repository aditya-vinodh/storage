#!/bin/sh
# Installs the storage CLI, signs you in and adds the MCP server to your agents.
#   curl -fsSL https://storage.adityaone.com/install.sh | sh
# Needs Node 22 or newer. Installs to ~/.local/share/storage and ~/.local/bin; no sudo.
set -eu

BASE_URL="https://storage.adityaone.com"
SHARE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/storage"
BIN_DIR="$HOME/.local/bin"

fail() {
  echo "error: $1" >&2
  exit 1
}

NODE=$(command -v node || true)
[ -n "$NODE" ] || fail "Node.js 22 or newer is required. Install it from https://nodejs.org and run this again."
MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || fail "Node.js 22 or newer is required; found $("$NODE" --version)."

mkdir -p "$SHARE_DIR" "$BIN_DIR"
echo "Downloading the CLI…"
curl -fsSL "$BASE_URL/cli/storage.mjs" -o "$SHARE_DIR/storage.mjs.tmp"
mv "$SHARE_DIR/storage.mjs.tmp" "$SHARE_DIR/storage.mjs"

# Agents often start without your shell's PATH, so the wrapper names this Node directly.
cat > "$BIN_DIR/storage" <<WRAPPER
#!/bin/sh
exec "$NODE" "$SHARE_DIR/storage.mjs" "\$@"
WRAPPER
chmod +x "$BIN_DIR/storage"
echo "Installed $BIN_DIR/storage"

PATH="$BIN_DIR:$PATH" "$BIN_DIR/storage" setup

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to your PATH to run storage from your shell, for example:"
     echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile" ;;
esac
