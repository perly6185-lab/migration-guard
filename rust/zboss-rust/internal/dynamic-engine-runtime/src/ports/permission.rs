use crate::{domain::context::RequestContext, http::error::ApiError};

pub trait PermissionPort: Send + Sync {
    fn ensure_page_access(&self, context: &RequestContext, page_id: u64) -> Result<(), ApiError>;
}
