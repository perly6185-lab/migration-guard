use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize, de::Error as DeError};
use sha2::{Digest, Sha256};

use crate::domain::model::{BusinessKey, FieldMetadata, Value};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Identifier(String);

impl Identifier {
    pub fn parse(value: impl Into<String>) -> Result<Self, QueryPlanError> {
        let value = value.into();
        if value.is_empty() || !value.split('.').all(valid_identifier_part) {
            return Err(QueryPlanError::InvalidIdentifier(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn quoted(&self) -> String {
        self.0
            .split('.')
            .map(|part| format!("`{part}`"))
            .collect::<Vec<_>>()
            .join(".")
    }
}

impl<'de> Deserialize<'de> for Identifier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(|error| D::Error::custom(format!("{error:?}")))
    }
}

fn valid_identifier_part(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(first) if first == '_' || first.is_ascii_alphabetic())
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Aggregate {
    Sum,
    Count,
    Average,
    Minimum,
    Maximum,
}

impl Aggregate {
    pub fn parse(value: &str) -> Result<Self, QueryPlanError> {
        match value.to_ascii_uppercase().as_str() {
            "SUM" => Ok(Self::Sum),
            "COUNT" => Ok(Self::Count),
            "AVG" | "AVERAGE" => Ok(Self::Average),
            "MIN" | "MINIMUM" => Ok(Self::Minimum),
            "MAX" | "MAXIMUM" => Ok(Self::Maximum),
            _ => Err(QueryPlanError::UnknownAggregate(value.to_owned())),
        }
    }

    fn sql(self) -> &'static str {
        match self {
            Self::Sum => "SUM",
            Self::Count => "COUNT",
            Self::Average => "AVG",
            Self::Minimum => "MIN",
            Self::Maximum => "MAX",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Operator {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    In,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Expression {
    pub column: Identifier,
    pub aggregate: Option<Aggregate>,
}

impl Expression {
    fn sql(&self) -> String {
        match self.aggregate {
            Some(aggregate) => format!("{}({})", aggregate.sql(), self.column.quoted()),
            None => self.column.quoted(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Predicate {
    pub expression: Expression,
    pub operator: Operator,
    pub values: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Order {
    pub column: Identifier,
    pub direction: Direction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AggregateProjection {
    pub output_key: String,
    pub column: Identifier,
    pub aggregate: Aggregate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryPlan {
    pub table: Identifier,
    pub fields: Vec<Identifier>,
    pub where_predicates: Vec<Predicate>,
    pub having_predicates: Vec<Predicate>,
    pub group_by: Vec<Identifier>,
    pub order_by: Vec<Order>,
    pub aggregates: Vec<AggregateProjection>,
    pub page_no: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundStatement {
    pub sql: String,
    pub binds: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedQuery {
    pub data: BoundStatement,
    pub count: BoundStatement,
    pub table_identity: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryPlanError {
    InvalidIdentifier(String),
    UnknownField(String),
    UnknownAggregate(String),
    InvalidValueCount(String),
    InvalidCondition(String),
    ConflictingValue(String),
    EmptyProjection,
    InvalidPage,
}

impl QueryPlan {
    pub fn validate(&self) -> Result<(), QueryPlanError> {
        if self.page_no == 0 || self.page_size == 0 {
            return Err(QueryPlanError::InvalidPage);
        }
        if self.fields.is_empty() {
            return Err(QueryPlanError::EmptyProjection);
        }
        let fields = self
            .fields
            .iter()
            .map(Identifier::as_str)
            .collect::<BTreeSet<_>>();
        for predicate in self
            .where_predicates
            .iter()
            .chain(self.having_predicates.iter())
        {
            if !fields.contains(predicate.expression.column.as_str()) {
                return Err(QueryPlanError::UnknownField(
                    predicate.expression.column.as_str().to_owned(),
                ));
            }
            validate_predicate(predicate)?;
        }
        for column in self
            .group_by
            .iter()
            .chain(self.order_by.iter().map(|o| &o.column))
        {
            if !fields.contains(column.as_str()) {
                return Err(QueryPlanError::UnknownField(column.as_str().to_owned()));
            }
        }
        if !self.group_by.is_empty()
            && self
                .order_by
                .iter()
                .any(|order| !self.group_by.contains(&order.column))
        {
            return Err(QueryPlanError::InvalidCondition(
                "grouped ordering must use business-key columns".to_owned(),
            ));
        }
        let mut aggregate_output_keys = BTreeSet::new();
        for projection in &self.aggregates {
            if projection.output_key.trim().is_empty() {
                return Err(QueryPlanError::InvalidCondition(
                    "aggregate output key is empty".to_owned(),
                ));
            }
            if !fields.contains(projection.column.as_str()) {
                return Err(QueryPlanError::UnknownField(
                    projection.column.as_str().to_owned(),
                ));
            }
            if !aggregate_output_keys.insert(projection.output_key.as_str()) {
                return Err(QueryPlanError::ConflictingValue(format!(
                    "aggregate output key: {}",
                    projection.output_key
                )));
            }
        }
        if self
            .where_predicates
            .iter()
            .any(|predicate| predicate.expression.aggregate.is_some())
        {
            return Err(QueryPlanError::InvalidValueCount(
                "aggregate predicate cannot be in WHERE".to_owned(),
            ));
        }
        if self
            .having_predicates
            .iter()
            .any(|predicate| predicate.expression.aggregate.is_none())
        {
            return Err(QueryPlanError::InvalidValueCount(
                "ordinary predicate cannot be in HAVING".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn render(&self) -> Result<RenderedQuery, QueryPlanError> {
        self.validate()?;
        let selection_columns = if self.group_by.is_empty() {
            &self.fields
        } else {
            &self.group_by
        };
        let selection = selection_columns
            .iter()
            .map(Identifier::quoted)
            .collect::<Vec<_>>()
            .join(", ");
        let mut data_binds = Vec::new();
        let data_clauses = render_clauses(self, &mut data_binds, true);
        let offset = (self.page_no - 1) as u64 * self.page_size as u64;
        let data_sql = format!(
            "SELECT {selection} FROM {}{data_clauses} LIMIT {} OFFSET {offset}",
            self.table.quoted(),
            self.page_size
        );

        let mut count_binds = Vec::new();
        let count_sql = if self.group_by.is_empty() && self.having_predicates.is_empty() {
            let count_clauses = render_where(self, &mut count_binds);
            format!(
                "SELECT COUNT(*) FROM {}{count_clauses}",
                self.table.quoted()
            )
        } else {
            let count_clauses = render_clauses(self, &mut count_binds, false);
            format!(
                "SELECT COUNT(*) FROM (SELECT 1 FROM {}{count_clauses}) AS `mg_count`",
                self.table.quoted()
            )
        };
        if data_binds != count_binds {
            return Err(QueryPlanError::InvalidCondition(
                "data/count bind lineage diverged".to_owned(),
            ));
        }
        let canonical_plan = serde_json::to_vec(self).map_err(|error| {
            QueryPlanError::InvalidCondition(format!("query plan canonicalization failed: {error}"))
        })?;
        let fingerprint = format!("sha256:{}", sha256_hex(&canonical_plan));
        Ok(RenderedQuery {
            data: BoundStatement {
                sql: data_sql,
                binds: data_binds,
            },
            count: BoundStatement {
                sql: count_sql,
                binds: count_binds,
            },
            table_identity: self.table.as_str().to_owned(),
            fingerprint,
        })
    }

    pub fn render_cell_query(
        &self,
        page_keys: &[BusinessKey],
    ) -> Result<BoundStatement, QueryPlanError> {
        self.validate()?;
        if self.group_by.is_empty() {
            return Err(QueryPlanError::InvalidCondition(
                "cell query requires grouped business keys".to_owned(),
            ));
        }
        if page_keys.is_empty() {
            return Err(QueryPlanError::InvalidCondition(
                "cell query requires at least one business key".to_owned(),
            ));
        }
        let mut binds = Vec::new();
        let mut clauses = render_where(self, &mut binds);
        let key_predicate = page_keys
            .iter()
            .map(|key| {
                if key.0.len() != self.group_by.len() {
                    return Err(QueryPlanError::InvalidValueCount(
                        "business key arity".to_owned(),
                    ));
                }
                Ok(format!(
                    "({})",
                    self.group_by
                        .iter()
                        .zip(&key.0)
                        .map(|(column, value)| {
                            if value == &Value::Null {
                                format!("{} IS NULL", column.quoted())
                            } else {
                                binds.push(value.clone());
                                format!("{} = ?", column.quoted())
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" AND ")
                ))
            })
            .collect::<Result<Vec<_>, QueryPlanError>>()?
            .join(" OR ");
        if clauses.is_empty() {
            clauses.push_str(" WHERE ");
        } else {
            clauses.push_str(" AND ");
        }
        clauses.push('(');
        clauses.push_str(&key_predicate);
        clauses.push(')');
        append_order(self, &mut clauses);
        let selection = self
            .fields
            .iter()
            .map(Identifier::quoted)
            .collect::<Vec<_>>()
            .join(", ");
        Ok(BoundStatement {
            sql: format!("SELECT {selection} FROM {}{clauses}", self.table.quoted()),
            binds,
        })
    }

    pub fn stable_order(&self) -> Vec<Order> {
        let mut order = self.order_by.clone();
        for column in &self.group_by {
            if !order.iter().any(|item| item.column == *column) {
                order.push(Order {
                    column: column.clone(),
                    direction: Direction::Ascending,
                });
            }
        }
        order
    }
}

fn render_clauses(plan: &QueryPlan, binds: &mut Vec<Value>, include_order: bool) -> String {
    let mut result = render_where(plan, binds);
    if !plan.group_by.is_empty() {
        result.push_str(" GROUP BY ");
        result.push_str(
            &plan
                .group_by
                .iter()
                .map(Identifier::quoted)
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    if !plan.having_predicates.is_empty() {
        result.push_str(" HAVING ");
        result.push_str(&render_predicates(&plan.having_predicates, binds));
    }
    if include_order {
        append_order(plan, &mut result);
    }
    result
}

fn append_order(plan: &QueryPlan, result: &mut String) {
    let order_by = plan.stable_order();
    if !order_by.is_empty() {
        result.push_str(" ORDER BY ");
        result.push_str(
            &order_by
                .iter()
                .map(|order| {
                    format!(
                        "{} {}",
                        order.column.quoted(),
                        match order.direction {
                            Direction::Ascending => "ASC",
                            Direction::Descending => "DESC",
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
}

fn sha256_hex(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn render_where(plan: &QueryPlan, binds: &mut Vec<Value>) -> String {
    if plan.where_predicates.is_empty() {
        String::new()
    } else {
        format!(
            " WHERE {}",
            render_predicates(&plan.where_predicates, binds)
        )
    }
}

fn render_predicates(predicates: &[Predicate], binds: &mut Vec<Value>) -> String {
    predicates
        .iter()
        .map(|predicate| {
            let expression = predicate.expression.sql();
            match predicate.operator {
                Operator::IsNull => format!("{expression} IS NULL"),
                Operator::IsNotNull => format!("{expression} IS NOT NULL"),
                Operator::In => {
                    binds.extend(predicate.values.clone());
                    format!(
                        "{expression} IN ({})",
                        vec!["?"; predicate.values.len()].join(", ")
                    )
                }
                operator => {
                    binds.extend(predicate.values.clone());
                    let symbol = match operator {
                        Operator::Equal => "=",
                        Operator::NotEqual => "<>",
                        Operator::GreaterThan => ">",
                        Operator::GreaterThanOrEqual => ">=",
                        Operator::LessThan => "<",
                        Operator::LessThanOrEqual => "<=",
                        _ => unreachable!(),
                    };
                    format!("{expression} {symbol} ?")
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub(crate) fn validate_predicate(predicate: &Predicate) -> Result<(), QueryPlanError> {
    let valid = match predicate.operator {
        Operator::IsNull | Operator::IsNotNull => predicate.values.is_empty(),
        Operator::In => {
            !predicate.values.is_empty()
                && predicate.values.iter().all(|value| value != &Value::Null)
        }
        _ => predicate.values.len() == 1 && predicate.values[0] != Value::Null,
    };
    if valid {
        Ok(())
    } else {
        Err(QueryPlanError::InvalidValueCount(
            predicate.expression.column.as_str().to_owned(),
        ))
    }
}

pub fn identifiers(metadata: &[FieldMetadata]) -> Result<Vec<Identifier>, QueryPlanError> {
    metadata
        .iter()
        .map(|field| Identifier::parse(field.column.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: &str) -> Identifier {
        Identifier::parse(value).unwrap()
    }

    #[test]
    fn renderer_binds_values_and_separates_where_having() {
        let plan = QueryPlan {
            table: id("orders"),
            fields: vec![id("status"), id("amount")],
            where_predicates: vec![Predicate {
                expression: Expression {
                    column: id("status"),
                    aggregate: None,
                },
                operator: Operator::Equal,
                values: vec![Value::Text("open".to_owned())],
            }],
            having_predicates: vec![Predicate {
                expression: Expression {
                    column: id("amount"),
                    aggregate: Some(Aggregate::Sum),
                },
                operator: Operator::GreaterThan,
                values: vec![Value::Integer(100)],
            }],
            group_by: vec![id("status")],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 20,
        };
        let rendered = plan.render().unwrap();
        assert!(rendered.data.sql.contains("WHERE `status` = ?"));
        assert!(rendered.data.sql.contains("HAVING SUM(`amount`) > ?"));
        assert!(rendered.count.sql.contains("HAVING SUM(`amount`) > ?"));
        assert_eq!(rendered.data.binds.len(), 2);
        assert_eq!(rendered.data.binds, rendered.count.binds);
        assert!(!rendered.count.sql.contains("ORDER BY"));
        assert!(rendered.fingerprint.starts_with("sha256:"));
        assert_eq!(rendered.fingerprint.len(), 71);
        assert_eq!(rendered.table_identity, "orders");
        assert!(!rendered.data.sql.contains("open"));
        assert!(!rendered.count.sql.contains("open"));
    }

    #[test]
    fn rejects_untrusted_identifiers() {
        assert!(Identifier::parse("orders; DROP TABLE users").is_err());
        assert!(Identifier::parse("tenant.orders").is_ok());
        assert!(serde_json::from_str::<Identifier>(r#""orders; DROP TABLE users""#).is_err());
    }

    #[test]
    fn fingerprint_is_stable_and_covers_bound_values() {
        let plan = QueryPlan {
            table: id("orders"),
            fields: vec![id("status")],
            where_predicates: vec![Predicate {
                expression: Expression {
                    column: id("status"),
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
        let first = plan.render().unwrap();
        let second = plan.render().unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);

        let mut changed = plan;
        changed.where_predicates[0].values = vec![Value::Text("closed".to_owned())];
        assert_ne!(first.fingerprint, changed.render().unwrap().fingerprint);
    }

    #[test]
    fn grouped_plan_renders_stable_keys_then_exact_cell_retrieval() {
        let plan = QueryPlan {
            table: id("orders"),
            fields: vec![id("tenant_id"), id("customer"), id("status"), id("amount")],
            where_predicates: vec![Predicate {
                expression: Expression {
                    column: id("status"),
                    aggregate: None,
                },
                operator: Operator::Equal,
                values: vec![Value::Text("open".to_owned())],
            }],
            having_predicates: vec![Predicate {
                expression: Expression {
                    column: id("amount"),
                    aggregate: Some(Aggregate::Sum),
                },
                operator: Operator::GreaterThan,
                values: vec![Value::Integer(100)],
            }],
            group_by: vec![id("tenant_id"), id("customer")],
            order_by: vec![],
            aggregates: vec![AggregateProjection {
                output_key: "total".to_owned(),
                column: id("amount"),
                aggregate: Aggregate::Sum,
            }],
            page_no: 1,
            page_size: 20,
        };

        let key_query = plan.render().unwrap();
        assert!(
            key_query
                .data
                .sql
                .starts_with("SELECT `tenant_id`, `customer` FROM")
        );
        assert!(
            key_query
                .data
                .sql
                .contains("ORDER BY `tenant_id` ASC, `customer` ASC")
        );
        let attack = "a' OR 1=1 --".to_owned();
        let cell_query = plan
            .render_cell_query(&[
                BusinessKey(vec![Value::Integer(1), Value::Null]),
                BusinessKey(vec![Value::Integer(1), Value::Text(attack.clone())]),
            ])
            .unwrap();

        assert!(cell_query.sql.contains("WHERE `status` = ? AND"));
        assert!(
            cell_query
                .sql
                .contains("(`tenant_id` = ? AND `customer` IS NULL)")
        );
        assert!(
            cell_query
                .sql
                .contains("(`tenant_id` = ? AND `customer` = ?)")
        );
        assert!(!cell_query.sql.contains("HAVING"));
        assert!(!cell_query.sql.contains("GROUP BY"));
        assert!(!cell_query.sql.contains(&attack));
        assert_eq!(
            cell_query.binds,
            vec![
                Value::Text("open".to_owned()),
                Value::Integer(1),
                Value::Integer(1),
                Value::Text(attack),
            ]
        );
        assert!(
            plan.render_cell_query(&[BusinessKey(vec![Value::Integer(1)])])
                .is_err()
        );
    }

    #[test]
    fn every_operator_is_rendered_with_the_expected_bind_contract() {
        let status = id("status");
        let predicate = |operator, values| Predicate {
            expression: Expression {
                column: status.clone(),
                aggregate: None,
            },
            operator,
            values,
        };
        let plan = QueryPlan {
            table: id("orders"),
            fields: vec![status.clone()],
            where_predicates: vec![
                predicate(Operator::Equal, vec![Value::Text("=value".to_owned())]),
                predicate(Operator::NotEqual, vec![Value::Text("<>value".to_owned())]),
                predicate(Operator::GreaterThan, vec![Value::Integer(1)]),
                predicate(Operator::GreaterThanOrEqual, vec![Value::Integer(2)]),
                predicate(Operator::LessThan, vec![Value::Integer(3)]),
                predicate(Operator::LessThanOrEqual, vec![Value::Integer(4)]),
                predicate(
                    Operator::In,
                    vec![
                        Value::Text("first".to_owned()),
                        Value::Text("second".to_owned()),
                    ],
                ),
                predicate(Operator::IsNull, vec![]),
                predicate(Operator::IsNotNull, vec![]),
            ],
            having_predicates: vec![],
            group_by: vec![],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 20,
        };

        let rendered = plan.render().unwrap();

        for fragment in [
            "`status` = ?",
            "`status` <> ?",
            "`status` > ?",
            "`status` >= ?",
            "`status` < ?",
            "`status` <= ?",
            "`status` IN (?, ?)",
            "`status` IS NULL",
            "`status` IS NOT NULL",
        ] {
            assert!(rendered.data.sql.contains(fragment), "{fragment}");
            assert!(rendered.count.sql.contains(fragment), "{fragment}");
        }
        assert_eq!(rendered.data.binds.len(), 8);
        assert_eq!(rendered.data.binds, rendered.count.binds);
        assert!(!rendered.data.binds.contains(&Value::Null));
        assert!(!rendered.data.sql.contains("first"));
    }

    #[test]
    fn invalid_value_arity_and_aggregate_layer_fail_closed() {
        let status = id("status");
        let invalid_in = QueryPlan {
            table: id("orders"),
            fields: vec![status.clone()],
            where_predicates: vec![Predicate {
                expression: Expression {
                    column: status.clone(),
                    aggregate: None,
                },
                operator: Operator::In,
                values: vec![],
            }],
            having_predicates: vec![],
            group_by: vec![],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 20,
        };
        assert!(invalid_in.render().is_err());

        let mut aggregate_in_where = invalid_in;
        aggregate_in_where.where_predicates[0].operator = Operator::Equal;
        aggregate_in_where.where_predicates[0].values = vec![Value::Integer(1)];
        aggregate_in_where.where_predicates[0].expression.aggregate = Some(Aggregate::Count);
        assert!(aggregate_in_where.render().is_err());

        let empty_projection = QueryPlan {
            table: id("orders"),
            fields: vec![],
            where_predicates: vec![],
            having_predicates: vec![],
            group_by: vec![],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 20,
        };
        assert_eq!(
            empty_projection.render(),
            Err(QueryPlanError::EmptyProjection)
        );
    }
}
