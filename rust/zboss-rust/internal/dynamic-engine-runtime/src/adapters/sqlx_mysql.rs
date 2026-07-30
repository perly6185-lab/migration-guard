use std::{
    collections::{BTreeMap, BTreeSet},
    sync::mpsc::{self, Sender},
    thread,
    time::Duration,
};

use sqlx::{
    Column, MySql, MySqlPool, Row as SqlxRow, TypeInfo, ValueRef,
    mysql::{MySqlPoolOptions, MySqlRow},
};

use crate::{
    adapters::mysql::{
        MysqlCellStatement, MysqlKeyPageResult, MysqlPageResult, MysqlPageStatements,
        MysqlStatementExecutor,
    },
    domain::{
        context::RequestContext,
        model::{BusinessKey, HorizontalQuery, HorizontalSlice, Row, Value},
        query::{BoundStatement, Identifier},
    },
    http::error::ApiError,
    ports::horizontal::MysqlHorizontalQueryExecutor,
};

type MysqlResult<T> = Result<T, ApiError>;

struct MysqlPageData {
    rows: Vec<Row>,
    page_keys: Vec<BusinessKey>,
    total: u64,
}

enum MysqlWork {
    Page {
        data: BoundStatement,
        count: BoundStatement,
        key_page: bool,
        reply: Sender<MysqlResult<MysqlPageData>>,
    },
    Rows {
        statement: BoundStatement,
        reply: Sender<MysqlResult<Vec<Row>>>,
    },
}

#[derive(Debug, Clone)]
pub struct SqlxMysqlStatementExecutor {
    sender: Sender<MysqlWork>,
}

impl SqlxMysqlStatementExecutor {
    pub fn connect(database_url: &str, maximum_connections: u32) -> Result<Self, String> {
        if !database_url.starts_with("mysql://") {
            return Err("ZBOSS_PAGE_MYSQL_URL must use mysql://".to_owned());
        }
        if maximum_connections == 0 {
            return Err("MySQL maximum connections must be greater than zero".to_owned());
        }
        let (work_sender, work_receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let database_url = database_url.to_owned();
        thread::Builder::new()
            .name("zboss-dynamic-engine-mysql".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready_sender.send(Err(format!("create MySQL runtime: {error}")));
                        return;
                    }
                };
                let pool = runtime.block_on(
                    MySqlPoolOptions::new()
                        .max_connections(maximum_connections)
                        .acquire_timeout(Duration::from_secs(5))
                        .connect(&database_url),
                );
                let pool = match pool {
                    Ok(pool) => {
                        let _ = ready_sender.send(Ok(()));
                        pool
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(format!("connect MySQL: {error}")));
                        return;
                    }
                };
                while let Ok(work) = work_receiver.recv() {
                    match work {
                        MysqlWork::Page {
                            data,
                            count,
                            key_page,
                            reply,
                        } => {
                            let result =
                                runtime.block_on(execute_page(&pool, &data, &count, key_page));
                            let _ = reply.send(result);
                        }
                        MysqlWork::Rows { statement, reply } => {
                            let result = runtime.block_on(execute_rows(&pool, &statement));
                            let _ = reply.send(result);
                        }
                    }
                }
            })
            .map_err(|error| format!("start MySQL worker: {error}"))?;
        ready_receiver
            .recv()
            .map_err(|_| "MySQL worker stopped during startup".to_owned())??;
        Ok(Self {
            sender: work_sender,
        })
    }

    fn execute_page(
        &self,
        data: BoundStatement,
        count: BoundStatement,
        key_page: bool,
    ) -> MysqlResult<MysqlPageData> {
        let (reply, result) = mpsc::channel();
        self.sender
            .send(MysqlWork::Page {
                data,
                count,
                key_page,
                reply,
            })
            .map_err(|_| ApiError::query("MySQL worker is unavailable", true))?;
        result
            .recv()
            .map_err(|_| ApiError::query("MySQL worker stopped before replying", true))?
    }

    fn execute_rows(&self, statement: BoundStatement) -> MysqlResult<Vec<Row>> {
        let (reply, result) = mpsc::channel();
        self.sender
            .send(MysqlWork::Rows { statement, reply })
            .map_err(|_| ApiError::query("MySQL worker is unavailable", true))?;
        result
            .recv()
            .map_err(|_| ApiError::query("MySQL worker stopped before replying", true))?
    }
}

impl MysqlStatementExecutor for SqlxMysqlStatementExecutor {
    fn execute_flat_page(
        &self,
        context: &RequestContext,
        statements: &MysqlPageStatements,
    ) -> MysqlResult<MysqlPageResult> {
        validate_identity(context, statements)?;
        let result = self.execute_page(statements.data.clone(), statements.count.clone(), false)?;
        Ok(MysqlPageResult {
            total: result.total,
            rows: result.rows,
        })
    }

    fn execute_key_page(
        &self,
        context: &RequestContext,
        statements: &MysqlPageStatements,
    ) -> MysqlResult<MysqlKeyPageResult> {
        validate_identity(context, statements)?;
        let result = self.execute_page(statements.data.clone(), statements.count.clone(), true)?;
        Ok(MysqlKeyPageResult {
            total: result.total,
            page_keys: result.page_keys,
        })
    }

    fn execute_cells(
        &self,
        context: &RequestContext,
        statement: &MysqlCellStatement,
    ) -> MysqlResult<Vec<Row>> {
        if statement.table_identity.tenant_id != context.tenant_id
            || statement.table_identity.datasource != context.datasource
            || statement.table_identity.snapshot_id != context.snapshot_id
        {
            return Err(ApiError::context("MySQL cell query scope mismatch"));
        }
        self.execute_rows(statement.statement.clone())
    }
}

fn validate_identity(
    context: &RequestContext,
    statements: &MysqlPageStatements,
) -> MysqlResult<()> {
    if statements.table_identity.tenant_id != context.tenant_id
        || statements.table_identity.datasource != context.datasource
        || statements.table_identity.snapshot_id != context.snapshot_id
    {
        Err(ApiError::context("MySQL page query scope mismatch"))
    } else {
        Ok(())
    }
}

async fn execute_page(
    pool: &MySqlPool,
    data: &BoundStatement,
    count: &BoundStatement,
    key_page: bool,
) -> MysqlResult<MysqlPageData> {
    let raw_rows = bind_query(data)
        .fetch_all(pool)
        .await
        .map_err(mysql_error)?;
    let rows = if key_page {
        vec![]
    } else {
        raw_rows
            .iter()
            .map(decode_row)
            .collect::<MysqlResult<_>>()?
    };
    let page_keys = if key_page {
        raw_rows
            .iter()
            .map(|row| {
                (0..row.columns().len())
                    .map(|index| decode_value(row, index))
                    .collect::<MysqlResult<Vec<_>>>()
                    .map(BusinessKey)
            })
            .collect::<MysqlResult<_>>()?
    } else {
        vec![]
    };
    let count_row = bind_query(count)
        .fetch_one(pool)
        .await
        .map_err(mysql_error)?;
    let total = count_row
        .try_get::<u64, _>(0)
        .or_else(|_| {
            count_row.try_get::<i64, _>(0).and_then(|value| {
                u64::try_from(value).map_err(|error| sqlx::Error::Decode(Box::new(error)))
            })
        })
        .map_err(mysql_error)?;
    Ok(MysqlPageData {
        rows,
        page_keys,
        total,
    })
}

async fn execute_rows(pool: &MySqlPool, statement: &BoundStatement) -> MysqlResult<Vec<Row>> {
    bind_query(statement)
        .fetch_all(pool)
        .await
        .map_err(mysql_error)?
        .iter()
        .map(decode_row)
        .collect()
}

fn bind_query<'a>(
    statement: &'a BoundStatement,
) -> sqlx::query::Query<'a, MySql, sqlx::mysql::MySqlArguments> {
    let mut query = sqlx::query(&statement.sql);
    for value in &statement.binds {
        query = match value {
            Value::Null => query.bind(Option::<String>::None),
            Value::Boolean(value) => query.bind(*value),
            Value::Integer(value) => query.bind(*value),
            Value::Text(value) => query.bind(value),
        };
    }
    query
}

fn decode_row(row: &MySqlRow) -> MysqlResult<Row> {
    row.columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            decode_value(row, index).map(|value| (column.name().to_owned(), value))
        })
        .collect()
}

fn decode_value(row: &MySqlRow, index: usize) -> MysqlResult<Value> {
    let raw = row.try_get_raw(index).map_err(mysql_error)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    let type_name = raw.type_info().name().to_ascii_uppercase();
    if type_name == "BOOLEAN" || type_name == "BOOL" {
        return row
            .try_get::<bool, _>(index)
            .map(Value::Boolean)
            .map_err(mysql_error);
    }
    if [
        "TINYINT",
        "SMALLINT",
        "MEDIUMINT",
        "INT",
        "INTEGER",
        "BIGINT",
        "YEAR",
    ]
    .contains(&type_name.as_str())
    {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Ok(Value::Integer(value));
        }
        if let Ok(value) = row.try_get::<u64, _>(index) {
            return i64::try_from(value)
                .map(Value::Integer)
                .or_else(|_| Ok(Value::Text(value.to_string())));
        }
    }
    row.try_get::<String, _>(index)
        .map(Value::Text)
        .map_err(mysql_error)
}

fn mysql_error(error: sqlx::Error) -> ApiError {
    let retryable = matches!(
        error,
        sqlx::Error::Io(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed
    );
    ApiError::query(format!("MySQL execution failed: {error}"), retryable)
}

#[derive(Debug, Clone)]
pub struct HorizontalTableSchema {
    pub table: Identifier,
    pub fields: BTreeMap<String, Identifier>,
    pub archived_field: Option<Identifier>,
}

impl HorizontalTableSchema {
    pub fn new(
        table: impl Into<String>,
        fields: BTreeMap<String, String>,
        archived_field: Option<String>,
    ) -> Result<Self, String> {
        let table =
            Identifier::parse(table.into()).map_err(|error| format!("invalid table: {error:?}"))?;
        let fields = fields
            .into_iter()
            .map(|(logical, physical)| {
                if logical.trim().is_empty() {
                    return Err("horizontal logical field is empty".to_owned());
                }
                Identifier::parse(physical)
                    .map(|physical| (logical, physical))
                    .map_err(|error| format!("invalid horizontal field: {error:?}"))
            })
            .collect::<Result<_, _>>()?;
        let archived_field = archived_field
            .map(Identifier::parse)
            .transpose()
            .map_err(|error| format!("invalid archived field: {error:?}"))?;
        Ok(Self {
            table,
            fields,
            archived_field,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SqlxMysqlHorizontalQueryExecutor {
    statements: SqlxMysqlStatementExecutor,
    catalog: BTreeMap<u64, HorizontalTableSchema>,
}

impl SqlxMysqlHorizontalQueryExecutor {
    pub const fn new(
        statements: SqlxMysqlStatementExecutor,
        catalog: BTreeMap<u64, HorizontalTableSchema>,
    ) -> Self {
        Self {
            statements,
            catalog,
        }
    }
}

impl MysqlHorizontalQueryExecutor for SqlxMysqlHorizontalQueryExecutor {
    fn execute_horizontal(
        &self,
        context: &RequestContext,
        query: &HorizontalQuery,
    ) -> MysqlResult<HorizontalSlice> {
        context.validate().map_err(ApiError::context)?;
        let schema = self
            .catalog
            .get(&query.horizontal_id)
            .ok_or_else(|| ApiError::context("horizontal source is not configured"))?;
        let selected = if query.selected_fields.is_empty() {
            schema.fields.keys().cloned().collect::<Vec<_>>()
        } else {
            query.selected_fields.clone()
        };
        let mut physical_seen = BTreeSet::new();
        let projections = selected
            .iter()
            .map(|logical| {
                schema
                    .fields
                    .get(logical)
                    .filter(|physical| physical_seen.insert(physical.as_str().to_owned()))
                    .map(|physical| (logical, physical))
                    .ok_or_else(|| {
                        ApiError::validation(format!("unknown horizontal field: {logical}"))
                    })
            })
            .collect::<MysqlResult<Vec<_>>>()?;
        if projections.is_empty() {
            return Err(ApiError::validation(
                "horizontal projection cannot be empty",
            ));
        }
        let where_clause = if !query.show_archived {
            schema
                .archived_field
                .as_ref()
                .map_or_else(String::new, |field| format!(" WHERE {} = ?", quote(field)))
        } else {
            String::new()
        };
        let binds = if where_clause.is_empty() {
            vec![]
        } else {
            vec![Value::Boolean(false)]
        };
        let order = query
            .order
            .iter()
            .map(|order| {
                schema
                    .fields
                    .get(&order.field_name)
                    .map(|field| {
                        format!(
                            "{} {}",
                            quote(field),
                            if order.ascending { "ASC" } else { "DESC" }
                        )
                    })
                    .ok_or_else(|| {
                        ApiError::validation(format!(
                            "unknown horizontal order field: {}",
                            order.field_name
                        ))
                    })
            })
            .collect::<MysqlResult<Vec<_>>>()?;
        let order_clause = if order.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", order.join(", "))
        };
        let offset = u64::from(query.page_no.saturating_sub(1)) * u64::from(query.page_size);
        let data = BoundStatement {
            sql: format!(
                "SELECT {} FROM {}{where_clause}{order_clause} LIMIT {} OFFSET {offset}",
                projections
                    .iter()
                    .map(|(_, field)| quote(field))
                    .collect::<Vec<_>>()
                    .join(", "),
                quote(&schema.table),
                query.page_size
            ),
            binds: binds.clone(),
        };
        let count = BoundStatement {
            sql: format!(
                "SELECT COUNT(*) FROM {}{where_clause}",
                quote(&schema.table)
            ),
            binds,
        };
        let result = self.statements.execute_page(data, count, false)?;
        let rows = result
            .rows
            .into_iter()
            .map(|row| {
                projections
                    .iter()
                    .filter_map(|(logical, physical)| {
                        row.get(physical.as_str())
                            .cloned()
                            .map(|value| ((*logical).clone(), value))
                    })
                    .collect()
            })
            .collect();
        Ok(HorizontalSlice {
            rows,
            total: result.total,
        })
    }
}

fn quote(identifier: &Identifier) -> String {
    identifier
        .as_str()
        .split('.')
        .map(|segment| format!("`{segment}`"))
        .collect::<Vec<_>>()
        .join(".")
}

#[derive(Debug, Clone)]
pub struct MysqlHorizontalListAdapter<E> {
    executor: E,
}

impl<E> MysqlHorizontalListAdapter<E> {
    pub const fn new(executor: E) -> Self {
        Self { executor }
    }
}

impl<E: MysqlHorizontalQueryExecutor> crate::ports::horizontal::HorizontalListPort
    for MysqlHorizontalListAdapter<E>
{
    fn list_horizontal(
        &self,
        context: &RequestContext,
        query: &HorizontalQuery,
    ) -> MysqlResult<HorizontalSlice> {
        self.executor.execute_horizontal(context, query)
    }
}
