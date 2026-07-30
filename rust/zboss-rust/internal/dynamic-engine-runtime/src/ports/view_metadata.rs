use crate::{
    domain::{context::RequestContext, model::ViewMetadata},
    http::error::ApiError,
};

pub trait ViewMetadataPort: Send + Sync {
    fn load_view(
        &self,
        context: &RequestContext,
        use_page_id: u64,
        view_id: u64,
    ) -> Result<ViewMetadata, ApiError>;
}
