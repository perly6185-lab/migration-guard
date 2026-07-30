use serde::{Deserialize, Serialize};

use crate::{domain::context::RequestContext, http::error::ApiError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldSchemaCommand {
    pub request_id: String,
    pub panel_id: u64,
    pub use_page_id: u64,
    pub field_id: Option<u64>,
    pub up_field_id: Option<u64>,
    pub name: String,
    pub field_type_value: String,
    pub field_tag_inner_key: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldSchemaCommit {
    pub field_id: u64,
    pub field: String,
    pub table_script_field: String,
    pub replayed: bool,
}

/// Recoverable boundary for field metadata plus physical schema transitions.
///
/// MySQL DDL can commit independently of metadata changes. Implementations
/// therefore must persist a transition ledger before DDL, detect an already
/// existing physical column on retry, and finish metadata/outbox work without
/// issuing a duplicate ALTER TABLE.
pub trait FieldSchemaPort: Send + Sync {
    fn apply_field_transition(
        &self,
        context: &RequestContext,
        command: &FieldSchemaCommand,
    ) -> Result<FieldSchemaCommit, ApiError>;
}
