use crate::{
    application::data::page::DynamicEngineApplication,
    domain::context::RequestContext,
    http::{error::ApiError, handler::FieldDeleteUseCase},
    ports::field_delete::{FieldDeleteCommand, FieldDeletePort},
};

#[cfg(test)]
use crate::application::data::page::PageApplication;

impl<P> FieldDeleteUseCase for DynamicEngineApplication<P>
where
    P: FieldDeletePort + Send + Sync,
{
    fn delete_field(&self, context: &RequestContext, field_id: u64) -> Result<bool, ApiError> {
        if field_id == 0 {
            return Err(ApiError::validation("id must be positive"));
        }
        let commit = self.ports.delete_field(
            context,
            &FieldDeleteCommand {
                request_id: context.request_id.clone(),
                field_id,
            },
        )?;
        if commit.field_id != field_id {
            return Err(ApiError::mutation(
                "field delete adapter returned a mismatched field id",
                false,
            ));
        }
        Ok(commit.deleted)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Barrier},
        thread,
    };

    use super::*;
    use crate::{
        adapters::memory::{FaultPoint, MemoryAdapters},
        http::handler::FieldDeleteUseCase,
        ports::{
            field_catalog::{FieldCatalogEntry, FieldCatalogPort, FieldDeleteBehavior},
            field_schema::FieldSchemaCommit,
        },
    };

    const FIELD_ID: u64 = 2_082_674_387_292_954_625;
    const PANEL_ID: u64 = 2_059_838_046_666_665_986;
    const USE_PAGE_ID: u64 = 2_059_838_047_023_181_826;

    fn context(request_id: &str) -> RequestContext {
        RequestContext {
            tenant_id: 177,
            user_id: 14,
            device_id: "device".to_owned(),
            request_id: request_id.to_owned(),
            trace_id: format!("trace-{request_id}"),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    fn seed(ports: &MemoryAdapters) {
        ports.insert_field_schema(
            &context("seed"),
            PANEL_ID,
            USE_PAGE_ID,
            FieldSchemaCommit {
                field_id: FIELD_ID,
                field: "custField66566".to_owned(),
                table_script_field: "cust_field_66566".to_owned(),
                replayed: false,
            },
        );
    }

    #[test]
    fn delete_removes_catalog_metadata_without_physical_ddl_and_replays() {
        let ports = Arc::new(MemoryAdapters::default());
        seed(&ports);
        let application = PageApplication::new(ports.clone());

        assert!(
            application
                .delete_field(&context("field-delete-1"), FIELD_ID)
                .unwrap()
        );
        assert!(
            application
                .delete_field(&context("field-delete-1"), FIELD_ID)
                .unwrap()
        );
        assert!(
            ports
                .list_fields(&context("query"), USE_PAGE_ID)
                .unwrap()
                .is_empty()
        );
        assert_eq!(ports.field_delete_outbox(&context("query")).len(), 1);
        assert_eq!(ports.field_delete_snapshot_count(&context("query")), 1);
        assert_eq!(
            ports.field_ddl_execution_count(&context("field-delete-1"), "field-delete-1"),
            0
        );
    }

    #[test]
    fn delete_failure_is_atomic_and_retryable() {
        let ports = Arc::new(MemoryAdapters::default());
        seed(&ports);
        ports.inject_fault(FaultPoint::FieldDeleteOutbox);
        let application = PageApplication::new(ports.clone());

        let error = application
            .delete_field(&context("field-delete-fault"), FIELD_ID)
            .unwrap_err();
        assert_eq!(error.http_status, 503);
        assert_eq!(
            ports
                .list_fields(&context("query"), USE_PAGE_ID)
                .unwrap()
                .len(),
            1
        );
        assert!(ports.field_delete_outbox(&context("query")).is_empty());
        assert_eq!(ports.field_delete_snapshot_count(&context("query")), 0);

        ports.clear_faults();
        assert!(
            application
                .delete_field(&context("field-delete-fault"), FIELD_ID)
                .unwrap()
        );
        assert!(
            ports
                .list_fields(&context("query"), USE_PAGE_ID)
                .unwrap()
                .is_empty()
        );
        assert_eq!(ports.field_delete_outbox(&context("query")).len(), 1);
        assert_eq!(ports.field_delete_snapshot_count(&context("query")), 1);
    }

    #[test]
    fn delete_permission_is_checked_before_catalog_mutation() {
        let ports = Arc::new(MemoryAdapters::default());
        seed(&ports);
        ports.deny_field_schema_panel(177, PANEL_ID);
        let application = PageApplication::new(ports.clone());

        let error = application
            .delete_field(&context("field-delete-denied"), FIELD_ID)
            .unwrap_err();

        assert_eq!(error.http_status, 403);
        assert_eq!(
            ports
                .list_fields(&context("query"), USE_PAGE_ID)
                .unwrap()
                .len(),
            1
        );
        assert!(ports.field_delete_outbox(&context("query")).is_empty());
    }

    #[test]
    fn concurrent_delete_commits_once() {
        let ports = Arc::new(MemoryAdapters::default());
        seed(&ports);
        let application = Arc::new(PageApplication::new(ports.clone()));
        let barrier = Arc::new(Barrier::new(3));
        let handles = ["field-delete-a", "field-delete-b"]
            .into_iter()
            .map(|request_id| {
                let application = application.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    application.delete_field(&context(request_id), FIELD_ID)
                })
            })
            .collect::<Vec<_>>();

        barrier.wait();
        let mut results = handles
            .into_iter()
            .map(|handle| handle.join().expect("worker should not panic").unwrap())
            .collect::<Vec<_>>();
        results.sort_unstable();

        assert_eq!(results, vec![false, true]);
        assert_eq!(ports.field_delete_outbox(&context("query")).len(), 1);
    }

    #[test]
    fn changed_delete_payload_with_same_request_id_conflicts() {
        let ports = Arc::new(MemoryAdapters::default());
        seed(&ports);
        ports.insert_field_schema(
            &context("seed"),
            PANEL_ID,
            USE_PAGE_ID,
            FieldSchemaCommit {
                field_id: FIELD_ID + 1,
                field: "custField66567".to_owned(),
                table_script_field: "cust_field_66567".to_owned(),
                replayed: false,
            },
        );
        let application = PageApplication::new(ports);

        assert!(
            application
                .delete_field(&context("field-delete-conflict"), FIELD_ID)
                .unwrap()
        );
        let error = application
            .delete_field(&context("field-delete-conflict"), FIELD_ID + 1)
            .unwrap_err();
        assert_eq!(error.http_status, 409);
    }

    #[test]
    fn protected_field_delete_hides_metadata_and_snapshots_once() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_field_catalog_entry(
            &context("seed"),
            FieldCatalogEntry {
                id: FIELD_ID,
                panel_id: PANEL_ID,
                use_page_id: USE_PAGE_ID,
                name: "系统字段".to_owned(),
                field: "systemField".to_owned(),
                table_script_field: "system_field".to_owned(),
                field_type_value: "system".to_owned(),
                field_tag_inner_key: "session".to_owned(),
                panel_resp_key: Some("data".to_owned()),
                delete_behavior: FieldDeleteBehavior::Hide,
                additional_values: std::collections::BTreeMap::from([(
                    "systemRelated".to_owned(),
                    serde_json::json!("PARENT_RECORD"),
                )]),
            },
        );
        let application = PageApplication::new(ports.clone());

        assert!(
            application
                .delete_field(&context("protected-delete"), FIELD_ID)
                .unwrap()
        );
        assert!(
            !application
                .delete_field(&context("protected-delete-again"), FIELD_ID)
                .unwrap()
        );
        let hidden = ports
            .get_field(&context("query"), FIELD_ID)
            .unwrap()
            .unwrap();
        assert_eq!(hidden.additional_values["fieldShowTag"], false);
        assert_eq!(hidden.additional_values["openList"], 1);
        assert_eq!(hidden.additional_values["systemRelated"], "PARENT_RECORD");
        assert_eq!(ports.field_delete_outbox(&context("query")).len(), 1);
        assert_eq!(ports.field_delete_snapshot_count(&context("query")), 1);
    }
}
