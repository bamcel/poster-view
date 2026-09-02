use std::sync::Arc;

use anyhow::Context;
use posterview_runtime::Runtime;
use posterview_server::{ServerConfig, router};
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "posterview_server=info,tower_http=info".into()),
        )
        .init();

    let config = ServerConfig::from_env().context("invalid server configuration")?;
    let runtime = Arc::new(Runtime::new(&config.data_dir));
    runtime
        .initialize()
        .context("could not initialize PosterView data directory")?;
    tokio::spawn(watchdog_loop(Arc::clone(&runtime)));

    let listener = TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("could not bind {}", config.bind))?;
    info!(bind = %config.bind, data_dir = %config.data_dir.display(), "PosterView Rust server starting");

    axum::serve(listener, router(runtime, config.ui_dir))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("PosterView server stopped unexpectedly")
}

async fn watchdog_loop(runtime: Arc<Runtime>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        interval.tick().await;
        if runtime.watchdog_due().unwrap_or(false) {
            let _ = runtime.run_watchdog().await;
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
