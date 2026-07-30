#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorLayer {
    Validation,
    Context,
    Query,
    Refresh,
    Mutation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub layer: ErrorLayer,
    pub http_status: u16,
    pub code: i32,
    pub message: String,
    pub retryable: bool,
    pub compensation_errors: Vec<String>,
}

impl ApiError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self {
            layer: ErrorLayer::Validation,
            http_status: 400,
            code: 400_001,
            message: message.into(),
            retryable: false,
            compensation_errors: vec![],
        }
    }

    pub fn context(message: impl Into<String>) -> Self {
        Self {
            layer: ErrorLayer::Context,
            http_status: 403,
            code: 403_001,
            message: message.into(),
            retryable: false,
            compensation_errors: vec![],
        }
    }

    pub fn query(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            layer: ErrorLayer::Query,
            http_status: 503,
            code: 503_001,
            message: message.into(),
            retryable,
            compensation_errors: vec![],
        }
    }

    pub fn refresh(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            layer: ErrorLayer::Refresh,
            http_status: 409,
            code: 409_001,
            message: message.into(),
            retryable,
            compensation_errors: vec![],
        }
    }

    pub fn mutation(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            layer: ErrorLayer::Mutation,
            http_status: 503,
            code: 503_002,
            message: message.into(),
            retryable,
            compensation_errors: vec![],
        }
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            layer: ErrorLayer::Mutation,
            http_status: 409,
            code: 409_002,
            message: message.into(),
            retryable: false,
            compensation_errors: vec![],
        }
    }

    pub fn with_compensation(mut self, error: impl Into<String>) -> Self {
        self.compensation_errors.push(error.into());
        self
    }

    pub fn message_with_compensation(&self) -> String {
        if self.compensation_errors.is_empty() {
            self.message.clone()
        } else {
            format!(
                "{} [compensation: {}]",
                self.message,
                self.compensation_errors.join("; ")
            )
        }
    }
}
