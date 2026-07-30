use crate::{
    application::data::page::DynamicEngineApplication,
    domain::context::RequestContext,
    http::{error::ApiError, handler::FieldDetailUseCase},
    ports::field_catalog::{FieldCatalogEntry, FieldCatalogPort},
};

#[cfg(test)]
use crate::application::data::page::PageApplication;

impl<P> FieldDetailUseCase for DynamicEngineApplication<P>
where
    P: FieldCatalogPort + Send + Sync,
{
    fn get_field(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<Option<FieldCatalogEntry>, ApiError> {
        if field_id == 0 {
            return Err(ApiError::validation("id must be positive"));
        }
        let field = self.ports.get_field(context, field_id)?;
        if let Some(field) = &field
            && field.id != field_id
        {
            return Err(ApiError::query(
                "field catalog returned a mismatched field id",
                false,
            ));
        }
        Ok(field)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{
        adapters::memory::MemoryAdapters, http::handler::FieldDetailUseCase,
        ports::field_schema::FieldSchemaCommit,
    };

    const FIELD_ID: u64 = 2_064_558_100_025_122_818;
    const PANEL_ID: u64 = 2_059_838_046_666_665_986;
    const USE_PAGE_ID: u64 = 2_059_838_047_023_181_826;

    fn context(tenant_id: u64) -> RequestContext {
        RequestContext {
            tenant_id,
            user_id: 14,
            device_id: "device".to_owned(),
            request_id: format!("field-detail-{tenant_id}"),
            trace_id: format!("trace-{tenant_id}"),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    fn ports_with_field() -> Arc<MemoryAdapters> {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_field_schema(
            &context(177),
            PANEL_ID,
            USE_PAGE_ID,
            FieldSchemaCommit {
                field_id: FIELD_ID,
                field: "custField66566".to_owned(),
                table_script_field: "cust_field_66566".to_owned(),
                replayed: false,
            },
        );
        ports
    }

    #[test]
    fn detail_returns_scoped_field_and_missing_is_null() {
        let application = PageApplication::new(ports_with_field());

        let field = application
            .get_field(&context(177), FIELD_ID)
            .unwrap()
            .unwrap();
        assert_eq!(field.id, FIELD_ID);
        assert_eq!(field.panel_id, PANEL_ID);
        assert_eq!(field.field, "custField66566");
        assert_eq!(
            application.get_field(&context(177), FIELD_ID + 1).unwrap(),
            None
        );
        assert_eq!(
            application.get_field(&context(178), FIELD_ID).unwrap(),
            None
        );
    }

    #[test]
    fn detail_honors_panel_permission() {
        let ports = ports_with_field();
        ports.deny_field_schema_panel(177, PANEL_ID);
        let application = PageApplication::new(ports);

        let error = application.get_field(&context(177), FIELD_ID).unwrap_err();
        assert_eq!(error.http_status, 403);
    }
}
