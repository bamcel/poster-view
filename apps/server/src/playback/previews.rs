//! Optional timeline previews have their own small budget, independent of playback jobs.
use super::*;
use axum::extract::Query;
use std::hash::{Hash, Hasher};

static PREVIEW_WORKER: Semaphore = Semaphore::const_new(1);
const CACHE_BYTES: u64 = 32 * 1024 * 1024;
const CACHE_FILES: usize = 256;
const MAX_IMAGE_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
pub(super) struct PreviewQuery {
    seconds: f64,
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
            (meta.is_file() && entry.path().extension().is_some_and(|ext| ext == "jpg"))
                .then(|| (entry.path(), meta.len(), meta.modified().ok()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|entry| entry.2);
    let mut bytes = files.iter().map(|entry| entry.1).sum::<u64>();
    let mut count = files.len();
    for (path, size, _) in files {
        if count < CACHE_FILES && bytes + MAX_IMAGE_BYTES <= CACHE_BYTES {
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
    let source = source(&state, library, item).await?;
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
            Query(PreviewQuery { seconds: 0.0 }),
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
