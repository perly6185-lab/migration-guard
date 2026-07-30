use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldMetadata {
    pub key: String,
    pub column: String,
    pub aggregate: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageMetadata {
    pub version: u64,
    pub page_id: u64,
    pub panel_id: u64,
    pub table: String,
    pub business_key: Vec<String>,
    pub fields: Vec<FieldMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewMetadata {
    pub use_page_id: u64,
    pub view_id: u64,
    pub page_id: u64,
    pub panel_id: u64,
    pub inter_id: u64,
    pub http_id: u64,
    pub view_type: String,
    pub panel_resp_keys: Vec<String>,
    pub data: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalOrder {
    pub field_name: String,
    pub ascending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalQuery {
    pub horizontal_id: u64,
    pub selected_fields: Vec<String>,
    pub order: Vec<HorizontalOrder>,
    pub page_no: u32,
    pub page_size: u32,
    pub show_archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalSlice {
    pub rows: Vec<Row>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Null,
    Boolean(bool),
    Integer(i64),
    Text(String),
}

pub type Row = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BusinessKey(pub Vec<Value>);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AggregateResult {
    pub kind: String,
    pub value: Value,
    pub sum: Option<i64>,
    pub count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PivotRow {
    pub business_key: BusinessKey,
    pub values: BTreeMap<String, AggregateResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageLineage {
    pub total: String,
    pub page_keys: String,
    pub cell_rows: String,
    pub pivot_values: String,
}

impl PageLineage {
    pub fn unified(query_fingerprint: &str) -> Self {
        Self {
            total: query_fingerprint.to_owned(),
            page_keys: query_fingerprint.to_owned(),
            cell_rows: query_fingerprint.to_owned(),
            pivot_values: query_fingerprint.to_owned(),
        }
    }

    pub fn is_unified(&self) -> bool {
        self.total == self.page_keys
            && self.total == self.cell_rows
            && self.total == self.pivot_values
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSlice {
    pub rows: Vec<Row>,
    pub total: u64,
    pub page_keys: Vec<BusinessKey>,
    pub pivot_values: Vec<PivotRow>,
    pub lineage: PageLineage,
    pub query_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceEvent {
    pub trace_id: String,
    pub kind: String,
    pub sequence: u64,
}
