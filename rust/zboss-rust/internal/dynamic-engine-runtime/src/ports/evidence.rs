use crate::{domain::context::RequestContext, http::error::ApiError};

pub trait EvidencePort: Send + Sync {
    fn append(&self, context: &RequestContext, kind: &str) -> Result<(), ApiError>;
}
