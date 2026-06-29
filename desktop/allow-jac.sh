#!/bin/bash
# Run this once to allow JAC to launch on macOS 15
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$SCRIPT_DIR/dist/mac-arm64/JAC.app"
if [ ! -d "$APP" ]; then
  echo "ERROR: $APP not found. Run 'npm run build && npx electron-builder --dir' first."
  exit 1
fi
echo "Adding JAC.app to macOS Gatekeeper allowlist..."
sudo spctl --add "$APP"
echo ""
echo "Done! You can now launch JAC:"
echo "  open \"$APP\""
echo "or double-click dist/mac-arm64/JAC.app in Finder"
