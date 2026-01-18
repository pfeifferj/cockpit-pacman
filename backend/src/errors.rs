use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Timeout,
    DatabaseLocked,
    NetworkError,
    TransactionFailed,
    ValidationError,
    Cancelled,
    NotFound,
    PermissionDenied,
    InternalError,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorCode::Timeout => write!(f, "timeout"),
            ErrorCode::DatabaseLocked => write!(f, "database_locked"),
            ErrorCode::NetworkError => write!(f, "network_error"),
            ErrorCode::TransactionFailed => write!(f, "transaction_failed"),
            ErrorCode::ValidationError => write!(f, "validation_error"),
            ErrorCode::Cancelled => write!(f, "cancelled"),
            ErrorCode::NotFound => write!(f, "not_found"),
            ErrorCode::PermissionDenied => write!(f, "permission_denied"),
            ErrorCode::InternalError => write!(f, "internal_error"),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct BackendError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl BackendError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: ErrorCode,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details: Some(details.into()),
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Timeout, message)
    }

    pub fn database_locked() -> Self {
        Self::new(
            ErrorCode::DatabaseLocked,
            "Unable to lock database. Another package manager operation is in progress.",
        )
    }

    pub fn network_error(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NetworkError, message)
    }

    pub fn transaction_failed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::TransactionFailed, message)
    }

    pub fn validation_error(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ValidationError, message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Operation was cancelled")
    }

    pub fn not_found(resource: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::NotFound,
            format!("{} not found", resource.into()),
        )
    }

    pub fn permission_denied(operation: impl Into<String>) -> Self {
        Self::new(
            ErrorCode::PermissionDenied,
            format!("Permission denied: {}", operation.into()),
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalError, message)
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for BackendError {}

impl From<anyhow::Error> for BackendError {
    fn from(err: anyhow::Error) -> Self {
        let message = err.to_string();

        if message.contains("unable to lock database")
            || message.contains("Unable to lock database")
        {
            return Self::database_locked();
        }

        if message.contains("timed out") || message.contains("timeout") {
            return Self::timeout(message);
        }

        if message.contains("connection")
            || message.contains("network")
            || message.contains("resolve host")
        {
            return Self::network_error(message);
        }

        if message.contains("transaction") || message.contains("commit") {
            return Self::transaction_failed(message);
        }

        if message.contains("cancelled") || message.contains("canceled") {
            return Self::cancelled();
        }

        if message.contains("permission denied") || message.contains("Permission denied") {
            return Self::permission_denied(message);
        }

        Self::internal(message)
    }
}

pub fn format_error_json(err: &anyhow::Error) -> String {
    let backend_err = BackendError::from(anyhow::anyhow!("{}", err));
    serde_json::to_string(&backend_err)
        .unwrap_or_else(|_| format!(r#"{{"code":"internal_error","message":"{}"}}"#, err))
}
