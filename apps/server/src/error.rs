use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use posterview_contracts::ApiErrorResponse;
use posterview_runtime::RuntimeError;

#[derive(Debug)]
pub(crate) struct HttpError {
    pub(crate) status: StatusCode,
    pub(crate) detail: String,
}

impl HttpError {
    pub(crate) fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "Server not found".to_owned(),
        }
    }

    pub(crate) fn bad_request(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            detail: detail.into(),
        }
    }

    pub(crate) fn unauthorized(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: detail.into(),
        }
    }

    pub(crate) fn bad_gateway(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            detail: detail.into(),
        }
    }
}

impl From<posterview_infra_sqlite::StoreError> for HttpError {
    fn from(error: posterview_infra_sqlite::StoreError) -> Self {
        use posterview_infra_sqlite::StoreError;
        let retryable = matches!(&error, StoreError::WriteUnavailable)
            || matches!(&error, StoreError::Database(rusqlite::Error::SqliteFailure(code, _)) if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked));
        if retryable {
            tracing::warn!("Database write admission or SQLite lock timed out");
            return Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                detail: "Database writes are busy. Please retry shortly.".into(),
            };
        }
        match error {
            StoreError::Validation(detail) => Self::bad_request(detail),
            StoreError::RevisionConflict => Self {
                status: StatusCode::CONFLICT,
                detail: "Library changed since it was opened. Reload before saving.".into(),
            },
            StoreError::CredentialDecryption => Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: error.to_string(),
            },
            _ => {
                tracing::error!(%error, "Database operation failed");
                Self {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    detail: "Database operation failed. Please retry.".into(),
                }
            }
        }
    }
}

impl From<RuntimeError> for HttpError {
    fn from(error: RuntimeError) -> Self {
        if let RuntimeError::Store(error) = error {
            return Self::from(error);
        }
        tracing::error!(%error, "request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_owned(),
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorResponse {
                detail: self.detail,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_admission_and_sqlite_locks_are_retryable_without_leaking_database_details() {
        use posterview_infra_sqlite::StoreError;
        let busy = StoreError::Database(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            Some("private/database/path".into()),
        ));
        for error in [StoreError::WriteUnavailable, busy] {
            let response = HttpError::from(error);
            assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
            assert!(!response.detail.contains("private"));
            assert!(response.detail.contains("retry"));
        }
        assert_eq!(
            HttpError::from(StoreError::RevisionConflict).status,
            StatusCode::CONFLICT
        );
        assert_eq!(
            HttpError::from(StoreError::Validation("Invalid setting".into())).status,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn credential_errors_include_recovery_guidance_without_exposing_other_errors() {
        let error = HttpError::from(RuntimeError::Store(
            posterview_infra_sqlite::StoreError::CredentialDecryption,
        ));
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(error.detail.contains("reconfigure the credential"));
        let unrelated = HttpError::from(RuntimeError::Artwork("private-token".into()));
        assert_eq!(unrelated.detail, "Internal server error");
    }
}
