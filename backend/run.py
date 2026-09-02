"""Run the PosterView backend.

    python run.py            # serves on http://0.0.0.0:7979
    POSTERVIEW_PORT=9000 python run.py

In development, run the Vite dev server separately (``npm run dev`` in
``frontend/``); it proxies ``/api`` to this process.
"""

from __future__ import annotations

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.environ.get("POSTERVIEW_HOST", "0.0.0.0"),
        port=int(os.environ.get("POSTERVIEW_PORT", "7979")),
        reload=bool(os.environ.get("POSTERVIEW_RELOAD")),
    )
