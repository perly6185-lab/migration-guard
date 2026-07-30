use crate::{
    domain::{context::RequestContext, model::EvidenceEvent},
    http::error::ApiError,
};

pub trait EventPort: Send + Sync {
    fn publish(&self, context: &RequestContext, event: EvidenceEvent) -> Result<(), ApiError>;
}
