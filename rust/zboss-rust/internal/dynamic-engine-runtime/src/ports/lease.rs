use crate::{domain::context::RequestContext, http::error::ApiError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LeasePriority {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lease {
    pub key: String,
    pub owner_token: String,
    pub fencing_token: u64,
    pub expires_at_millis: u64,
    pub priority: LeasePriority,
}

pub trait LeaseLockPort: Send + Sync {
    fn acquire(
        &self,
        context: &RequestContext,
        key: &str,
        owner_token: &str,
        priority: LeasePriority,
        ttl_millis: u64,
    ) -> Result<Option<Lease>, ApiError>;

    fn release(&self, context: &RequestContext, lease: &Lease) -> Result<bool, ApiError>;
}
