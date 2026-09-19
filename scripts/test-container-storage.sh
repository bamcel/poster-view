#!/bin/sh
# Run inside a disposable built image (no user volumes):
# docker run --rm --entrypoint sh -v "$PWD/scripts/test-container-storage.sh:/test.sh:ro" posterview:latest /test.sh fresh
# Scenarios: fresh, legacy, both, custom, media, new-media, legacy-media,
# runtime, empty-legacy (mount an empty /data volume).
set -eu
scenario=${1:-fresh}
unset POSTERVIEW_DATA_DIR
unset POSTERVIEW_MEDIA_DIR
if [ "$scenario" = runtime ]; then
    export POSTERVIEW_AUTH_ENABLED=false POSTERVIEW_BIND=127.0.0.1:7979
    start() {
        /entrypoint.sh /app/posterview-server > /tmp/server.log 2>&1 &
        server_pid=$!
        trap 'kill "$server_pid" 2>/dev/null || true' EXIT
        attempt=0
        until curl -fsS http://127.0.0.1:7979/api/health >/dev/null 2>&1; do
            attempt=$((attempt + 1))
            if [ "$attempt" -ge 50 ]; then cat /tmp/server.log; exit 1; fi
            sleep 0.1
        done
    }
    stop() { kill "$server_pid"; wait "$server_pid"; trap - EXIT; }
    export POSTERVIEW_DATA_DIR=/data
    start
    curl -fsS -H 'Content-Type: application/json' -d '{"name":"Preserved server","type":"emby","base_url":"http://127.0.0.1:9","token":"fixture-token","is_default":true}' http://127.0.0.1:7979/api/servers >/dev/null
    original_key=$(cat /data/secret.key)
    stop
    unset POSTERVIEW_DATA_DIR
    start
    curl -fsS http://127.0.0.1:7979/api/status | grep -q '"data_dir":"/data"'
    curl -fsS http://127.0.0.1:7979/api/servers | grep -q 'Preserved server'
    test "$(cat /data/secret.key)" = "$original_key"
    stop
    # Disposable fixture only: simulate the same appdata becoming visible at /config.
    cp -a /data/. /config/
    start
    curl -fsS http://127.0.0.1:7979/api/status | grep -q '"data_dir":"/config"'
    curl -fsS http://127.0.0.1:7979/api/servers | grep -q 'Preserved server'
    test "$(cat /config/secret.key)" = "$original_key"
    stop
    echo 'PASS: real server state and encryption key survive legacy restart and /config switch'
    exit 0
fi
expected=/config
case "$scenario" in
    fresh) ;;
    new-media) mkdir -p /media /data/media ;;
    legacy-media) mkdir -p /data/media ;;
    empty-legacy) expected=/data; mountpoint -q /data ;;
    legacy|media)
        mkdir -p /data
        printf 'saved-state' > /data/posterview.db
        printf 'saved-key' > /data/secret.key
        expected=/data
        ;;
    both)
        mkdir -p /data /config
        printf 'legacy' > /data/posterview.db
        printf 'current' > /config/posterview.db
        ;;
    custom)
        export POSTERVIEW_DATA_DIR=/custom
        expected=/custom
        ;;
    *) exit 2 ;;
esac
if [ "$scenario" = media ]; then
    mkdir -p /data/media /data/custom-media
    touch /data/media/sample.nfo /data/custom-media/sample.nfo
    chown -R 1234:1234 /data/media /data/custom-media
    export POSTERVIEW_MEDIA_DIR=/data/custom-media
fi
export expected scenario
/entrypoint.sh sh -ec '
    test "$POSTERVIEW_DATA_DIR" = "$expected"
    test "$(id -u)" = 10001
    test -w "$expected"
    if [ "$scenario" = fresh ] || [ "$scenario" = new-media ]; then
        test "$POSTERVIEW_MEDIA_DIR" = /media
    fi
    if [ "$scenario" = legacy-media ]; then
        test "$POSTERVIEW_MEDIA_DIR" = /media
    fi
    if [ "$scenario" = legacy ] || [ "$scenario" = media ]; then
        test "$(cat /data/posterview.db)" = saved-state
        test "$(cat /data/secret.key)" = saved-key
        test ! -f /config/posterview.db
    fi
    if [ "$scenario" = both ]; then
        test "$(cat /config/posterview.db)" = current
        test "$(cat /data/posterview.db)" = legacy
    fi
    if [ "$scenario" = media ]; then
        test "$POSTERVIEW_MEDIA_DIR" = /data/custom-media
        test "$(stat -c %u /data/media/sample.nfo)" = 1234
        test "$(stat -c %u /data/custom-media/sample.nfo)" = 1234
    fi
    echo "PASS: $scenario -> $POSTERVIEW_DATA_DIR"
'
