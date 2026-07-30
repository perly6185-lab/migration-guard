use crate::{
    domain::context::RequestContext,
    http::{
        dto::{InitRequest, InitResponse, InitTableResult},
        error::ApiError,
        handler::InitUseCase,
    },
    ports::init::{InitCommand, InitPort},
};

use super::page::DynamicEngineApplication;
#[cfg(test)]
use super::page::PageApplication;

impl<P> InitUseCase for DynamicEngineApplication<P>
where
    P: InitPort + Send + Sync,
{
    fn init(
        &self,
        context: &RequestContext,
        mut request: InitRequest,
    ) -> Result<InitResponse, ApiError> {
        if request.req_id.trim().is_empty() {
            request.req_id.clone_from(&context.request_id);
        }
        let panel_id = request
            .panel_id
            .ok_or_else(|| ApiError::validation("panelId is required"))?;
        let use_page_id = request
            .use_page_id
            .ok_or_else(|| ApiError::validation("usePageId is required"))?;
        let order_values = request
            .order_values
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                ApiError::validation(format!("orderValues cannot be encoded: {error}"))
            })?;
        let commit = self.ports.init_atomic(
            context,
            &InitCommand {
                request_id: request.req_id.clone(),
                panel_id,
                use_page_id,
                page_no: request.page_no,
                page_size: request.page_size,
                horizontal_id: request.horizontal_id,
                page_id: request.page_id,
                inter_id: request.inter_id,
                http_id: request.http_id,
                header_values: request.header_values,
                post_values: request.post_values,
                select_values: request.select_values,
                order_values,
                quality_values: request.quality_values,
                upload_tmp_table_name: request.upload_tmp_table_name,
                open_record_change_log: request.open_record_change_log,
                domain: request.domain,
                data_id: request.data_id,
                child_form_field_id: request.child_form_field_id,
                undo: request.undo,
            },
        )?;
        if commit.primary_key_id == 0
            || commit.resp_key.trim().is_empty()
            || commit.outbox_event_id.trim().is_empty()
        {
            return Err(ApiError::mutation(
                "init adapter returned an incomplete atomic commit",
                false,
            ));
        }
        let item = InitTableResult {
            req_id: request.req_id.clone(),
            resp_key: commit.resp_key.clone(),
            data: vec![commit.row],
            total: 1,
        };
        Ok(InitResponse {
            req_id: request.req_id,
            def_resp_key: commit.resp_key.clone(),
            resp_data: [(commit.resp_key, item)].into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::{
        adapters::memory::{FaultPoint, MemoryAdapters},
        http::handler::InitUseCase,
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

    fn request() -> InitRequest {
        InitRequest {
            inter_id: Some(2_059_838_045_706_170_370),
            http_id: Some(2_059_838_047_035_764_739),
            panel_id: Some(2_059_838_046_666_665_986),
            use_page_id: Some(2_059_838_047_023_181_826),
            post_values: [
                ("selfBookRowNum".to_owned(), serde_json::Value::Null),
                ("selfBookRowDirection".to_owned(), json!(-1)),
                ("custField59623".to_owned(), json!("test-ledger-value")),
                ("custField59624".to_owned(), json!("test-ledger-value")),
                ("custField59625".to_owned(), json!("2026-07-30")),
            ]
            .into(),
            ..InitRequest::default()
        }
    }

    #[test]
    fn inserts_once_and_replays_the_same_request_id() {
        let ports = Arc::new(MemoryAdapters::default());
        let application = PageApplication::new(ports.clone());

        let first = application
            .init(&context(177, "init-1"), request())
            .unwrap();
        let replay = application
            .init(&context(177, "init-1"), request())
            .unwrap();

        assert_eq!(first, replay);
        assert_eq!(ports.init_records(&context(177, "init-1")).len(), 1);
        assert_eq!(ports.init_outbox(&context(177, "init-1")).len(), 1);
        let row = &first.resp_data[&first.def_resp_key].data[0];
        assert!(row["id"].as_u64().is_some());
        assert!(row["selfBookRowNum"].as_u64().is_some());
    }

    #[test]
    fn changed_payload_with_same_request_id_conflicts() {
        let ports = Arc::new(MemoryAdapters::default());
        let application = PageApplication::new(ports);
        application
            .init(&context(177, "init-1"), request())
            .unwrap();
        let mut changed = request();
        changed
            .post_values
            .insert("custField59625".to_owned(), json!("2026-07-31"));

        let error = application
            .init(&context(177, "init-1"), changed)
            .unwrap_err();

        assert_eq!(error.http_status, 409);
    }

    #[test]
    fn calculation_or_outbox_failure_rolls_back_the_row() {
        for fault in [FaultPoint::InitCalculate, FaultPoint::InitOutbox] {
            let ports = Arc::new(MemoryAdapters::default());
            ports.inject_fault(fault);
            let application = PageApplication::new(ports.clone());

            assert!(
                application
                    .init(&context(177, "init-fail"), request())
                    .is_err()
            );
            assert!(ports.init_records(&context(177, "init-fail")).is_empty());
            assert!(ports.init_outbox(&context(177, "init-fail")).is_empty());
        }
    }

    #[test]
    fn permission_and_tenant_scope_are_enforced() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.deny_init_panel(177, request().panel_id.unwrap());
        let application = PageApplication::new(ports.clone());

        let error = application
            .init(&context(177, "denied"), request())
            .unwrap_err();
        assert_eq!(error.http_status, 403);

        application
            .init(&context(178, "allowed"), request())
            .unwrap();
        assert!(ports.init_records(&context(177, "denied")).is_empty());
        assert_eq!(ports.init_records(&context(178, "allowed")).len(), 1);
    }
}
