use std::collections::{BTreeMap, BTreeSet};

use crate::{
    application::data::page::DynamicEngineApplication,
    domain::context::RequestContext,
    http::{
        dto::{MetadataQueryRequest, MetadataQueryResponse},
        error::ApiError,
        handler::MetadataQueryUseCase,
    },
    ports::{
        field_catalog::{FieldCatalogEntry, FieldCatalogPort},
        permission::PermissionPort,
        view_metadata::ViewMetadataPort,
    },
};

#[cfg(test)]
use crate::application::data::page::PageApplication;

impl<P> MetadataQueryUseCase for DynamicEngineApplication<P>
where
    P: ViewMetadataPort + FieldCatalogPort + PermissionPort + Send + Sync,
{
    fn query_metadata(
        &self,
        context: &RequestContext,
        request: MetadataQueryRequest,
    ) -> Result<MetadataQueryResponse, ApiError> {
        let use_page_id = request
            .use_page_id
            .ok_or_else(|| ApiError::validation("usePageId is required"))?;
        self.ports.ensure_page_access(context, use_page_id)?;
        let req_id = if request.req_id.trim().is_empty() {
            context.request_id.clone()
        } else {
            request.req_id
        };
        let Some(view_id) = request.view_id else {
            let fields = self.ports.list_fields(context, use_page_id)?;
            let mut seen_ids = BTreeSet::new();
            let mut panels = BTreeMap::<u64, (Option<String>, Vec<FieldCatalogEntry>)>::new();
            for field in fields {
                if field.use_page_id != use_page_id {
                    return Err(ApiError::query(
                        "field catalog identity does not match the scoped request",
                        false,
                    ));
                }
                if !seen_ids.insert(field.id) {
                    return Err(ApiError::query(
                        "field catalog returned a duplicate field id",
                        false,
                    ));
                }
                let panel = panels
                    .entry(field.panel_id)
                    .or_insert_with(|| (field.panel_resp_key.clone(), Vec::new()));
                if let (Some(existing), Some(candidate)) =
                    (panel.0.as_deref(), field.panel_resp_key.as_deref())
                    && existing != candidate
                {
                    return Err(ApiError::query(
                        "field catalog returned inconsistent panel response keys",
                        false,
                    ));
                }
                if panel.0.is_none() {
                    panel.0.clone_from(&field.panel_resp_key);
                }
                panel.1.push(field);
            }
            let mut panel_resp_key_list = Vec::with_capacity(panels.len());
            let mut data = BTreeMap::new();
            for (panel_id, (configured_response_key, fields)) in panels {
                let response_key =
                    configured_response_key.unwrap_or_else(|| format!("panel_{panel_id}"));
                if data.contains_key(&response_key) {
                    return Err(ApiError::query(
                        "field catalog returned a duplicate panel response key",
                        false,
                    ));
                }
                panel_resp_key_list.push(response_key.clone());
                data.insert(
                    response_key,
                    serde_json::json!({
                        "reqId": req_id,
                        "panelId": panel_id,
                        "viewDynamicFieldDataDOList": fields,
                    }),
                );
            }
            return Ok(MetadataQueryResponse {
                req_id,
                use_page_id,
                view_id: None,
                page_id: None,
                view_type: None,
                panel_resp_key_list,
                data,
                value_sync_status_map: Default::default(),
            });
        };
        let metadata = self.ports.load_view(context, use_page_id, view_id)?;
        if metadata.use_page_id != use_page_id || metadata.view_id != view_id {
            return Err(ApiError::query(
                "view metadata identity does not match the scoped request",
                false,
            ));
        }
        Ok(MetadataQueryResponse {
            req_id,
            use_page_id,
            view_id: Some(view_id),
            page_id: Some(metadata.page_id),
            view_type: Some(metadata.view_type),
            panel_resp_key_list: metadata.panel_resp_keys,
            data: metadata.data,
            value_sync_status_map: Default::default(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{
        adapters::memory::MemoryAdapters,
        http::handler::MetadataQueryUseCase,
        ports::{
            field_catalog::{FieldCatalogEntry, FieldDeleteBehavior},
            field_schema::FieldSchemaCommit,
        },
    };

    const USE_PAGE_ID: u64 = 2_059_838_047_023_181_826;
    const PANEL_ID: u64 = 2_059_838_046_666_665_986;

    fn context(tenant_id: u64) -> RequestContext {
        RequestContext {
            tenant_id,
            user_id: 14,
            device_id: "device".to_owned(),
            request_id: format!("ledger-query-{tenant_id}"),
            trace_id: format!("trace-{tenant_id}"),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    fn request() -> MetadataQueryRequest {
        serde_json::from_str(include_str!(
            "../../../contracts/ledger-fields-query-request.json"
        ))
        .unwrap()
    }

    #[test]
    fn field_catalog_query_is_tenant_isolated() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_field_schema(
            &context(177),
            PANEL_ID,
            USE_PAGE_ID,
            FieldSchemaCommit {
                field_id: 1,
                field: "custField1".to_owned(),
                table_script_field: "cust_field_1".to_owned(),
                replayed: false,
            },
        );
        let application = PageApplication::new(ports);

        let owner = application
            .query_metadata(&context(177), request())
            .unwrap();
        let other_tenant = application
            .query_metadata(&context(178), request())
            .unwrap();

        assert_eq!(owner.panel_resp_key_list.len(), 1);
        assert!(other_tenant.panel_resp_key_list.is_empty());
        assert!(other_tenant.data.is_empty());
    }

    #[test]
    fn field_catalog_query_honors_use_page_permission() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.deny_page(177, USE_PAGE_ID);
        let application = PageApplication::new(ports);

        let error = application
            .query_metadata(&context(177), request())
            .unwrap_err();

        assert_eq!(error.http_status, 403);
    }

    #[test]
    fn field_catalog_query_preserves_configured_panel_response_key() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_field_catalog_entry(
            &context(177),
            FieldCatalogEntry {
                id: 1,
                panel_id: PANEL_ID,
                use_page_id: USE_PAGE_ID,
                name: "文本字段".to_owned(),
                field: "custField1".to_owned(),
                table_script_field: "cust_field_1".to_owned(),
                field_type_value: "text".to_owned(),
                field_tag_inner_key: "text".to_owned(),
                panel_resp_key: Some("ledgerData".to_owned()),
                delete_behavior: FieldDeleteBehavior::Remove,
                additional_values: BTreeMap::new(),
            },
        );
        let application = PageApplication::new(ports);

        let response = application
            .query_metadata(&context(177), request())
            .unwrap();

        assert_eq!(response.panel_resp_key_list, vec!["ledgerData"]);
        assert!(response.data.contains_key("ledgerData"));
        assert!(!response.data.contains_key(&format!("panel_{PANEL_ID}")));
    }
}
