"""Rebuild Rust changes with short polling; retain the last working server on errors."""
import os
from pathlib import Path
import signal
import subprocess
import time


def fingerprint():
    paths = [Path("Cargo.toml"), Path("Cargo.lock")]
    for root in (Path("apps"), Path("crates")):
        paths.extend(p for p in root.rglob("*") if p.is_file())
    return tuple(sorted((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths))


def main():
    running = True
    server = None
    build = None

    def stop(_signum, _frame):
        nonlocal running
        running = False

    def terminate(process):
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    previous = None
    try:
        while running:
            current = fingerprint()
            if build is None and current != previous:
                previous = current
                print("Building backend changes…", flush=True)
                build = subprocess.Popen(
                    ["cargo", "build", "--locked", "--package", "posterview-server"],
                    start_new_session=True,
                )
            if build is not None and build.poll() is not None:
                if build.returncode == 0:
                    terminate(server)
                    server = subprocess.Popen(
                        [str(Path(os.environ.get("CARGO_TARGET_DIR", "target")) / "debug/posterview-server")],
                        start_new_session=True,
                        user=int(os.environ.get("PUID", "10001")),
                        group=int(os.environ.get("PGID", "100")),
                        umask=0o002,
                    )
                else:
                    print("Build failed; fix the source to retry. Previous server retained.", flush=True)
                build = None
            time.sleep(1)
    finally:
        terminate(build)
        terminate(server)


if __name__ == "__main__":
    main()
