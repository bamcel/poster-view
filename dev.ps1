# PosterView dev launcher (Windows). Starts the Rust/Axum backend (:7979) and the
# Vite dev server (:5173) in separate windows. Open http://localhost:5173.
#
#   ./dev.ps1
#
# Requires Rust/Cargo and the frontend dependencies (see README).

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$frontend = Join-Path $root "frontend"

Write-Host "Starting Rust backend on http://localhost:7979 ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command",
  "cd '$root'; cargo run --package posterview-server"

Write-Host "Starting frontend on http://localhost:5173 ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$frontend'; npm run dev"

Write-Host "`nPosterView is starting. Open http://localhost:5173" -ForegroundColor Cyan
