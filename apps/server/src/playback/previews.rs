//! Optional timeline previews have their own small budget, independent of playback jobs.
use super::*;
use axum::extract::Query;
use std::hash::{Hash, Hasher};

static PREVIEW_WORKER: Semaphore = Semaphore::const_new(1);
const CACHE_BYTES: u64 = 128 * 1024 * 1024;
const CACHE_FILES: usize = 512;
const MAX_IMAGE_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct PreviewQuery {
    seconds: f64,
    version_id: Option<String>,
}

fn bucket(seconds: f64) -> Result<u64, HttpError> {
    if !seconds.is_finite() || !(0.0..=MAX_PLAYBACK_SECONDS).contains(&seconds) {
        return Err(bad("Invalid preview position."));
    }
    Ok((seconds / 10.0).floor() as u64 * 10)
}

fn cache_name(path: &FsPath, fingerprint: (u64, u128), seconds: u64) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (path, fingerprint, seconds).hash(&mut hash);
    format!("{:016x}.jpg", hash.finish())
}

fn trim_cache(root: &FsPath) {
    let mut files = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            (meta.is_file()
                && (entry.path().extension().is_some_and(|ext| ext == "jpg")
                    || entry.file_name().to_string_lossy().ends_with(".jpg.json")))
            .then(|| (entry.path(), meta.len(), meta.modified().ok()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.2);
    let mut bytes = files.iter().map(|entry| entry.1).sum::<u64>();
    let mut count = files.len();
    for (path, size, _) in files {
        if count < CACHE_FILES && bytes + MAX_SHEET_BYTES <= CACHE_BYTES {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            count -= 1;
            bytes = bytes.saturating_sub(size);
        }
    }
}

struct PartialImage(PathBuf);
impl Drop for PartialImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn generate(path: &FsPath, output: &FsPath, seconds: u64) -> Result<(), HttpError> {
    let mut cmd = command("ffmpeg");
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-ss",
    ])
    .arg(seconds.to_string())
    .args([
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        VIDEO_DEMUXERS,
        "-i",
    ])
    .arg(path)
    .args([
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-frames:v",
        "1",
        "-vf",
        "scale=240:-2",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-q:v",
        "5",
        "-f",
        "image2",
        "-y",
    ])
    .arg(output);
    run(&mut cmd, Duration::from_secs(8), "Timeline preview").await
}

pub(super) async fn preview(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Query(query): Query<PreviewQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let user = state.auth.request_user(request.headers())?;
    crate::access::require_item(&state, &user, &library, &item)?;
    let seconds = bucket(query.seconds)?;
    let source = source_version(&state, library, item, query.version_id).await?;
    let root = state.playback.root.join("previews");
    let output = root.join(cache_name(&source.path, source.fingerprint, seconds));
    if !output.is_file() {
        // Hover traffic never waits behind or consumes a streaming/probing slot.
        let _permit = PREVIEW_WORKER.try_acquire().map_err(|_| HttpError {
            status: StatusCode::TOO_MANY_REQUESTS,
            detail: "Timeline preview is busy. Try again shortly.".into(),
        })?;
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|_| failure("Preview cache is not writable."))?;
        trim_cache(&root);
        let partial = PartialImage(root.join(format!("{}.jpg", uuid::Uuid::new_v4())));
        generate(&source.path, &partial.0, seconds).await?;
        let size = tokio::fs::metadata(&partial.0)
            .await
            .map_or(0, |meta| meta.len());
        if size == 0 || size > MAX_IMAGE_BYTES || stamp(&source.path)? != source.fingerprint {
            return Err(failure("Timeline preview is unavailable."));
        }
        tokio::fs::rename(&partial.0, &output)
            .await
            .map_err(|_| failure("Unable to save timeline preview."))?;
    }
    serve(output, "image/jpeg", request).await
}

// One bounded background task globally, independent of interactive preview and playback workers.
static STORYBOARD_WORKER: Semaphore = Semaphore::const_new(1);
static STORYBOARD_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const SHEET_FRAMES: usize = 30;
const MAX_SHEETS: usize = 72; // Six hours, ten-second samples.
const MAX_SHEET_BYTES: u64 = 2 * 1024 * 1024;

struct BackgroundTask;
impl Drop for BackgroundTask {
    fn drop(&mut self) {
        STORYBOARD_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
    }
}

fn sheet_name(source: &Source, index: usize) -> String {
    format!(
        "sheet-v1-{}-{index}.jpg",
        cache_name(&source.path, source.fingerprint, 0).trim_end_matches(".jpg")
    )
}
fn descriptor_path(root: &FsPath, source: &Source) -> PathBuf {
    root.join(format!("{}.json", sheet_name(source, 0)))
}
fn sheet_count(seconds: f64) -> usize {
    ((seconds / 300.0).ceil() as usize).clamp(1, MAX_SHEETS)
}
fn ready_sheet(root: &FsPath, source: &Source, index: usize) -> bool {
    std::fs::metadata(root.join(sheet_name(source, index)))
        .is_ok_and(|meta| meta.len() > 0 && meta.len() <= MAX_SHEET_BYTES)
}
fn descriptor(root: &FsPath, source: &Source) -> Option<usize> {
    let bytes = std::fs::read(descriptor_path(root, source)).ok()?;
    if bytes.len() > 32 {
        return None;
    }
    let count: usize = serde_json::from_slice(&bytes).ok()?;
    (count > 0 && count <= MAX_SHEETS).then_some(count)
}

async fn generate_sheet(path: &FsPath, output: &FsPath, index: usize) -> Result<(), HttpError> {
    let mut cmd = command("ffmpeg");
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
        "-skip_frame", "nokey", "-ss"])
        .arg((index * 300).to_string())
        .args(["-protocol_whitelist", "file", "-format_whitelist", VIDEO_DEMUXERS, "-i"])
        .arg(path)
        .args(["-t", "300", "-map", "0:v:0", "-an", "-sn", "-dn", "-vf",
            "fps=1/10:start_time=0:round=up,scale=240:136:force_original_aspect_ratio=decrease,pad=240:136:(ow-iw)/2:(oh-ih)/2,tile=6x5",
            "-frames:v", "1", "-threads", "1", "-filter_threads", "1", "-q:v", "5", "-f", "image2", "-y"])
        .arg(output);
    // Keyframe-only decoding keeps this optional work cheap; previews are approximate.
    run(&mut cmd, Duration::from_secs(45), "Timeline storyboard").await
}

async fn build_storyboard(root: PathBuf, source: Source) -> Result<(), HttpError> {
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| failure("Preview cache is not writable."))?;
    let count = if let Some(count) = descriptor(&root, &source) {
        count
    } else {
        let _permit = STORYBOARD_WORKER
            .try_acquire()
            .map_err(|_| failure("Preview worker is busy."))?;
        let temp = tempfile::NamedTempFile::new()
            .map_err(|_| failure("Unable to inspect preview duration."))?;
        let mut cmd = command("ffprobe");
        cmd.args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            VIDEO_DEMUXERS,
            "-show_entries",
            "format=duration",
            "-of",
            "json",
        ])
        .arg(&source.path)
        .stdout(
            temp.reopen()
                .map_err(|_| failure("Unable to inspect preview duration."))?,
        );
        run(&mut cmd, Duration::from_secs(15), "Preview duration").await?;
        if std::fs::metadata(temp.path()).map_or(true, |meta| meta.len() > 4096) {
            return Err(failure("Invalid preview duration."));
        }
        let probe: Value = serde_json::from_slice(
            &std::fs::read(temp.path()).map_err(|_| failure("Unable to read preview duration."))?,
        )
        .map_err(|_| failure("Invalid preview duration."))?;
        let seconds = duration(&probe);
        if !seconds.is_finite() || seconds <= 0.0 {
            return Err(failure("Invalid preview duration."));
        }
        let count = sheet_count(seconds);
        tokio::fs::write(descriptor_path(&root, &source), count.to_string())
            .await
            .map_err(|_| failure("Unable to save preview duration."))?;
        count
    };
    for index in 0..count {
        if ready_sheet(&root, &source, index) {
            continue;
        }
        // Yield between sheets rather than continuously scheduling background FFmpeg work.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let permit = STORYBOARD_WORKER
            .acquire()
            .await
            .map_err(|_| failure("Preview worker is unavailable."))?;
        if stamp(&source.path)? != source.fingerprint {
            return Ok(());
        }
        trim_cache(&root);
        let partial = PartialImage(root.join(format!("{}.jpg", uuid::Uuid::new_v4())));
        generate_sheet(&source.path, &partial.0, index).await?;
        let size = std::fs::metadata(&partial.0).map_or(0, |meta| meta.len());
        if size == 0 || size > MAX_SHEET_BYTES || stamp(&source.path)? != source.fingerprint {
            return Err(failure("Timeline storyboard is unavailable."));
        }
        tokio::fs::rename(&partial.0, root.join(sheet_name(&source, index)))
            .await
            .map_err(|_| failure("Unable to save timeline storyboard."))?;
        drop(permit);
    }
    Ok(())
}

pub(super) async fn storyboard(
    State(state): State<AppState>,
    Path((library, item)): Path<(String, String)>,
    Query(query): Query<VersionQuery>,
    request: Request,
) -> Result<Json<Value>, HttpError> {
    let user = state.auth.request_user(request.headers())?;
    crate::access::require_item(&state, &user, &library, &item)?;
    let source = source_version(&state, library.clone(), item.clone(), query.version_id).await?;
    let root = state.playback.root.join("previews");
    let count = descriptor(&root, &source);
    let sheets = (0..count.unwrap_or(0)).filter(|&index| ready_sheet(&root, &source, index))
        .map(|index| json!({"index": index, "url": format!("/api/playback/native/{library}/{item}/preview-sheet/{index}{}", version_suffix(&source.version_id))}))
        .collect::<Vec<_>>();
    let complete = count.is_some_and(|count| sheets.len() == count);
    if !complete
        && STORYBOARD_ACTIVE
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .is_ok()
    {
        let active = BackgroundTask;
        tokio::spawn(async move {
            let _active = active;
            if build_storyboard(root, source).await.is_err() {
                // Bounded retry cooldown, including failures and unsupported sources.
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }
    Ok(Json(
        json!({"interval":10,"width":240,"height":136,"columns":6,
        "frames_per_sheet":SHEET_FRAMES,"sheets":sheets,"complete":complete}),
    ))
}

pub(super) async fn sheet(
    State(state): State<AppState>,
    Path((library, item, index)): Path<(String, String, usize)>,
    Query(query): Query<VersionQuery>,
    request: Request,
) -> Result<Response, HttpError> {
    let user = state.auth.request_user(request.headers())?;
    crate::access::require_item(&state, &user, &library, &item)?;
    if index >= MAX_SHEETS {
        return Err(HttpError::not_found());
    }
    let source = source_version(&state, library, item, query.version_id).await?;
    let root = state.playback.root.join("previews");
    if !ready_sheet(&root, &source, index) {
        return Err(HttpError::not_found());
    }
    serve(root.join(sheet_name(&source, index)), "image/jpeg", request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unauthenticated_preview_is_denied_before_media_resolution() {
        let root = tempfile::tempdir().unwrap();
        let mut state = crate::test_support::state(root.path());
        state.auth = crate::AuthState::for_tests("preview-test-token");
        let request = Request::builder()
            .header(header::COOKIE, "posterview_session=invalid")
            .body(axum::body::Body::empty())
            .unwrap();
        let error = preview(
            State(state),
            Path(("missing-library".into(), "missing-item".into())),
            Query(PreviewQuery {
                seconds: 0.0,
                version_id: None,
            }),
            request,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ffmpeg_generates_a_small_jpeg_without_playback_or_probe_slots() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("fixture.mkv");
        let output = root.path().join("preview.jpg");
        let mut fixture = command("ffmpeg");
        fixture
            .args([
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=640x360:d=1",
                "-c:v",
                "mpeg4",
                "-y",
            ])
            .arg(&input);
        run(&mut fixture, Duration::from_secs(15), "Preview fixture")
            .await
            .unwrap();
        generate(&input, &output, 0).await.unwrap();
        let bytes = std::fs::read(output).unwrap();
        assert!(bytes.starts_with(&[0xff, 0xd8]));
        assert!(bytes.len() < MAX_IMAGE_BYTES as usize);
        assert!(PREVIEW_WORKER.try_acquire().is_ok());
    }

    #[tokio::test]
    async fn storyboard_routes_require_authentication_before_resolution() {
        let root = tempfile::tempdir().unwrap();
        let mut state = crate::test_support::state(root.path());
        state.auth = crate::AuthState::for_tests("preview-test-token");
        let request = || {
            Request::builder()
                .header(header::COOKIE, "posterview_session=invalid")
                .body(axum::body::Body::empty())
                .unwrap()
        };
        let error = storyboard(
            State(state.clone()),
            Path(("missing".into(), "missing".into())),
            Query(VersionQuery::default()),
            request(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        let error = sheet(
            State(state),
            Path(("missing".into(), "missing".into(), usize::MAX)),
            Query(VersionQuery::default()),
            request(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn short_video_generates_a_full_grid_sheet() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("fixture.mkv");
        let output = root.path().join("sheet.jpg");
        let mut fixture = command("ffmpeg");
        fixture
            .args([
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=640x360:d=1",
                "-c:v",
                "mpeg4",
                "-y",
            ])
            .arg(&input);
        run(&mut fixture, Duration::from_secs(15), "Storyboard fixture")
            .await
            .unwrap();
        generate_sheet(&input, &output, 0).await.unwrap();
        let bytes = std::fs::read(&output).unwrap();
        assert!(bytes.starts_with(&[0xff, 0xd8]));
        assert!(bytes.len() < MAX_SHEET_BYTES as usize);
        let temp = tempfile::NamedTempFile::new().unwrap();
        let mut probe = command("ffprobe");
        probe
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
            ])
            .arg(&output)
            .stdout(temp.reopen().unwrap());
        run(&mut probe, Duration::from_secs(10), "Inspect storyboard")
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(temp.path()).unwrap()).unwrap();
        assert_eq!(value["streams"][0]["width"], 1440);
        assert_eq!(value["streams"][0]["height"], 680);
    }

    #[test]
    fn storyboard_work_and_output_are_bounded() {
        assert_eq!(sheet_count(1.0), 1);
        assert_eq!(sheet_count(300.0), 1);
        assert_eq!(sheet_count(301.0), 2);
        assert_eq!(sheet_count(f64::MAX), MAX_SHEETS);
    }

    #[test]
    fn storyboard_admission_is_bounded_and_cleanup_releases_it() {
        use std::sync::atomic::Ordering;
        assert!(
            STORYBOARD_ACTIVE
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        );
        let active = BackgroundTask;
        assert!(
            STORYBOARD_ACTIVE
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        );
        drop(active);
        assert!(!STORYBOARD_ACTIVE.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn background_sheet_never_occupies_interactive_preview_permit() {
        let _background = STORYBOARD_WORKER.acquire().await.unwrap();
        assert!(PREVIEW_WORKER.try_acquire().is_ok());
    }

    #[test]
    fn partial_output_is_deleted_when_request_is_canceled() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("partial.jpg");
        std::fs::write(&path, b"incomplete").unwrap();
        drop(PartialImage(path.clone()));
        assert!(!path.exists());
    }

    #[test]
    fn preview_positions_are_bounded_and_quantized() {
        assert_eq!(bucket(19.9).unwrap(), 10);
        assert_eq!(bucket(0.0).unwrap(), 0);
        for invalid in [f64::NAN, f64::INFINITY, -1.0, MAX_PLAYBACK_SECONDS + 1.0] {
            assert!(bucket(invalid).is_err());
        }
    }

    #[test]
    fn changed_media_and_positions_invalidate_preview_cache() {
        let path = FsPath::new("movie.mkv");
        assert_ne!(cache_name(path, (1, 2), 0), cache_name(path, (2, 2), 0));
        assert_ne!(cache_name(path, (1, 2), 0), cache_name(path, (1, 3), 0));
        assert_ne!(cache_name(path, (1, 2), 0), cache_name(path, (1, 2), 10));
    }

    #[test]
    fn cache_budget_leaves_room_for_next_preview_and_preserves_other_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("unrelated.txt"), b"keep").unwrap();
        for index in 0..CACHE_FILES {
            std::fs::write(root.path().join(format!("{index}.jpg")), b"jpeg").unwrap();
        }
        trim_cache(root.path());
        assert!(root.path().join("unrelated.txt").exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), CACHE_FILES);
    }
}
