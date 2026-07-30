use crate::{domain::context::RequestContext, http::error::ApiError};

pub trait PagePreferencePort: Send + Sync {
    fn save_page_size(
        &self,
        context: &RequestContext,
        page_id: u64,
        page_size: u32,
    ) -> Result<(), ApiError>;
}
