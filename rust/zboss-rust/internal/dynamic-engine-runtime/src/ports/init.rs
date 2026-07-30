use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{domain::context::RequestContext, http::error::ApiError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitCommand {
    pub request_id: String,
    pub panel_id: u64,
    pub use_page_id: u64,
    pub page_no: Option<u64>,
    pub page_size: Option<u32>,
    pub horizontal_id: Option<u64>,
    pub page_id: Option<u64>,
    pub inter_id: Option<u64>,
    pub http_id: Option<u64>,
    pub header_values: BTreeMap<String, serde_json::Value>,
    pub post_values: BTreeMap<String, serde_json::Value>,
    pub select_values: BTreeMap<String, serde_json::Value>,
    pub order_values: Vec<serde_json::Value>,
    pub quality_values: BTreeMap<String, serde_json::Value>,
    pub upload_tmp_table_name: Option<String>,
    pub open_record_change_log: Option<bool>,
    pub domain: Option<String>,
    pub data_id: Option<u64>,
    pub child_form_field_id: Option<u64>,
    pub undo: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitCommit {
    pub primary_key_id: u64,
    pub resp_key: String,
    pub row: BTreeMap<String, serde_json::Value>,
    pub outbox_event_id: String,
    pub replayed: bool,
}

/// Atomic boundary for a ZBoss init mutation.
///
/// Implementations must authorize the actor and persist the inserted row,
/// idempotency record, undo anchor and durable post-commit event in one
/// transaction. A returned error must leave no business-row mutation behind.
pub trait InitPort: Send + Sync {
    fn init_atomic(
        &self,
        context: &RequestContext,
        command: &InitCommand,
    ) -> Result<InitCommit, ApiError>;
}
