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

impl From<RuntimeError> for HttpError {
    fn from(error: RuntimeError) -> Self {
        tracing::error!(%error, "request failed");
        if matches!(
            error,
            RuntimeError::Store(posterview_infra_sqlite::StoreError::CredentialDecryption)
        ) {
            return Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: error.to_string(),
            };
        }
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
