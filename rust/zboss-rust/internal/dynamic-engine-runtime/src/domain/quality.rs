use crate::{
    domain::{
        model::{FieldMetadata, Value},
        query::{Aggregate, Expression, Identifier, Operator, Predicate, QueryPlanError},
    },
    http::dto::{PageRequest, QualityCondition, QualityOperator, QualityValue},
};

pub fn compile_quality(
    metadata: &[FieldMetadata],
    request: &PageRequest,
) -> Result<(Vec<Predicate>, Vec<Predicate>), QueryPlanError> {
    let mut where_predicates = Vec::new();
    let mut having_predicates = Vec::new();
    for (key, input) in &request.quality_values {
        let field = metadata
            .iter()
            .find(|field| &field.key == key)
            .ok_or_else(|| QueryPlanError::UnknownField(key.clone()))?;
        let aggregate = field
            .aggregate
            .as_deref()
            .map(Aggregate::parse)
            .transpose()?;
        let (operator, values) = compile_input(input)?;
        let predicate = Predicate {
            expression: Expression {
                column: Identifier::parse(field.column.clone())?,
                aggregate,
            },
            operator,
            values,
        };
        crate::domain::query::validate_predicate(&predicate)?;
        if aggregate.is_some() {
            having_predicates.push(predicate);
        } else {
            where_predicates.push(predicate);
        }
    }
    Ok((where_predicates, having_predicates))
}

fn compile_input(input: &QualityValue) -> Result<(Operator, Vec<Value>), QueryPlanError> {
    match input {
        QualityValue::Scalar(Value::Null) => Ok((Operator::IsNull, vec![])),
        QualityValue::Scalar(value) => Ok((Operator::Equal, vec![value.clone()])),
        QualityValue::Condition(condition) => compile_condition(condition),
    }
}

fn compile_condition(
    condition: &QualityCondition,
) -> Result<(Operator, Vec<Value>), QueryPlanError> {
    if condition.value.is_some() && !condition.values.is_empty() {
        return Err(QueryPlanError::ConflictingValue(
            "quality condition value/values".to_owned(),
        ));
    }
    let values = condition
        .value
        .iter()
        .cloned()
        .chain(condition.values.iter().cloned())
        .collect();
    let operator = match condition.operator {
        QualityOperator::Equal => Operator::Equal,
        QualityOperator::NotEqual => Operator::NotEqual,
        QualityOperator::GreaterThan => Operator::GreaterThan,
        QualityOperator::GreaterThanOrEqual => Operator::GreaterThanOrEqual,
        QualityOperator::LessThan => Operator::LessThan,
        QualityOperator::LessThanOrEqual => Operator::LessThanOrEqual,
        QualityOperator::In => Operator::In,
        QualityOperator::IsNull => Operator::IsNull,
        QualityOperator::IsNotNull => Operator::IsNotNull,
    };
    Ok((operator, values))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_quality_is_routed_to_having() {
        let metadata = vec![
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
        ];
        let mut request = PageRequest::default();
        request
            .quality_values
            .insert("status".to_owned(), Value::Text("open".to_owned()).into());
        request
            .quality_values
            .insert("total".to_owned(), Value::Integer(100).into());
        let (where_predicates, having_predicates) = compile_quality(&metadata, &request).unwrap();
        assert_eq!(where_predicates.len(), 1);
        assert_eq!(having_predicates.len(), 1);
    }

    #[test]
    fn typed_operators_preserve_layer_and_value_contracts() {
        let metadata = vec![
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
        ];
        let mut request = PageRequest::default();
        request.quality_values.insert(
            "status".to_owned(),
            QualityValue::Condition(QualityCondition {
                operator: QualityOperator::In,
                value: None,
                values: vec![
                    Value::Text("open".to_owned()),
                    Value::Text("pending".to_owned()),
                ],
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

        let (where_predicates, having_predicates) = compile_quality(&metadata, &request).unwrap();

        assert_eq!(where_predicates[0].operator, Operator::In);
        assert_eq!(where_predicates[0].values.len(), 2);
        assert_eq!(having_predicates[0].operator, Operator::GreaterThan);
        assert_eq!(
            having_predicates[0].expression.aggregate,
            Some(Aggregate::Sum)
        );
    }

    #[test]
    fn empty_conflicting_null_and_unknown_conditions_fail_closed() {
        let metadata = vec![FieldMetadata {
            key: "status".to_owned(),
            column: "status".to_owned(),
            aggregate: None,
        }];
        let condition = |operator, value, values| {
            QualityValue::Condition(QualityCondition {
                operator,
                value,
                values,
            })
        };
        for input in [
            condition(QualityOperator::In, None, vec![]),
            condition(
                QualityOperator::Equal,
                Some(Value::Text("open".to_owned())),
                vec![Value::Text("closed".to_owned())],
            ),
            condition(
                QualityOperator::In,
                None,
                vec![Value::Text("open".to_owned()), Value::Null],
            ),
            condition(QualityOperator::GreaterThan, Some(Value::Null), vec![]),
        ] {
            let mut request = PageRequest::default();
            request.quality_values.insert("status".to_owned(), input);
            assert!(compile_quality(&metadata, &request).is_err());
        }

        let mut request = PageRequest::default();
        request
            .quality_values
            .insert("unknown".to_owned(), Value::Integer(1).into());
        assert!(compile_quality(&metadata, &request).is_err());
    }

    #[test]
    fn null_operators_create_no_bind_values_in_where_or_having() {
        let metadata = vec![
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
        ];
        let mut request = PageRequest::default();
        request.quality_values.insert(
            "status".to_owned(),
            QualityValue::Condition(QualityCondition {
                operator: QualityOperator::IsNotNull,
                value: None,
                values: vec![],
            }),
        );
        request.quality_values.insert(
            "total".to_owned(),
            QualityValue::Condition(QualityCondition {
                operator: QualityOperator::IsNull,
                value: None,
                values: vec![],
            }),
        );
        let (where_predicates, having_predicates) = compile_quality(&metadata, &request).unwrap();
        let plan = crate::domain::query::QueryPlan {
            table: Identifier::parse("orders").unwrap(),
            fields: vec![
                Identifier::parse("status").unwrap(),
                Identifier::parse("amount").unwrap(),
            ],
            where_predicates,
            having_predicates,
            group_by: vec![Identifier::parse("status").unwrap()],
            order_by: vec![],
            aggregates: vec![],
            page_no: 1,
            page_size: 20,
        };

        let rendered = plan.render().unwrap();

        assert!(rendered.data.sql.contains("`status` IS NOT NULL"));
        assert!(rendered.data.sql.contains("SUM(`amount`) IS NULL"));
        assert!(rendered.count.sql.contains("SUM(`amount`) IS NULL"));
        assert!(rendered.data.binds.is_empty());
        assert!(rendered.count.binds.is_empty());
    }
}
