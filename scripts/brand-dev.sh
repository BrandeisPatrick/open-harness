#!/bin/zsh
# Optional: brand the development Electron binary so `npm start` shows "Open Harness"
# (name + icon) in the macOS menu bar, Dock and app switcher instead of "Electron".
#
# This edits node_modules/electron/dist/Electron.app in place and re-signs it ad-hoc.
# Re-run after `npm install` replaces node_modules/electron. Packaged builds
# (`npm run package` / `npm run dist`) do not need this.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=node_modules/electron/dist/Electron.app
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || { echo "Electron not installed (run npm install first)"; exit 1; }
[ -f build/icon.icns ] || { echo "build/icon.icns missing (see README: App icon)"; exit 1; }
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST")" = "Open Harness" ] && cmp -s build/icon.icns "$APP/Contents/Resources/electron.icns"; then
  echo "dev Electron already branded as Open Harness"; exit 0
fi
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Open Harness' -c 'Set :CFBundleDisplayName Open Harness' "$PLIST"
cp build/icon.icns "$APP/Contents/Resources/electron.icns"
# The dev bundle is ad-hoc signed; editing it invalidates the seal, so re-sign ad-hoc (keeps entitlements).
codesign --force --deep --sign - --preserve-metadata=entitlements "$APP" 2>/dev/null
echo "dev Electron branded as Open Harness"
