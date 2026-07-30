use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{domain::context::RequestContext, http::error::ApiError};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FieldDeleteBehavior {
    #[default]
    Remove,
    Hide,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldCatalogEntry {
    pub id: u64,
    pub panel_id: u64,
    pub use_page_id: u64,
    pub name: String,
    pub field: String,
    pub table_script_field: String,
    pub field_type_value: String,
    pub field_tag_inner_key: String,
    #[serde(default, skip_serializing)]
    pub panel_resp_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub delete_behavior: FieldDeleteBehavior,
    #[serde(flatten)]
    pub additional_values: BTreeMap<String, serde_json::Value>,
}

/// Read boundary used by the use-page ledger query.
///
/// Implementations must scope results by tenant/datasource/snapshot and
/// `use_page_id`; callers cannot supply physical table or column names.
pub trait FieldCatalogPort: Send + Sync {
    fn list_fields(
        &self,
        context: &RequestContext,
        use_page_id: u64,
    ) -> Result<Vec<FieldCatalogEntry>, ApiError>;

    fn get_field(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<Option<FieldCatalogEntry>, ApiError>;
}
