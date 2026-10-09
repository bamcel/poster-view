#!/bin/sh
# Prepare application state, then drop privileges. Never change media ownership.
set -e

PUID=${PUID:-10001}
PGID=${PGID:-10001}
UMASK=${UMASK:-002}
export PUID PGID UMASK
for identity in "$PUID" "$PGID"; do
    case "$identity" in
        ''|*[!0-9]*) echo "PosterView: PUID and PGID must be numeric IDs." >&2; exit 1 ;;
    esac
    if [ "${#identity}" -gt 10 ] || [ "$identity" -gt 2147483647 ]; then
        echo "PosterView: PUID and PGID must be between 0 and 2147483647." >&2
        exit 1
    fi
done
case "$UMASK" in
    *[!0-7]*) echo "PosterView: UMASK must contain only octal digits (for example 002)." >&2; exit 1 ;;
esac
case "$UMASK" in
    ???|0???) umask "$UMASK" ;;
    *) echo "PosterView: UMASK must be three octal digits, optionally prefixed with 0." >&2; exit 1 ;;
esac

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
configured_media_dir=${POSTERVIEW_MEDIA_DIR:-}
{
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
        detected_media_dir=$media_mount
    done <<EOF
$media_mounts
EOF
    if [ "$media_count" -eq 1 ]; then
        POSTERVIEW_MEDIA_DIR=$detected_media_dir
        if [ -n "$configured_media_dir" ] && [ "$configured_media_dir" != "$detected_media_dir" ]; then
            echo "PosterView: using detected media mount $detected_media_dir instead of configured $configured_media_dir."
        fi
    elif [ "$media_count" -gt 1 ] && [ -z "$configured_media_dir" ]; then
        echo "PosterView: multiple media mounts found. Use one media mount, or explicitly set POSTERVIEW_MEDIA_DIR to the desired root." >&2
        exit 1
    else
        POSTERVIEW_MEDIA_DIR=${configured_media_dir:-/media}
    fi
}
export POSTERVIEW_MEDIA_DIR

mkdir -p "$POSTERVIEW_DATA_DIR"
# Exclude standard and custom media roots, including on legacy installs.
find "$POSTERVIEW_DATA_DIR" -xdev \( -path /data/media -o -path "$POSTERVIEW_MEDIA_DIR" \) -prune -o -exec chown -h "$PUID:$PGID" {} +

echo "PosterView: starting with UID=$PUID GID=$PGID UMASK=$UMASK"
exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
