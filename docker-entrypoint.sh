#!/bin/sh
# Prepare application state, then drop privileges. Never change media ownership.
set -e

# Explicit directory overrides always win. Otherwise prefer initialized /config,
# then a legacy /data mount/state, then the new /config default. Do not move data.
if [ -z "${POSTERVIEW_DATA_DIR:-}" ]; then
    if [ -f /config/posterview.db ] || [ -f /config/secret.key ]; then
        POSTERVIEW_DATA_DIR=/config
    elif [ -f /data/posterview.db ] || [ -f /data/secret.key ] || mountpoint -q /data; then
        POSTERVIEW_DATA_DIR=/data
        echo "PosterView: using legacy /data configuration. To adopt /config, remap the same appdata host folder or named volume."
    else
        POSTERVIEW_DATA_DIR=/config
    fi
fi
export POSTERVIEW_DATA_DIR
POSTERVIEW_MEDIA_DIR=${POSTERVIEW_MEDIA_DIR:-/media}
export POSTERVIEW_MEDIA_DIR

mkdir -p "$POSTERVIEW_DATA_DIR"
# Exclude standard and custom media roots, including on legacy installs.
find "$POSTERVIEW_DATA_DIR" -xdev \( -path /data/media -o -path "$POSTERVIEW_MEDIA_DIR" \) -prune -o -exec chown -h posterview:posterview {} +

exec setpriv --reuid=10001 --regid=10001 --init-groups "$@"
