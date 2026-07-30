use crate::{domain::context::RequestContext, domain::model::PageMetadata, http::error::ApiError};

pub trait MetadataPort: Send + Sync {
    fn load_page(&self, context: &RequestContext, page_id: u64) -> Result<PageMetadata, ApiError>;

    fn ensure_table_owned(&self, context: &RequestContext, table: &str) -> Result<(), ApiError>;
}
