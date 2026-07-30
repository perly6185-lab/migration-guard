use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, de};

use crate::domain::model::Value;

#[derive(Deserialize)]
#[serde(untagged)]
enum FlexibleU64 {
    Integer(u64),
    String(String),
}

fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<FlexibleU64>::deserialize(deserializer)?.map_or(Ok(None), |value| {
        let parsed = match value {
            FlexibleU64::Integer(value) => value,
            FlexibleU64::String(value) => value
                .parse::<u64>()
                .map_err(|_| de::Error::custom("identifier must be an unsigned integer"))?,
        };
        if parsed == 0 {
            Err(de::Error::custom("identifier must be positive"))
        } else {
            Ok(Some(parsed))
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataQueryRequest {
    pub req_id: String,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub use_page_id: Option<u64>,
    pub show: Option<bool>,
    pub use_page_mode: Option<String>,
    pub operation_type: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub config_id: Option<u64>,
    pub is_export: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub field_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub parent_field_id: Option<u64>,
    pub post_values: BTreeMap<String, serde_json::Value>,
    pub select_values: BTreeMap<String, serde_json::Value>,
    #[serde(rename = "horizontalDataPageTreeReqVOs")]
    pub horizontal_data_page_tree_req_vos: Vec<serde_json::Value>,
    pub quick_operation_type: Option<i32>,
    pub use_page_template_page: Option<i32>,
    pub super_import_show: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub view_id: Option<u64>,
}

impl MetadataQueryRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.use_page_id.is_none() {
            return Err("usePageId is required");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataQueryResponse {
    pub req_id: String,
    pub use_page_id: u64,
    pub view_id: Option<u64>,
    pub page_id: Option<u64>,
    pub view_type: Option<String>,
    pub panel_resp_key_list: Vec<String>,
    pub data: BTreeMap<String, serde_json::Value>,
    pub value_sync_status_map: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldOrderRequest {
    pub field_name: String,
    pub direction: String,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub field_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HorizontalListRequest {
    pub req_id: String,
    pub operator: Option<String>,
    pub page_no: Option<u32>,
    pub page_size: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub horizontal_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub use_page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub panel_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub inter_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub http_id: Option<u64>,
    pub header_values: BTreeMap<String, serde_json::Value>,
    pub post_values: BTreeMap<String, serde_json::Value>,
    pub select_values: BTreeMap<String, serde_json::Value>,
    pub order_values: Vec<FieldOrderRequest>,
    #[serde(rename = "engineHorizontalPartReqVOS")]
    pub engine_horizontal_part_req_vos: Vec<serde_json::Value>,
    pub page_create_mode: Option<i32>,
    pub show_archived: Option<bool>,
}

impl HorizontalListRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.horizontal_id.is_none() && self.use_page_id.is_none() {
            return Err("horizontalId or usePageId is required");
        }
        if self.page_no == Some(0) {
            return Err("pageNo must be positive");
        }
        if self.page_size == Some(0) {
            return Err("pageSize must be positive");
        }
        if self.page_size.is_some_and(|value| value > 10_000) {
            return Err("pageSize exceeds the 10000-row compatibility boundary");
        }
        if self.order_values.iter().any(|order| {
            order.field_name.trim().is_empty()
                || !(order.direction.eq_ignore_ascii_case("asc")
                    || order.direction.eq_ignore_ascii_case("desc"))
        }) {
            return Err("orderValues contains an invalid field or direction");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HorizontalListResponse {
    pub req_id: String,
    pub page_no: u32,
    pub page_size: u32,
    pub total: u64,
    pub resp_data: Vec<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QualityOperator {
    #[serde(rename = "EQ", alias = "EQUAL")]
    Equal,
    #[serde(rename = "NE", alias = "NOT_EQUAL")]
    NotEqual,
    #[serde(rename = "GT", alias = "GREATER_THAN")]
    GreaterThan,
    #[serde(rename = "GTE", alias = "GREATER_THAN_OR_EQUAL")]
    GreaterThanOrEqual,
    #[serde(rename = "LT", alias = "LESS_THAN")]
    LessThan,
    #[serde(rename = "LTE", alias = "LESS_THAN_OR_EQUAL")]
    LessThanOrEqual,
    #[serde(rename = "IN")]
    In,
    #[serde(rename = "IS_NULL")]
    IsNull,
    #[serde(rename = "IS_NOT_NULL")]
    IsNotNull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QualityCondition {
    pub operator: QualityOperator,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum QualityValue {
    Scalar(Value),
    Condition(QualityCondition),
}

impl From<Value> for QualityValue {
    fn from(value: Value) -> Self {
        Self::Scalar(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct InitRequest {
    pub req_id: String,
    pub operator: Option<String>,
    pub page_no: Option<u64>,
    pub page_size: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub horizontal_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub use_page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub panel_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub inter_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub http_id: Option<u64>,
    pub header_values: BTreeMap<String, serde_json::Value>,
    pub post_values: BTreeMap<String, serde_json::Value>,
    pub select_values: BTreeMap<String, serde_json::Value>,
    pub order_values: Vec<FieldOrderRequest>,
    pub quality_values: BTreeMap<String, serde_json::Value>,
    pub upload_tmp_table_name: Option<String>,
    pub open_record_change_log: Option<bool>,
    pub domain: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub data_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub child_form_field_id: Option<u64>,
    pub undo: Option<bool>,
}

impl InitRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.panel_id.is_none() {
            return Err("panelId is required");
        }
        if self.use_page_id.is_none() {
            return Err("usePageId is required");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitTableResult {
    pub req_id: String,
    pub resp_key: String,
    pub data: Vec<BTreeMap<String, serde_json::Value>>,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitResponse {
    pub req_id: String,
    pub def_resp_key: String,
    pub resp_data: BTreeMap<String, InitTableResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FieldSchemaUpdateRequest {
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub panel_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub use_page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub up_field_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub inter_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub http_id: Option<u64>,
    pub pid: Option<serde_json::Value>,
    pub name: String,
    pub field_type_value: String,
    pub field_tag_inner_key: String,
    pub field_tag_css: Option<String>,
    pub field_background_color: Option<String>,
    pub quick_operation_type: Option<i32>,
    pub fill_data_sync_tag: Option<bool>,
    pub is_empower: Option<i32>,
    pub ai_empower_config_save_vo: Option<serde_json::Value>,
    pub font_color_conditions: Vec<serde_json::Value>,
    pub background_color_conditions: Vec<serde_json::Value>,
    pub page_no: Option<u64>,
    pub page_size: Option<u32>,
    pub header_values: BTreeMap<String, serde_json::Value>,
    pub post_values: BTreeMap<String, serde_json::Value>,
    pub select_values: BTreeMap<String, serde_json::Value>,
    pub order_values: Vec<FieldOrderRequest>,
    pub show_archived: Option<bool>,
    #[serde(flatten)]
    pub additional_values: BTreeMap<String, serde_json::Value>,
}

impl FieldSchemaUpdateRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.panel_id.is_none() {
            return Err("panelId is required");
        }
        if self.use_page_id.is_none() {
            return Err("usePageId is required");
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 255 {
            return Err("name must contain 1 to 255 characters");
        }
        if !safe_field_type(&self.field_type_value) {
            return Err("fieldTypeValue is invalid");
        }
        if !safe_field_type(&self.field_tag_inner_key) {
            return Err("fieldTagInnerKey is invalid");
        }
        if self.page_size == Some(0) || self.page_size.is_some_and(|value| value > 10_000) {
            return Err("pageSize must be between 1 and 10000");
        }
        Ok(())
    }
}

fn safe_field_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldSchemaUpdateResponse {
    pub id: u64,
    pub panel_id: u64,
    pub use_page_id: u64,
    pub name: String,
    pub field: String,
    pub table_script_field: String,
    pub field_type_value: String,
    pub field_tag_inner_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRequest {
    pub req_id: String,
    pub operator: Option<String>,
    pub page_no: Option<u32>,
    pub page_size: Option<u32>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub use_page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub page_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub panel_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub inter_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub http_id: Option<u64>,
    pub header_values: BTreeMap<String, Value>,
    pub layout_global_condition: Option<String>,
    pub post_values: BTreeMap<String, Value>,
    pub select_values: BTreeMap<String, Value>,
    pub order_values: Vec<String>,
    pub quality_values: BTreeMap<String, QualityValue>,
    pub text_filter_value: Option<String>,
    pub horizontal_values: BTreeMap<String, Value>,
    pub horizontal_key_values: Vec<Vec<Value>>,
    #[serde(rename = "horizontalDataPageTreeReqVOs")]
    pub horizontal_data_page_tree_values: Vec<BTreeMap<String, Value>>,
    pub upload_tmp_table_name: Option<String>,
    pub upload_tmp_flag: Option<i32>,
    pub page_create_mode: Option<i32>,
    pub use_page_template_page: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub field_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub data_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub child_form_field_id: Option<u64>,
    pub skip_save_page_size: Option<bool>,
    pub show_archived: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub relate_field_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub primary_key_id: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub locate_primary_key_id: Option<u64>,
}

impl PageRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.page_no == Some(0) {
            return Err("pageNo must be positive");
        }
        if self.page_size == Some(0) {
            return Err("pageSize must be positive");
        }
        if self.page_size.is_some_and(|value| value > 10_000) {
            return Err("pageSize exceeds the 10000-row compatibility boundary");
        }
        if self.use_page_id.is_none() && self.page_id.is_none() {
            return Err("usePageId or pageId is required");
        }
        if matches!(
            (self.primary_key_id, self.locate_primary_key_id),
            (Some(primary_key_id), Some(locate_primary_key_id))
                if primary_key_id != locate_primary_key_id
        ) {
            return Err("primaryKeyId and locatePrimaryKeyId conflict");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageItem {
    pub req_id: String,
    pub resp_key: String,
    pub data: Vec<BTreeMap<String, Value>>,
    pub total: u64,
    pub page_no: u32,
    pub target_layout_tag: Option<String>,
    pub is_record_row_num: bool,
    pub value_sync_status_list: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageResponse {
    pub req_id: String,
    pub def_resp_key: String,
    pub resp_data: Vec<PageItem>,
    pub head_list: Vec<BTreeMap<String, Value>>,
    pub value_sync_status_list: Vec<String>,
    pub value_sync_status_map: BTreeMap<String, String>,
    pub upload_tmp_table_name: Option<String>,
    pub batch_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Readiness {
    pub ready: bool,
    pub profile: String,
    pub contract_version: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_fails_closed() {
        let request = PageRequest::default();
        assert_eq!(request.validate(), Err("usePageId or pageId is required"));
        let request = PageRequest {
            req_id: "req-1".to_owned(),
            use_page_id: Some(7),
            page_no: Some(0),
            ..PageRequest::default()
        };
        assert_eq!(request.validate(), Err("pageNo must be positive"));

        let request = PageRequest {
            use_page_id: Some(7),
            page_id: Some(8),
            ..PageRequest::default()
        };
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn frozen_fixture_round_trips_without_precision_loss() {
        let fixture = include_str!("../../fixtures/contracts/page-request-minimal.json");
        let request: PageRequest = serde_json::from_str(fixture).unwrap();
        assert_eq!(request.use_page_id, Some(9_007_199_254_740_993));
        let encoded = serde_json::to_string(&request).unwrap();
        let decoded: PageRequest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, request);
        assert!(encoded.contains("\"horizontalDataPageTreeReqVOs\""));
    }

    #[test]
    fn unknown_request_fields_are_rejected() {
        let value = r#"{"reqId":"r","usePageId":7,"unexpected":true}"#;
        assert!(serde_json::from_str::<PageRequest>(value).is_err());
    }

    #[test]
    fn optional_collections_default_to_empty() {
        let request: PageRequest = serde_json::from_str(r#"{"reqId":"r","usePageId":7}"#).unwrap();
        assert!(request.header_values.is_empty());
        assert!(request.quality_values.is_empty());
        assert_eq!(request.page_no, None);
    }

    #[test]
    fn provided_init_request_preserves_identifiers_nulls_and_direction() {
        let request: InitRequest = serde_json::from_str(
            r#"{
                "interId":"2059838045706170370",
                "httpId":"2059838047035764739",
                "panelId":"2059838046666665986",
                "postValues":{
                    "selfBookRowNum":null,
                    "selfBookRowDirection":-1,
                    "custField59623":"test-ledger-value",
                    "custField59624":"test-ledger-value",
                    "custField59625":"2026-07-30"
                },
                "headerValues":{},
                "usePageId":"2059838047023181826"
            }"#,
        )
        .unwrap();

        assert_eq!(request.inter_id, Some(2_059_838_045_706_170_370));
        assert_eq!(request.http_id, Some(2_059_838_047_035_764_739));
        assert_eq!(request.panel_id, Some(2_059_838_046_666_665_986));
        assert_eq!(request.use_page_id, Some(2_059_838_047_023_181_826));
        assert_eq!(
            request.post_values["selfBookRowDirection"].as_i64(),
            Some(-1)
        );
        assert!(request.post_values["selfBookRowNum"].is_null());
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn init_requires_panel_and_use_page_identity() {
        let request = InitRequest::default();
        assert_eq!(request.validate(), Err("panelId is required"));
        let request = InitRequest {
            panel_id: Some(7),
            ..InitRequest::default()
        };
        assert_eq!(request.validate(), Err("usePageId is required"));
    }

    #[test]
    fn provided_field_schema_request_preserves_add_column_contract() {
        let request: FieldSchemaUpdateRequest = serde_json::from_str(include_str!(
            "../../contracts/field-schema-update-request.json"
        ))
        .unwrap();

        assert_eq!(request.panel_id, Some(2_059_838_046_666_665_986));
        assert_eq!(request.use_page_id, Some(2_059_838_047_023_181_826));
        assert_eq!(request.up_field_id, Some(2_064_551_654_357_078_017));
        assert_eq!(request.pid, Some(serde_json::json!("0")));
        assert_eq!(request.name, "文本字段");
        assert_eq!(request.field_type_value, "text");
        assert_eq!(request.field_tag_inner_key, "text");
        assert_eq!(request.select_values.len(), 26);
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn provided_field_schema_request_preserves_edit_column_contract() {
        let request: FieldSchemaUpdateRequest = serde_json::from_str(include_str!(
            "../../contracts/field-schema-edit-request.json"
        ))
        .unwrap();

        assert_eq!(request.id, Some(2_082_674_387_292_954_625));
        assert_eq!(request.panel_id, Some(2_059_838_046_666_665_986));
        assert_eq!(request.use_page_id, Some(2_059_838_047_023_181_826));
        assert_eq!(request.up_field_id, None);
        assert_eq!(request.pid, None);
        assert_eq!(request.name, "文本字段1");
        assert_eq!(request.field_type_value, "text");
        assert_eq!(request.field_tag_inner_key, "text");
        assert_eq!(request.select_values.len(), 27);
        assert_eq!(
            request.select_values["custField66566"],
            serde_json::json!("custField66566")
        );
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn provided_ledger_fields_query_selects_use_page_mode() {
        let request: MetadataQueryRequest = serde_json::from_str(include_str!(
            "../../contracts/ledger-fields-query-request.json"
        ))
        .unwrap();

        assert_eq!(request.use_page_id, Some(2_059_838_047_023_181_826));
        assert_eq!(request.view_id, None);
        assert_eq!(request.validate(), Ok(()));
    }

    #[test]
    fn quality_values_accept_scalar_and_typed_conditions() {
        let request: PageRequest = serde_json::from_str(
            r#"{
                "reqId":"r",
                "usePageId":7,
                "qualityValues":{
                    "status":"open",
                    "amount":{"operator":"GT","value":100},
                    "region":{"operator":"IN","values":["east","west"]}
                }
            }"#,
        )
        .unwrap();
        assert!(matches!(
            request.quality_values["status"],
            QualityValue::Scalar(Value::Text(_))
        ));
        assert!(matches!(
            request.quality_values["amount"],
            QualityValue::Condition(QualityCondition {
                operator: QualityOperator::GreaterThan,
                ..
            })
        ));
        assert_eq!(
            serde_json::to_value(&request).unwrap()["qualityValues"]["region"]["operator"],
            "IN"
        );
    }
}
