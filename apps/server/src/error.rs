use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use posterview_contracts::ApiErrorResponse;
use posterview_runtime::RuntimeError;

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

    pub(crate) fn history_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "History entry not found".to_owned(),
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
