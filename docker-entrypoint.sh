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
if [ -z "${POSTERVIEW_MEDIA_DIR:-}" ]; then
    # Discover directory mounts without granting access to the container filesystem.
    # /config and legacy application storage must never become media roots.
    media_mounts=$(awk '{print $5}' /proc/self/mountinfo | sort -u)
    media_count=0
    while IFS= read -r media_mount; do
        media_mount=$(printf '%b' "$media_mount")
        case "$media_mount" in
            /|/config|/config/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/etc|/etc/*|/usr|/usr/*|/app|/app/*) continue ;;
        esac
        case "$media_mount/" in "$POSTERVIEW_DATA_DIR/"*) continue ;; esac
        [ -d "$media_mount" ] || continue
        media_count=$((media_count + 1))
        POSTERVIEW_MEDIA_DIR=$media_mount
    done <<EOF
$media_mounts
EOF
    if [ "$media_count" -gt 1 ]; then
        echo "PosterView: multiple media mounts found. Mount media beneath one common container directory, or explicitly set POSTERVIEW_MEDIA_DIR to the desired root." >&2
        exit 1
    fi
    POSTERVIEW_MEDIA_DIR=${POSTERVIEW_MEDIA_DIR:-/media}
fi
export POSTERVIEW_MEDIA_DIR

mkdir -p "$POSTERVIEW_DATA_DIR"
# Exclude standard and custom media roots, including on legacy installs.
find "$POSTERVIEW_DATA_DIR" -xdev \( -path /data/media -o -path "$POSTERVIEW_MEDIA_DIR" \) -prune -o -exec chown -h posterview:posterview {} +

exec setpriv --reuid=10001 --regid=10001 --init-groups "$@"
