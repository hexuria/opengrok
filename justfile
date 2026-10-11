# Rebuild, sign and relaunch NativeChat (default OpenGrok :1447).
#
# The signing step is not optional busywork: an unsigned build is a new program to the
# keychain every time, and the first saved password it reads puts the OS password sheet up
# whatever Touch ID already said. One identity, one permission, no sheet.
run port="1447":
    #!/usr/bin/env bash
    set -euo pipefail
    pkill -x nativechat 2>/dev/null || true
    export OPENGROK_BASE_URL="${OPENGROK_BASE_URL:-http://127.0.0.1:{{port}}}"
    export GPUI_AGENT="${GPUI_AGENT:-1}"
    export GPUI_AGENT_TOKEN="${GPUI_AGENT_TOKEN:-dev-secret}"
    cargo build -p nativechat --features agent
    scripts/sign-dev.sh target/debug/nativechat
    exec target/debug/nativechat

# Sign a build without running it.
sign bin="target/debug/nativechat":
    scripts/sign-dev.sh {{bin}}
