use crate::{
    domain::context::RequestContext,
    http::{
        dto::{FieldSchemaUpdateRequest, FieldSchemaUpdateResponse},
        error::ApiError,
        handler::FieldSchemaUseCase,
    },
    ports::field_schema::{FieldSchemaCommand, FieldSchemaPort},
};

use crate::application::data::page::DynamicEngineApplication;
#[cfg(test)]
use crate::application::data::page::PageApplication;

impl<P> FieldSchemaUseCase for DynamicEngineApplication<P>
where
    P: FieldSchemaPort + Send + Sync,
{
    fn update_field_schema(
        &self,
        context: &RequestContext,
        request: FieldSchemaUpdateRequest,
    ) -> Result<FieldSchemaUpdateResponse, ApiError> {
        let panel_id = request
            .panel_id
            .ok_or_else(|| ApiError::validation("panelId is required"))?;
        let use_page_id = request
            .use_page_id
            .ok_or_else(|| ApiError::validation("usePageId is required"))?;
        let payload = serde_json::to_value(&request).map_err(|error| {
            ApiError::validation(format!("field update request cannot be encoded: {error}"))
        })?;
        let commit = self.ports.apply_field_transition(
            context,
            &FieldSchemaCommand {
                request_id: context.request_id.clone(),
                panel_id,
                use_page_id,
                field_id: request.id,
                up_field_id: request.up_field_id,
                name: request.name.clone(),
                field_type_value: request.field_type_value.clone(),
                field_tag_inner_key: request.field_tag_inner_key.clone(),
                payload,
            },
        )?;
        if commit.field_id == 0
            || commit.field.trim().is_empty()
            || commit.table_script_field.trim().is_empty()
        {
            return Err(ApiError::mutation(
                "field schema adapter returned an incomplete transition",
                false,
            ));
        }
        Ok(FieldSchemaUpdateResponse {
            id: commit.field_id,
            panel_id,
            use_page_id,
            name: request.name,
            field: commit.field,
            table_script_field: commit.table_script_field,
            field_type_value: request.field_type_value,
            field_tag_inner_key: request.field_tag_inner_key,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{
        adapters::memory::{FaultPoint, MemoryAdapters},
        http::handler::FieldSchemaUseCase,
        ports::field_schema::FieldSchemaCommit,
    };

    fn context(tenant_id: u64, request_id: &str) -> RequestContext {
        RequestContext {
            tenant_id,
            user_id: 14,
            device_id: "device".to_owned(),
            request_id: request_id.to_owned(),
            trace_id: format!("trace-{request_id}"),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    fn request() -> FieldSchemaUpdateRequest {
        serde_json::from_str(include_str!(
            "../../../contracts/field-schema-update-request.json"
        ))
        .unwrap()
    }

    fn edit_request() -> FieldSchemaUpdateRequest {
        serde_json::from_str(include_str!(
            "../../../contracts/field-schema-edit-request.json"
        ))
        .unwrap()
    }

    fn seed_edited_field(ports: &MemoryAdapters, request_id: &str) {
        let request = edit_request();
        ports.insert_field_schema(
            &context(177, request_id),
            request.panel_id.unwrap(),
            request.use_page_id.unwrap(),
            FieldSchemaCommit {
                field_id: request.id.unwrap(),
                field: "custField66566".to_owned(),
                table_script_field: "cust_field_66566".to_owned(),
                replayed: false,
            },
        );
    }

    #[test]
    fn metadata_failure_leaves_a_resumable_ddl_transition() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.inject_fault(FaultPoint::FieldSchemaMetadata);
        let application = PageApplication::new(ports.clone());

        assert!(
            application
                .update_field_schema(&context(177, "field-add-1"), request())
                .is_err()
        );
        assert_eq!(
            ports.field_transition_phase(&context(177, "field-add-1"), "field-add-1"),
            Some("ddl-applied".to_owned())
        );
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-1"), "field-add-1"),
            1
        );
        assert!(
            ports
                .field_schema_records(&context(177, "field-add-1"))
                .is_empty()
        );

        ports.clear_faults();
        let response = application
            .update_field_schema(&context(177, "field-add-1"), request())
            .unwrap();
        assert_ne!(response.id, 0);
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-1"), "field-add-1"),
            1
        );
        assert_eq!(
            ports
                .field_schema_records(&context(177, "field-add-1"))
                .len(),
            1
        );
    }

    #[test]
    fn successful_request_replays_and_changed_payload_conflicts() {
        let ports = Arc::new(MemoryAdapters::default());
        let application = PageApplication::new(ports.clone());
        let first = application
            .update_field_schema(&context(177, "field-add-1"), request())
            .unwrap();
        let replay = application
            .update_field_schema(&context(177, "field-add-1"), request())
            .unwrap();
        assert_eq!(first, replay);
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-1"), "field-add-1"),
            1
        );

        let mut changed = request();
        changed.name = "另一个文本字段".to_owned();
        let error = application
            .update_field_schema(&context(177, "field-add-1"), changed)
            .unwrap_err();
        assert_eq!(error.http_status, 409);
    }

    #[test]
    fn edit_preserves_server_physical_identity_and_never_adds_a_column() {
        let ports = Arc::new(MemoryAdapters::default());
        seed_edited_field(&ports, "field-edit-1");
        let application = PageApplication::new(ports.clone());
        let mut request = edit_request();
        request.field_type_value = "number".to_owned();
        request.field_tag_inner_key = "number".to_owned();

        let response = application
            .update_field_schema(&context(177, "field-edit-1"), request.clone())
            .unwrap();
        let replay = application
            .update_field_schema(&context(177, "field-edit-1"), request)
            .unwrap();

        assert_eq!(response, replay);
        assert_eq!(response.id, 2_082_674_387_292_954_625);
        assert_eq!(response.field, "custField66566");
        assert_eq!(response.table_script_field, "cust_field_66566");
        assert_eq!(response.field_type_value, "number");
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-edit-1"), "field-edit-1"),
            0
        );
        assert_eq!(
            ports
                .field_schema_records(&context(177, "field-edit-1"))
                .len(),
            1
        );
    }

    #[test]
    fn edit_rejects_unknown_or_cross_scope_field_without_creating_a_transition() {
        let ports = Arc::new(MemoryAdapters::default());
        seed_edited_field(&ports, "seed");
        let application = PageApplication::new(ports.clone());

        let error = application
            .update_field_schema(&context(178, "field-edit-missing"), edit_request())
            .unwrap_err();

        assert_eq!(error.http_status, 409);
        assert_eq!(
            ports.field_transition_phase(&context(178, "field-edit-missing"), "field-edit-missing"),
            None
        );
        assert_eq!(
            ports.field_ddl_execution_count(
                &context(178, "field-edit-missing"),
                "field-edit-missing"
            ),
            0
        );
    }

    #[test]
    fn concurrent_edit_replays_once_without_ddl() {
        use std::{sync::Barrier, thread};

        let ports = Arc::new(MemoryAdapters::default());
        seed_edited_field(&ports, "field-edit-concurrent");
        let application = Arc::new(PageApplication::new(ports.clone()));
        let barrier = Arc::new(Barrier::new(3));

        let handles = (0..2)
            .map(|_| {
                let application = application.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    application
                        .update_field_schema(&context(177, "field-edit-concurrent"), edit_request())
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let responses = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker should not panic").unwrap())
            .collect::<Vec<_>>();

        assert_eq!(responses[0], responses[1]);
        assert_eq!(
            ports.field_ddl_execution_count(
                &context(177, "field-edit-concurrent"),
                "field-edit-concurrent"
            ),
            0
        );
        assert_eq!(
            ports
                .field_schema_records(&context(177, "field-edit-concurrent"))
                .len(),
            1
        );
    }

    #[test]
    fn permission_and_tenant_scope_are_enforced() {
        let ports = Arc::new(MemoryAdapters::default());
        let panel_id = request().panel_id.unwrap();
        ports.deny_field_schema_panel(177, panel_id);
        let application = PageApplication::new(ports.clone());

        let error = application
            .update_field_schema(&context(177, "denied"), request())
            .unwrap_err();
        assert_eq!(error.http_status, 403);
        application
            .update_field_schema(&context(178, "allowed"), request())
            .unwrap();
        assert!(
            ports
                .field_schema_records(&context(177, "denied"))
                .is_empty()
        );
        assert_eq!(
            ports.field_schema_records(&context(178, "allowed")).len(),
            1
        );
    }

    #[test]
    fn concurrent_same_request_runs_ddl_once() {
        use std::{sync::Barrier, thread};

        let ports = Arc::new(MemoryAdapters::default());
        let application = Arc::new(PageApplication::new(ports.clone()));
        let barrier = Arc::new(Barrier::new(3));

        let handles = (0..2)
            .map(|_| {
                let application = application.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    application
                        .update_field_schema(&context(177, "field-add-concurrent"), request())
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let responses = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker should not panic").unwrap())
            .collect::<Vec<_>>();

        assert_eq!(responses[0], responses[1]);
        assert_eq!(
            ports.field_ddl_execution_count(
                &context(177, "field-add-concurrent"),
                "field-add-concurrent"
            ),
            1
        );
        assert_eq!(
            ports
                .field_schema_records(&context(177, "field-add-concurrent"))
                .len(),
            1
        );
        assert_eq!(
            ports.field_transition_phase(
                &context(177, "field-add-concurrent"),
                "field-add-concurrent"
            ),
            Some("succeeded".to_owned())
        );
    }

    #[test]
    fn ddl_failure_retries_from_planned_phase() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.inject_fault(FaultPoint::FieldSchemaDdl);
        let application = PageApplication::new(ports.clone());

        let error = application
            .update_field_schema(&context(177, "field-add-ddl"), request())
            .expect_err("DDL failure should surface");
        assert_eq!(error.http_status, 503);
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-ddl"), "field-add-ddl"),
            0
        );
        assert_eq!(
            ports.field_transition_phase(&context(177, "field-add-ddl"), "field-add-ddl"),
            Some("planned".to_owned())
        );

        ports.clear_faults();
        application
            .update_field_schema(&context(177, "field-add-ddl"), request())
            .expect("retry should succeed");
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-ddl"), "field-add-ddl"),
            1
        );
        assert_eq!(
            ports.field_transition_phase(&context(177, "field-add-ddl"), "field-add-ddl"),
            Some("succeeded".to_owned())
        );
    }

    #[test]
    fn outbox_failure_resumes_without_repeating_ddl() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.inject_fault(FaultPoint::FieldSchemaOutbox);
        let application = PageApplication::new(ports.clone());

        let error = application
            .update_field_schema(&context(177, "field-add-outbox"), request())
            .expect_err("outbox failure should surface");
        assert_eq!(error.http_status, 503);
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-outbox"), "field-add-outbox"),
            1
        );
        assert_eq!(
            ports.field_transition_phase(&context(177, "field-add-outbox"), "field-add-outbox"),
            Some("ddl-applied".to_owned())
        );

        ports.clear_faults();
        application
            .update_field_schema(&context(177, "field-add-outbox"), request())
            .expect("retry should succeed");
        assert_eq!(
            ports.field_ddl_execution_count(&context(177, "field-add-outbox"), "field-add-outbox"),
            1
        );
        assert_eq!(
            ports
                .field_schema_records(&context(177, "field-add-outbox"))
                .len(),
            1
        );
        assert_eq!(
            ports.field_transition_phase(&context(177, "field-add-outbox"), "field-add-outbox"),
            Some("succeeded".to_owned())
        );
    }
}
