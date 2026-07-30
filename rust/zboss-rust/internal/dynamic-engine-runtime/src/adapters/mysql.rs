use crate::{
    domain::{
        context::RequestContext,
        horizontal::{aggregate_pivots, validate_exact_cells},
        model::{BusinessKey, PageLineage, PageSlice, Row},
        query::{BoundStatement, QueryPlan},
    },
    http::error::ApiError,
    ports::query::PageQueryPort,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlAdapterConfig {
    pub url_env: String,
}

impl Default for MysqlAdapterConfig {
    fn default() -> Self {
        Self {
            url_env: "ZBOSS_PAGE_MYSQL_URL".to_owned(),
        }
    }
}

impl MysqlAdapterConfig {
    pub fn is_configured(&self) -> bool {
        std::env::var(&self.url_env).is_ok_and(|value| !value.trim().is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlTableIdentity {
    pub tenant_id: u64,
    pub datasource: String,
    pub snapshot_id: String,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlPageStatements {
    pub data: BoundStatement,
    pub count: BoundStatement,
    pub table_identity: MysqlTableIdentity,
    pub query_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlPageResult {
    pub total: u64,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlKeyPageResult {
    pub total: u64,
    pub page_keys: Vec<BusinessKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MysqlCellStatement {
    pub statement: BoundStatement,
    pub table_identity: MysqlTableIdentity,
    pub query_fingerprint: String,
}

pub trait MysqlStatementExecutor: Send + Sync {
    fn execute_flat_page(
        &self,
        context: &RequestContext,
        statements: &MysqlPageStatements,
    ) -> Result<MysqlPageResult, ApiError>;

    fn execute_key_page(
        &self,
        context: &RequestContext,
        statements: &MysqlPageStatements,
    ) -> Result<MysqlKeyPageResult, ApiError>;

    fn execute_cells(
        &self,
        context: &RequestContext,
        statement: &MysqlCellStatement,
    ) -> Result<Vec<Row>, ApiError>;
}

#[derive(Debug)]
pub struct MysqlPageQueryAdapter<E> {
    executor: E,
}

impl<E> MysqlPageQueryAdapter<E> {
    pub const fn new(executor: E) -> Self {
        Self { executor }
    }
}

impl<E: MysqlStatementExecutor> PageQueryPort for MysqlPageQueryAdapter<E> {
    fn query(&self, context: &RequestContext, plan: &QueryPlan) -> Result<PageSlice, ApiError> {
        context.validate().map_err(ApiError::context)?;
        let rendered = plan
            .render()
            .map_err(|error| ApiError::query(format!("invalid query plan: {error:?}"), false))?;
        let statements = MysqlPageStatements {
            data: rendered.data,
            count: rendered.count,
            table_identity: MysqlTableIdentity {
                tenant_id: context.tenant_id,
                datasource: context.datasource.clone(),
                snapshot_id: context.snapshot_id.clone(),
                table: rendered.table_identity,
            },
            query_fingerprint: rendered.fingerprint,
        };
        let lineage = PageLineage::unified(&statements.query_fingerprint);
        if plan.group_by.is_empty() {
            let result = self.executor.execute_flat_page(context, &statements)?;
            Ok(PageSlice {
                rows: result.rows,
                total: result.total,
                page_keys: vec![],
                pivot_values: vec![],
                lineage,
                query_fingerprint: statements.query_fingerprint,
            })
        } else {
            let key_page = self.executor.execute_key_page(context, &statements)?;
            let rows = if key_page.page_keys.is_empty() {
                vec![]
            } else {
                let cell_statement = MysqlCellStatement {
                    statement: plan
                        .render_cell_query(&key_page.page_keys)
                        .map_err(|error| {
                            ApiError::query(
                                format!("invalid horizontal cell query: {error:?}"),
                                false,
                            )
                        })?,
                    table_identity: statements.table_identity.clone(),
                    query_fingerprint: statements.query_fingerprint.clone(),
                };
                self.executor.execute_cells(context, &cell_statement)?
            };
            let key_columns = plan
                .group_by
                .iter()
                .map(|column| column.as_str().to_owned())
                .collect::<Vec<_>>();
            validate_exact_cells(&rows, &key_columns, &key_page.page_keys).map_err(|error| {
                ApiError::query(format!("horizontal cell key mismatch: {error:?}"), false)
            })?;
            let pivot_values =
                aggregate_pivots(&rows, &key_columns, &plan.aggregates).map_err(|error| {
                    ApiError::query(format!("horizontal aggregate failed: {error:?}"), false)
                })?;
            Ok(PageSlice {
                rows,
                total: key_page.total,
                page_keys: key_page.page_keys,
                pivot_values,
                lineage,
                query_fingerprint: statements.query_fingerprint,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::domain::{
        model::Value,
        query::{Expression, Identifier, Operator, Predicate},
    };

    #[derive(Debug, Default)]
    struct RecordingExecutor {
        calls: Mutex<Vec<MysqlPageStatements>>,
        cell_calls: Mutex<Vec<MysqlCellStatement>>,
        key_result: Mutex<Option<MysqlKeyPageResult>>,
        cell_rows: Mutex<Vec<Row>>,
    }

    impl MysqlStatementExecutor for RecordingExecutor {
        fn execute_flat_page(
            &self,
            _context: &RequestContext,
            statements: &MysqlPageStatements,
        ) -> Result<MysqlPageResult, ApiError> {
            self.calls.lock().unwrap().push(statements.clone());
            Ok(MysqlPageResult {
                total: 1,
                rows: vec![Row::new()],
            })
        }

        fn execute_key_page(
            &self,
            _context: &RequestContext,
            statements: &MysqlPageStatements,
        ) -> Result<MysqlKeyPageResult, ApiError> {
            self.calls.lock().unwrap().push(statements.clone());
            self.key_result
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| ApiError::query("missing key-page fixture", false))
        }

        fn execute_cells(
            &self,
            _context: &RequestContext,
            statement: &MysqlCellStatement,
        ) -> Result<Vec<Row>, ApiError> {
            self.cell_calls.lock().unwrap().push(statement.clone());
            Ok(self.cell_rows.lock().unwrap().clone())
        }
    }

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

    #[test]
    fn adapter_consumes_only_rendered_bound_statements() {
        let executor = RecordingExecutor::default();
        let adapter = MysqlPageQueryAdapter::new(executor);
        let status = Identifier::parse("status").unwrap();
        let plan = QueryPlan {
            table: Identifier::parse("orders").unwrap(),
            fields: vec![status.clone()],
            where_predicates: vec![Predicate {
                expression: Expression {
                    column: status,
                    aggregate: None,
                },
                operator: Operator::Equal,
                values: vec![Value::Text("open".to_owned())],
            }],
            having_predicates: vec![],
            group_by: vec![],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 20,
        };

        let page = adapter.query(&context(), &plan).unwrap();
        let calls = adapter.executor.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(page.query_fingerprint, calls[0].query_fingerprint);
        assert_eq!(calls[0].data.binds, calls[0].count.binds);
        assert_eq!(calls[0].table_identity.tenant_id, 1);
        assert_eq!(calls[0].table_identity.datasource, "primary");
        assert_eq!(calls[0].table_identity.snapshot_id, "snapshot");
        assert_eq!(calls[0].table_identity.table, "orders");
        assert!(!calls[0].data.sql.contains("open"));
        assert!(!calls[0].count.sql.contains("open"));
    }

    #[test]
    fn grouped_adapter_executes_keys_then_exact_cells_with_one_lineage() {
        let executor = RecordingExecutor {
            key_result: Mutex::new(Some(MysqlKeyPageResult {
                total: 1,
                page_keys: vec![BusinessKey(vec![Value::Text("a".to_owned())])],
            })),
            cell_rows: Mutex::new(vec![
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("amount".to_owned(), Value::Integer(40)),
                ]),
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    ("amount".to_owned(), Value::Integer(60)),
                ]),
            ]),
            ..RecordingExecutor::default()
        };
        let adapter = MysqlPageQueryAdapter::new(executor);
        let customer = Identifier::parse("customer").unwrap();
        let amount = Identifier::parse("amount").unwrap();
        let plan = QueryPlan {
            table: Identifier::parse("orders").unwrap(),
            fields: vec![customer.clone(), amount.clone()],
            where_predicates: vec![],
            having_predicates: vec![],
            group_by: vec![customer],
            order_by: vec![],
            aggregates: vec![crate::domain::query::AggregateProjection {
                output_key: "total".to_owned(),
                column: amount,
                aggregate: crate::domain::query::Aggregate::Sum,
            }],
            page_no: 1,
            page_size: 20,
        };

        let page = adapter.query(&context(), &plan).unwrap();

        assert_eq!(adapter.executor.calls.lock().unwrap().len(), 1);
        let cell_calls = adapter.executor.cell_calls.lock().unwrap();
        assert_eq!(cell_calls.len(), 1);
        assert!(
            cell_calls[0]
                .statement
                .sql
                .contains("WHERE ((`customer` = ?))")
        );
        assert_eq!(
            cell_calls[0].statement.binds,
            vec![Value::Text("a".to_owned())]
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.pivot_values[0].values["total"].sum, Some(100));
        assert!(page.lineage.is_unified());
        assert_eq!(page.lineage.page_keys, page.query_fingerprint);
        assert_eq!(cell_calls[0].query_fingerprint, page.query_fingerprint);
    }
}
