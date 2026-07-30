use serde::{Deserialize, Serialize};

use crate::{domain::context::RequestContext, http::error::ApiError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldDeleteCommand {
    pub request_id: String,
    pub field_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDeleteCommit {
    pub field_id: u64,
    pub panel_id: Option<u64>,
    pub use_page_id: Option<u64>,
    pub deleted: bool,
    pub replayed: bool,
}

/// Transactional metadata-delete boundary.
///
/// Java's single-field delete removes or hides field metadata and related
/// configuration; it does not issue a physical `DROP COLUMN`. Implementations
/// must preserve that distinction and atomically commit metadata cleanup plus
/// a durable post-commit event.
pub trait FieldDeletePort: Send + Sync {
    fn delete_field(
        &self,
        context: &RequestContext,
        command: &FieldDeleteCommand,
    ) -> Result<FieldDeleteCommit, ApiError>;
}
