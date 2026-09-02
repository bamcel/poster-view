# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1.88-bookworm AS rust-build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY apps/ apps/
RUN cargo build --locked --release --package posterview-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl util-linux passwd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-build /src/target/release/posterview-server /app/posterview-server
COPY --from=frontend /src/frontend/dist/ /app/frontend/
COPY docker-entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin posterview \
    && mkdir -p /data \
    && chown -R posterview:posterview /data /app \
    && chmod +x /entrypoint.sh

ENV POSTERVIEW_BIND=0.0.0.0:7979 \
    POSTERVIEW_DATA_DIR=/data \
    POSTERVIEW_UI_DIR=/app/frontend \
    RUST_LOG=posterview_server=info,tower_http=info
VOLUME ["/data"]
EXPOSE 7979
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:7979/api/health || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/app/posterview-server"]
