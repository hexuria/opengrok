# One-command workflows for the 0.27 app (https://Grok-0.27.app).
# `just` with no target lists them.
#
# Official /Applications/Grok Bot.app (bundle id com.anysphere.sand)
# is never touched. Every recipe that writes an app writes only
# /Applications/Open Grok.app (bot.opengrok.app).
# /Applications/Grok Bot 0.18 Reconstructed.app is left alone.

default:
    @just --list

dist_app := "dist/Grok-0.27.app"
install_app := "/Applications/Grok-0.27.app"
settings_json := home_dir() / "Library/Application Support/Grok-0.27/sand-data/settings.json"

# --- the gate ---
# Cache the 0.18 runtime pieces the packager needs.
bootstrap:
    npm run bootstrap

# Local ConnectRPC mock of GrokBotService (127.0.0.1:8787, SAND_MOCK_PORT to override).
# Point a packaged app at it with SAND_BACKEND_URL=http://127.0.0.1:8787
# then use the existing AuthServicePort.devLogin hook.
mock-server:
    npm run mock-server

# Unit tests only.
test:
    npm test

# Typecheck + source typecheck + tests.
check:
    npm run check

# --- 0.27 app ---
# Bootstrap, then package into dist/. Asserts the app exists and prints mtime.
package: bootstrap
    npm run package
    @test -d "{{dist_app}}" || { echo "missing {{dist_app}}"; exit 1; }
    @stat -f "dist mtime: %Sm" "{{dist_app}}"

# Overlay dist onto /Applications/Grok-0.27.app only.
# Close Grok-0.27.app first if it is open, or ditto can fail mid-copy.
# Official Grok Bot.app and Grok Bot 0.18 Reconstructed.app are never written.
install:
    @test -d "{{dist_app}}" || { echo "missing {{dist_app}} -- run just package first"; exit 1; }
    ditto "{{dist_app}}" "{{install_app}}"
    xattr -cr "{{install_app}}"
    @stat -f "installed mtime: %Sm" "{{install_app}}"

# Open Grok-0.27 with its own profile. Plain open hands off to official Grok Bot
# because both apps use CFBundleName "Grok Bot".
run:
    open -n -a "{{install_app}}" --args --user-data-dir="{{home_dir() / "Library/Application Support/Grok-0.27"}}"

# Remove only the dist Grok-0.27 app. Leaves /Applications alone.
clean:
    rm -rf "{{dist_app}}"

# Package, install, then launch Grok-0.27.
ship: package install run

# Print Grok-0.27 settings.json (its own user-data, not official Grok Bot).
settings:
    @cat "{{settings_json}}"
