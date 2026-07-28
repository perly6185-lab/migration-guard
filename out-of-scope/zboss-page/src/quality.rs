#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aggregate {
    Sum,
    Count,
    Average,
    Minimum,
    Maximum,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SqlValue {
    Integer(i64),
    Boolean(bool),
    Text(String),
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityField {
    pub key: String,
    pub column: String,
    pub aggregate: Option<Aggregate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityFilter {
    pub field: String,
    pub operator: Operator,
    pub values: Vec<SqlValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Predicate {
    pub field_key: String,
    pub column: String,
    pub aggregate: Option<Aggregate>,
    pub operator: Operator,
    pub binds: Vec<SqlValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QualityPlan {
    pub where_predicates: Vec<Predicate>,
    pub having_predicates: Vec<Predicate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QualityPlanError {
    UnknownField(String),
    InvalidValueCount { field: String, operator: Operator },
    NullComparison(String),
}

pub fn compile_quality_plan(
    fields: &[QualityField],
    filters: &[QualityFilter],
) -> Result<QualityPlan, QualityPlanError> {
    let mut plan = QualityPlan::default();
    for filter in filters {
        validate_filter(filter)?;
        let field = fields
            .iter()
            .find(|candidate| candidate.key == filter.field)
            .ok_or_else(|| QualityPlanError::UnknownField(filter.field.clone()))?;
        let predicate = Predicate {
            field_key: field.key.clone(),
            column: field.column.clone(),
            aggregate: field.aggregate,
            operator: filter.operator,
            binds: filter.values.clone(),
        };
        if field.aggregate.is_some() {
            plan.having_predicates.push(predicate);
        } else {
            plan.where_predicates.push(predicate);
        }
    }
    Ok(plan)
}

fn validate_filter(filter: &QualityFilter) -> Result<(), QualityPlanError> {
    let valid_count = match filter.operator {
        Operator::IsNull | Operator::IsNotNull => filter.values.is_empty(),
        Operator::In => !filter.values.is_empty(),
        _ => filter.values.len() == 1,
    };
    if !valid_count {
        return Err(QualityPlanError::InvalidValueCount {
            field: filter.field.clone(),
            operator: filter.operator,
        });
    }
    if !matches!(filter.operator, Operator::IsNull | Operator::IsNotNull)
        && filter.values.iter().any(|value| value == &SqlValue::Null)
    {
        return Err(QualityPlanError::NullComparison(filter.field.clone()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> Vec<QualityField> {
        vec![
            QualityField {
                key: "status".into(),
                column: "status_code".into(),
                aggregate: None,
            },
            QualityField {
                key: "total_amount".into(),
                column: "amount".into(),
                aggregate: Some(Aggregate::Sum),
            },
        ]
    }

    #[test]
    fn routes_ordinary_fields_to_where_and_aggregates_to_having() {
        let plan = compile_quality_plan(
            &fields(),
            &[
                QualityFilter {
                    field: "status".into(),
                    operator: Operator::Equal,
                    values: vec![SqlValue::Text("active".into())],
                },
                QualityFilter {
                    field: "total_amount".into(),
                    operator: Operator::GreaterThan,
                    values: vec![SqlValue::Integer(100)],
                },
            ],
        )
        .unwrap();
        assert_eq!(plan.where_predicates.len(), 1);
        assert_eq!(plan.having_predicates.len(), 1);
        assert_eq!(plan.where_predicates[0].column, "status_code");
        assert_eq!(plan.having_predicates[0].aggregate, Some(Aggregate::Sum));
    }

    #[test]
    fn rejects_unknown_fields_instead_of_accepting_raw_identifiers() {
        let error = compile_quality_plan(
            &fields(),
            &[QualityFilter {
                field: "amount) OR 1=1 --".into(),
                operator: Operator::Equal,
                values: vec![SqlValue::Integer(1)],
            }],
        )
        .unwrap_err();
        assert!(matches!(error, QualityPlanError::UnknownField(_)));
    }

    #[test]
    fn null_operators_do_not_create_fake_binds() {
        let plan = compile_quality_plan(
            &fields(),
            &[QualityFilter {
                field: "status".into(),
                operator: Operator::IsNull,
                values: vec![],
            }],
        )
        .unwrap();
        assert!(plan.where_predicates[0].binds.is_empty());
        assert!(matches!(
            compile_quality_plan(
                &fields(),
                &[QualityFilter {
                    field: "status".into(),
                    operator: Operator::Equal,
                    values: vec![SqlValue::Null],
                }]
            ),
            Err(QualityPlanError::NullComparison(_))
        ));
    }
}
