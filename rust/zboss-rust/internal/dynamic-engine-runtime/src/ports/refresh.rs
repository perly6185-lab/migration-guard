use crate::{domain::context::RequestContext, http::error::ApiError, ports::lease::Lease};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshTarget {
    pub page_id: u64,
    pub panel_id: u64,
    pub column_id: Option<u64>,
}

pub trait RefreshPort: Send + Sync {
    fn sync(
        &self,
        context: &RequestContext,
        target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError>;
    fn update_timestamp(
        &self,
        context: &RequestContext,
        target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError>;
    fn clear_undo(
        &self,
        context: &RequestContext,
        target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError>;
    fn reconcile(
        &self,
        context: &RequestContext,
        target: &RefreshTarget,
        lease: &Lease,
    ) -> Result<(), ApiError>;
}
