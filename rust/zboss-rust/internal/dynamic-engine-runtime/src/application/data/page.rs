use std::{collections::BTreeMap, sync::Arc};

use crate::{
    domain::{
        context::RequestContext,
        model::{PageMetadata, PivotRow, Row, Value},
        quality::compile_quality,
        query::{
            Aggregate, AggregateProjection, Direction, Identifier, Order, QueryPlan,
            QueryPlanError, identifiers,
        },
        request_filter::{compile_request_filters, upload_parameters},
    },
    http::{
        dto::{PageItem, PageRequest, PageResponse},
        error::ApiError,
        handler::PageUseCase,
    },
    ports::{
        child_form::ChildFormPort,
        evidence::EvidencePort,
        lease::{LeaseLockPort, LeasePriority},
        metadata::MetadataPort,
        permission::PermissionPort,
        preference::PagePreferencePort,
        query::PageQueryPort,
        refresh::{RefreshPort, RefreshTarget},
    },
};

pub struct DynamicEngineApplication<P> {
    pub(crate) ports: Arc<P>,
    default_page_size: u32,
    maximum_page_size: u32,
    refresh_ttl_millis: u64,
}

impl<P> Clone for DynamicEngineApplication<P> {
    fn clone(&self) -> Self {
        Self {
            ports: Arc::clone(&self.ports),
            default_page_size: self.default_page_size,
            maximum_page_size: self.maximum_page_size,
            refresh_ttl_millis: self.refresh_ttl_millis,
        }
    }
}

impl<P> DynamicEngineApplication<P> {
    pub fn new(ports: Arc<P>) -> Self {
        Self {
            ports,
            default_page_size: 20,
            maximum_page_size: 10_000,
            refresh_ttl_millis: 30_000,
        }
    }
}

impl<P> PageUseCase for DynamicEngineApplication<P>
where
    P: MetadataPort
        + PageQueryPort
        + PagePreferencePort
        + PermissionPort
        + ChildFormPort
        + RefreshPort
        + LeaseLockPort
        + EvidencePort
        + Send
        + Sync,
{
    fn execute(
        &self,
        context: &RequestContext,
        mut request: PageRequest,
    ) -> Result<PageResponse, ApiError> {
        if request.req_id.trim().is_empty() {
            request.req_id.clone_from(&context.request_id);
        }
        let page_id = request
            .use_page_id
            .or(request.page_id)
            .ok_or_else(|| ApiError::validation("usePageId or pageId is required"))?;
        self.ports.ensure_page_access(context, page_id)?;
        let metadata = self.ports.load_page(context, page_id)?;
        if request
            .panel_id
            .is_some_and(|panel_id| panel_id != metadata.panel_id)
        {
            return Err(ApiError::validation(
                "panelId does not match scoped page metadata",
            ));
        }
        if let Some(field_id) = request.child_form_field_id {
            let headers = self.ports.header_conditions(context, field_id)?;
            for (key, value) in headers {
                request.header_values.entry(key).or_insert(value);
            }
        }
        let (upload_table, upload_flag) = upload_parameters(&request)
            .map_err(|error| ApiError::validation(format!("invalid upload contract: {error:?}")))?;
        request.upload_tmp_table_name = upload_table;
        request.upload_tmp_flag = upload_flag;
        let query_table = request
            .upload_tmp_table_name
            .as_deref()
            .unwrap_or(&metadata.table);
        if request.upload_tmp_table_name.is_some() {
            Identifier::parse(query_table).map_err(|error| {
                ApiError::validation(format!("invalid temporary table: {error:?}"))
            })?;
            self.ports.ensure_table_owned(context, query_table)?;
        }
        let page_no = request.page_no.unwrap_or(1);
        let page_size = request
            .page_size
            .unwrap_or(self.default_page_size)
            .min(self.maximum_page_size);
        if request.skip_save_page_size != Some(true) {
            self.ports
                .save_page_size(context, metadata.page_id, page_size)?;
        }
        let plan = build_plan(&metadata, query_table, &request, page_no, page_size)
            .map_err(|error| ApiError::validation(format!("invalid query contract: {error:?}")))?;

        if let Some(priority) = refresh_priority(request.operator.as_deref()) {
            self.execute_refresh(context, &request, &metadata, plan, priority)
        } else {
            self.execute_query(context, &request, &metadata, plan)
        }
    }
}

impl<P> DynamicEngineApplication<P>
where
    P: PageQueryPort + RefreshPort + LeaseLockPort + EvidencePort,
{
    fn execute_refresh(
        &self,
        context: &RequestContext,
        request: &PageRequest,
        metadata: &PageMetadata,
        plan: QueryPlan,
        priority: LeasePriority,
    ) -> Result<PageResponse, ApiError> {
        let column_id = request.field_id.or(request.relate_field_id);
        let lease_key = format!(
            "tenant:{}:page:{}:panel:{}:column:{}",
            context.tenant_id,
            metadata.page_id,
            metadata.panel_id,
            column_id.map_or_else(|| "none".to_owned(), |value| value.to_string())
        );
        let owner_token = format!("{}:{}", context.request_id, context.trace_id);
        let lease = self
            .ports
            .acquire(
                context,
                &lease_key,
                &owner_token,
                priority,
                self.refresh_ttl_millis,
            )?
            .ok_or_else(|| ApiError::refresh("refresh lease already owned", true))?;
        let target = RefreshTarget {
            page_id: metadata.page_id,
            panel_id: metadata.panel_id,
            column_id,
        };
        let primary = self
            .ports
            .append(context, "refresh.acquire")
            .and_then(|_| self.ports.sync(context, &target, &lease))
            .and_then(|_| self.ports.update_timestamp(context, &target, &lease))
            .and_then(|_| self.ports.clear_undo(context, &target, &lease))
            .and_then(|_| self.ports.reconcile(context, &target, &lease))
            .and_then(|_| self.execute_query(context, request, metadata, plan))
            .and_then(|response| {
                self.ports
                    .append(context, "refresh.query")
                    .map(|_| response)
            });
        let release = self.ports.release(context, &lease);
        let unlock = match &release {
            Ok(true) => self.ports.append(context, "refresh.unlock"),
            Ok(false) => Err(ApiError::refresh("refresh lease owner mismatch", false)),
            Err(error) => Err(error.clone()),
        };
        match primary {
            Ok(response) => {
                release?;
                unlock?;
                Ok(response)
            }
            Err(mut primary_error) => {
                if let Err(error) = release {
                    primary_error = primary_error
                        .with_compensation(format!("lease release failed: {}", error.message));
                } else if let Err(error) = unlock {
                    primary_error = primary_error
                        .with_compensation(format!("unlock evidence failed: {}", error.message));
                }
                Err(primary_error)
            }
        }
    }

    fn execute_query(
        &self,
        context: &RequestContext,
        request: &PageRequest,
        metadata: &PageMetadata,
        plan: QueryPlan,
    ) -> Result<PageResponse, ApiError> {
        let page_no = plan.page_no;
        let slice = self.ports.query(context, &plan)?;
        let data = if is_horizontal_request(request) {
            pivot_response_rows(&slice.pivot_values, metadata, &plan)?
        } else {
            slice.rows
        };
        let head_list = metadata
            .fields
            .iter()
            .map(|field| {
                BTreeMap::from([
                    ("key".to_owned(), Value::Text(field.key.clone())),
                    ("column".to_owned(), Value::Text(field.column.clone())),
                ])
            })
            .collect();
        let resp_key = metadata.table.clone();
        Ok(PageResponse {
            req_id: request.req_id.clone(),
            def_resp_key: resp_key.clone(),
            resp_data: vec![PageItem {
                req_id: request.req_id.clone(),
                resp_key,
                data,
                total: slice.total,
                page_no,
                target_layout_tag: None,
                is_record_row_num: false,
                value_sync_status_list: vec![],
            }],
            head_list,
            value_sync_status_list: vec![],
            value_sync_status_map: BTreeMap::new(),
            upload_tmp_table_name: request.upload_tmp_table_name.clone(),
            batch_id: None,
        })
    }
}

/// Source-compatible alias for integrations compiled against the former
/// page-only runtime name.
pub type PageApplication<P> = DynamicEngineApplication<P>;

fn refresh_priority(operator: Option<&str>) -> Option<LeasePriority> {
    match operator {
        Some("REFRESH") => Some(LeasePriority::Manual),
        Some("AUTO_REFRESH") => Some(LeasePriority::Automatic),
        _ => None,
    }
}

fn build_plan(
    metadata: &PageMetadata,
    query_table: &str,
    request: &PageRequest,
    page_no: u32,
    page_size: u32,
) -> Result<QueryPlan, QueryPlanError> {
    let fields = identifiers(&metadata.fields)?;
    let (mut where_predicates, having_predicates) = compile_quality(&metadata.fields, request)?;
    where_predicates.extend(compile_request_filters(metadata, request)?);
    let horizontal = is_horizontal_request(request);
    let group_by = if horizontal || !having_predicates.is_empty() {
        metadata
            .business_key
            .iter()
            .map(|key| {
                let field = metadata
                    .fields
                    .iter()
                    .find(|field| &field.key == key)
                    .ok_or_else(|| QueryPlanError::UnknownField(key.clone()))?;
                Identifier::parse(field.column.clone())
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![]
    };
    if (horizontal || !having_predicates.is_empty()) && group_by.is_empty() {
        return Err(QueryPlanError::UnknownField(
            "businessKey is required for grouped pagination".to_owned(),
        ));
    }
    let mut order_by = request
        .order_values
        .iter()
        .map(|value| {
            let (key, direction) = match value.split_once(':') {
                Some((key, direction)) => (key, parse_direction(direction)?),
                None => (value.as_str(), Direction::Ascending),
            };
            let field = metadata
                .fields
                .iter()
                .find(|field| field.key == key)
                .ok_or_else(|| QueryPlanError::UnknownField(key.to_owned()))?;
            Ok(Order {
                column: Identifier::parse(field.column.clone())?,
                direction,
            })
        })
        .collect::<Result<Vec<_>, QueryPlanError>>()?;
    for column in &group_by {
        if !order_by.iter().any(|order| order.column == *column) {
            order_by.push(Order {
                column: column.clone(),
                direction: Direction::Ascending,
            });
        }
    }
    let aggregates = metadata
        .fields
        .iter()
        .filter_map(|field| {
            field.aggregate.as_deref().map(|aggregate| {
                Ok(AggregateProjection {
                    output_key: field.key.clone(),
                    column: Identifier::parse(field.column.clone())?,
                    aggregate: Aggregate::parse(aggregate)?,
                })
            })
        })
        .collect::<Result<Vec<_>, QueryPlanError>>()?;
    let plan = QueryPlan {
        table: Identifier::parse(query_table.to_owned())?,
        fields,
        where_predicates,
        having_predicates,
        group_by,
        order_by,
        aggregates,
        page_no,
        page_size,
    };
    plan.validate()?;
    Ok(plan)
}

fn is_horizontal_request(request: &PageRequest) -> bool {
    !request.horizontal_values.is_empty()
        || !request.horizontal_key_values.is_empty()
        || !request.horizontal_data_page_tree_values.is_empty()
}

fn pivot_response_rows(
    pivots: &[PivotRow],
    metadata: &PageMetadata,
    plan: &QueryPlan,
) -> Result<Vec<Row>, ApiError> {
    pivots
        .iter()
        .map(|pivot| {
            if pivot.business_key.0.len() != plan.group_by.len() {
                return Err(ApiError::query(
                    "horizontal response business-key arity mismatch",
                    false,
                ));
            }
            let mut row = Row::new();
            for (column, value) in plan.group_by.iter().zip(&pivot.business_key.0) {
                let key = metadata
                    .fields
                    .iter()
                    .find(|field| field.column == column.as_str())
                    .map(|field| field.key.clone())
                    .ok_or_else(|| {
                        ApiError::query("horizontal response key metadata is missing", false)
                    })?;
                row.insert(key, value.clone());
            }
            for (key, result) in &pivot.values {
                if row.insert(key.clone(), result.value.clone()).is_some() {
                    return Err(ApiError::query(
                        "horizontal aggregate conflicts with business key",
                        false,
                    ));
                }
            }
            Ok(row)
        })
        .collect()
}

fn parse_direction(direction: &str) -> Result<Direction, QueryPlanError> {
    if direction.eq_ignore_ascii_case("asc") {
        Ok(Direction::Ascending)
    } else if direction.eq_ignore_ascii_case("desc") {
        Ok(Direction::Descending)
    } else {
        Err(QueryPlanError::InvalidCondition(format!(
            "unsupported order direction: {direction}"
        )))
    }
}

#[cfg(all(test, feature = "memory"))]
mod tests {
    use super::*;
    use crate::{
        adapters::memory::{FaultPoint, MemoryAdapters},
        domain::model::{FieldMetadata, Row},
        http::{
            dto::{QualityCondition, QualityOperator, QualityValue},
            handler::handle_page,
        },
    };

    fn context() -> RequestContext {
        RequestContext {
            tenant_id: 1,
            user_id: 2,
            device_id: "device".to_owned(),
            request_id: "request".to_owned(),
            trace_id: "trace".to_owned(),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        }
    }

    fn metadata() -> PageMetadata {
        PageMetadata {
            version: 1,
            page_id: 7,
            panel_id: 8,
            table: "orders".to_owned(),
            business_key: vec!["customer".to_owned()],
            fields: vec![
                FieldMetadata {
                    key: "customer".to_owned(),
                    column: "customer".to_owned(),
                    aggregate: None,
                },
                FieldMetadata {
                    key: "status".to_owned(),
                    column: "status".to_owned(),
                    aggregate: None,
                },
                FieldMetadata {
                    key: "total".to_owned(),
                    column: "amount".to_owned(),
                    aggregate: Some("SUM".to_owned()),
                },
            ],
        }
    }

    fn request(operator: Option<&str>) -> PageRequest {
        PageRequest {
            req_id: "req".to_owned(),
            operator: operator.map(str::to_owned),
            use_page_id: Some(7),
            page_no: Some(1),
            page_size: Some(20),
            ..PageRequest::default()
        }
    }

    #[test]
    fn normal_page_filters_and_returns_total() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_metadata(&context(), metadata());
        ports.insert_rows(
            &context(),
            "orders",
            vec![
                Row::from([("status".to_owned(), Value::Text("open".to_owned()))]),
                Row::from([("status".to_owned(), Value::Text("closed".to_owned()))]),
            ],
        );
        let application = PageApplication::new(ports.clone());
        let mut request = request(None);
        request
            .quality_values
            .insert("status".to_owned(), Value::Text("open".to_owned()).into());
        let (status, response) = handle_page(&application, &context(), request);
        assert_eq!(status, 200);
        assert_eq!(response.data.unwrap().resp_data[0].total, 1);
        assert!(ports.events().is_empty());
    }

    #[test]
    fn refresh_failure_releases_lease_and_preserves_primary_error() {
        let ports = Arc::new(MemoryAdapters::with_time(100));
        ports.insert_metadata(&context(), metadata());
        ports.inject_fault(FaultPoint::RefreshSync);
        let application = PageApplication::new(ports.clone());
        let error = application
            .execute(&context(), request(Some("REFRESH")))
            .unwrap_err();
        assert!(error.message.contains("RefreshSync"));
        assert_eq!(
            ports
                .events()
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["refresh.acquire", "refresh.unlock"]
        );
        ports.clear_faults();
        assert!(
            ports
                .acquire(
                    &context(),
                    "tenant:1:page:7:panel:8:column:none",
                    "next",
                    LeasePriority::Manual,
                    50,
                )
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn refresh_success_is_ordered_and_releases_lease() {
        let ports = Arc::new(MemoryAdapters::with_time(100));
        ports.insert_metadata(&context(), metadata());
        ports.insert_rows(&context(), "orders", vec![Row::new()]);
        let application = PageApplication::new(ports.clone());

        let response = application
            .execute(&context(), request(Some("REFRESH")))
            .unwrap();

        assert_eq!(response.resp_data[0].total, 1);
        assert_eq!(
            ports
                .events()
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "refresh.acquire",
                "refresh.sync",
                "refresh.timestamp",
                "refresh.undo-clear",
                "refresh.reconcile",
                "refresh.query",
                "refresh.unlock",
            ]
        );
        assert_eq!(
            ports
                .events()
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5, 6, 7]
        );
        assert!(
            ports
                .acquire(
                    &context(),
                    "tenant:1:page:7:panel:8:column:none",
                    "next",
                    LeasePriority::Manual,
                    50,
                )
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn refresh_query_failure_releases_lease_and_preserves_query_error() {
        let ports = Arc::new(MemoryAdapters::with_time(100));
        ports.insert_metadata(&context(), metadata());
        ports.inject_fault(FaultPoint::Query);
        let application = PageApplication::new(ports.clone());

        let error = application
            .execute(&context(), request(Some("REFRESH")))
            .unwrap_err();

        assert!(error.message.contains("Query"));
        assert_eq!(
            ports
                .events()
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec![
                "refresh.acquire",
                "refresh.sync",
                "refresh.timestamp",
                "refresh.undo-clear",
                "refresh.reconcile",
                "refresh.unlock",
            ]
        );
        ports.clear_faults();
        assert!(
            ports
                .acquire(
                    &context(),
                    "tenant:1:page:7:panel:8:column:none",
                    "next",
                    LeasePriority::Manual,
                    50,
                )
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn refresh_timestamp_failure_stops_later_effects_and_unlocks() {
        let ports = Arc::new(MemoryAdapters::with_time(100));
        ports.insert_metadata(&context(), metadata());
        ports.inject_fault(FaultPoint::RefreshTimestamp);
        let application = PageApplication::new(ports.clone());

        let error = application
            .execute(&context(), request(Some("REFRESH")))
            .unwrap_err();

        assert!(error.message.contains("RefreshTimestamp"));
        assert_eq!(
            ports
                .events()
                .iter()
                .map(|event| event.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["refresh.acquire", "refresh.sync", "refresh.unlock"]
        );
    }

    #[test]
    fn primary_and_release_errors_are_both_preserved() {
        let ports = Arc::new(MemoryAdapters::with_time(100));
        ports.insert_metadata(&context(), metadata());
        ports.inject_fault(FaultPoint::Query);
        ports.inject_fault(FaultPoint::LeaseRelease);
        let application = PageApplication::new(ports.clone());

        let error = application
            .execute(&context(), request(Some("REFRESH")))
            .unwrap_err();

        assert!(error.message.contains("Query"));
        assert_eq!(error.compensation_errors.len(), 1);
        assert!(error.compensation_errors[0].contains("LeaseRelease"));
        assert!(error.message_with_compensation().contains("compensation"));
        ports.clear_faults();
        assert!(
            ports
                .acquire(
                    &context(),
                    "tenant:1:page:7:panel:8:column:none",
                    "blocked",
                    LeasePriority::Manual,
                    50,
                )
                .unwrap()
                .is_none()
        );
        ports.set_time(30_101);
        assert!(
            ports
                .acquire(
                    &context(),
                    "tenant:1:page:7:panel:8:column:none",
                    "after-expiry",
                    LeasePriority::Manual,
                    50,
                )
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn undo_and_reconcile_failures_stop_the_remaining_effects() {
        for (fault, expected) in [
            (
                FaultPoint::RefreshUndoClear,
                vec![
                    "refresh.acquire",
                    "refresh.sync",
                    "refresh.timestamp",
                    "refresh.unlock",
                ],
            ),
            (
                FaultPoint::RefreshReconcile,
                vec![
                    "refresh.acquire",
                    "refresh.sync",
                    "refresh.timestamp",
                    "refresh.undo-clear",
                    "refresh.unlock",
                ],
            ),
        ] {
            let ports = Arc::new(MemoryAdapters::with_time(100));
            ports.insert_metadata(&context(), metadata());
            ports.inject_fault(fault);
            let application = PageApplication::new(ports.clone());

            assert!(
                application
                    .execute(&context(), request(Some("REFRESH")))
                    .is_err()
            );
            assert_eq!(
                ports
                    .events()
                    .iter()
                    .map(|event| event.kind.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }

    #[test]
    fn application_deduplicates_same_column_allows_other_column_and_prioritizes_manual() {
        let ports = Arc::new(MemoryAdapters::with_time(100));
        ports.insert_metadata(&context(), metadata());
        let automatic = ports
            .acquire(
                &context(),
                "tenant:1:page:7:panel:8:column:9",
                "existing-auto",
                LeasePriority::Automatic,
                50,
            )
            .unwrap()
            .unwrap();
        let application = PageApplication::new(ports.clone());
        let mut same_column_auto = request(Some("AUTO_REFRESH"));
        same_column_auto.field_id = Some(9);
        let mut other_column_auto = request(Some("AUTO_REFRESH"));
        other_column_auto.field_id = Some(10);
        let mut same_column_manual = request(Some("REFRESH"));
        same_column_manual.field_id = Some(9);

        assert!(
            application
                .execute(&context(), same_column_auto)
                .unwrap_err()
                .message
                .contains("already owned")
        );
        assert!(application.execute(&context(), other_column_auto).is_ok());
        assert!(application.execute(&context(), same_column_manual).is_ok());
        assert!(!ports.release(&context(), &automatic).unwrap());
    }

    #[test]
    fn untrusted_metadata_identifier_fails_closed() {
        let ports = Arc::new(MemoryAdapters::default());
        let mut unsafe_metadata = metadata();
        unsafe_metadata.table = "orders; DROP TABLE users".to_owned();
        ports.insert_metadata(&context(), unsafe_metadata);
        let application = PageApplication::new(ports);

        let error = application.execute(&context(), request(None)).unwrap_err();

        assert_eq!(error.http_status, 400);
        assert!(error.message.contains("InvalidIdentifier"));
    }

    #[test]
    fn child_headers_participate_in_the_query() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_metadata(&context(), metadata());
        ports.insert_child_headers(
            context().tenant_id,
            99,
            BTreeMap::from([("status".to_owned(), Value::Text("open".to_owned()))]),
        );
        ports.insert_rows(
            &context(),
            "orders",
            vec![
                Row::from([("status".to_owned(), Value::Text("open".to_owned()))]),
                Row::from([("status".to_owned(), Value::Text("closed".to_owned()))]),
            ],
        );
        let application = PageApplication::new(ports);
        let mut request = request(None);
        request.child_form_field_id = Some(99);

        let response = application.execute(&context(), request).unwrap();

        assert_eq!(response.resp_data[0].total, 1);
    }

    #[test]
    fn temporary_table_from_post_values_requires_scope_ownership() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_metadata(&context(), metadata());
        ports.insert_rows(&context(), "tmp_orders_1", vec![Row::new(), Row::new()]);
        let application = PageApplication::new(ports.clone());
        let mut request = request(None);
        request.post_values.insert(
            "uploadTmpTableName".to_owned(),
            Value::Text("tmp_orders_1".to_owned()),
        );
        request
            .post_values
            .insert("uploadTmpFlag".to_owned(), Value::Integer(1));

        let response = application.execute(&context(), request.clone()).unwrap();

        assert_eq!(
            response.upload_tmp_table_name.as_deref(),
            Some("tmp_orders_1")
        );
        assert_eq!(response.resp_data[0].total, 2);

        request.post_values.insert(
            "uploadTmpTableName".to_owned(),
            Value::Text("other_tenant_table".to_owned()),
        );
        let error = application.execute(&context(), request).unwrap_err();
        assert_eq!(error.http_status, 403);
    }

    #[test]
    fn quality_where_runs_before_having_and_total_counts_surviving_keys() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_metadata(&context(), metadata());
        ports.insert_rows(
            &context(),
            "orders",
            vec![
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("status".to_owned(), Value::Text("open".to_owned())),
                    ("amount".to_owned(), Value::Integer(60)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("status".to_owned(), Value::Text("open".to_owned())),
                    ("amount".to_owned(), Value::Integer(50)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("b".to_owned())),
                    ("status".to_owned(), Value::Text("open".to_owned())),
                    ("amount".to_owned(), Value::Integer(80)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("b".to_owned())),
                    ("status".to_owned(), Value::Text("closed".to_owned())),
                    ("amount".to_owned(), Value::Integer(50)),
                ]),
            ],
        );
        let application = PageApplication::new(ports);
        let mut request = request(None);
        request.quality_values.insert(
            "status".to_owned(),
            QualityValue::Condition(QualityCondition {
                operator: QualityOperator::In,
                value: None,
                values: vec![Value::Text("open".to_owned())],
            }),
        );
        request.quality_values.insert(
            "total".to_owned(),
            QualityValue::Condition(QualityCondition {
                operator: QualityOperator::GreaterThan,
                value: Some(Value::Integer(100)),
                values: vec![],
            }),
        );

        let response = application.execute(&context(), request).unwrap();

        assert_eq!(response.resp_data[0].total, 1);
        assert_eq!(response.resp_data[0].data.len(), 2);
        assert!(
            response.resp_data[0]
                .data
                .iter()
                .all(|row| { row["customer"] == Value::Text("a".to_owned()) })
        );
    }

    #[test]
    fn horizontal_plan_appends_business_key_order_and_aggregate_projections() {
        let mut request = request(None);
        request
            .horizontal_values
            .insert("enabled".to_owned(), Value::Boolean(true));

        let plan = build_plan(&metadata(), "orders", &request, 1, 20).unwrap();

        assert_eq!(
            plan.group_by
                .iter()
                .map(Identifier::as_str)
                .collect::<Vec<_>>(),
            vec!["customer"]
        );
        assert_eq!(
            plan.stable_order()
                .iter()
                .map(|order| order.column.as_str())
                .collect::<Vec<_>>(),
            vec!["customer"]
        );
        assert_eq!(plan.aggregates.len(), 1);
        assert_eq!(plan.aggregates[0].output_key, "total");
        assert_eq!(plan.aggregates[0].aggregate, Aggregate::Sum);
    }

    #[test]
    fn horizontal_response_returns_one_pivot_row_per_business_key() {
        let ports = Arc::new(MemoryAdapters::default());
        ports.insert_metadata(&context(), metadata());
        ports.insert_rows(
            &context(),
            "orders",
            vec![
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("amount".to_owned(), Value::Integer(40)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("amount".to_owned(), Value::Integer(60)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("b".to_owned())),
                    ("amount".to_owned(), Value::Integer(5)),
                ]),
            ],
        );
        let application = PageApplication::new(ports);
        let mut request = request(None);
        request.page_size = Some(1);
        request
            .horizontal_values
            .insert("enabled".to_owned(), Value::Boolean(true));

        let response = application.execute(&context(), request).unwrap();
        let item = &response.resp_data[0];

        assert_eq!(item.total, 2);
        assert_eq!(item.data.len(), 1);
        assert_eq!(item.data[0]["customer"], Value::Text("a".to_owned()));
        assert_eq!(item.data[0]["total"], Value::Integer(100));
    }
}
