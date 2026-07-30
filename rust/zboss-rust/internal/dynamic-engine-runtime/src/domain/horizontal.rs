use std::collections::{BTreeMap, BTreeSet};

use crate::domain::{
    model::{AggregateResult, BusinessKey, PivotRow, Row, Value},
    query::{Aggregate, AggregateProjection},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HorizontalError {
    IntegerOverflow,
    NonIntegerAggregate(String),
    MixedAggregateTypes(String),
    DuplicateOutputKey(String),
    UnexpectedCellKey(BusinessKey),
    MissingCellKey(BusinessKey),
    DuplicatePageKey(BusinessKey),
}

pub fn validate_exact_cells(
    rows: &[Row],
    key_columns: &[String],
    page_keys: &[BusinessKey],
) -> Result<(), HorizontalError> {
    let selected = page_keys.iter().cloned().collect::<BTreeSet<_>>();
    if selected.len() != page_keys.len() {
        let mut seen = BTreeSet::new();
        let duplicate = page_keys
            .iter()
            .find(|key| !seen.insert((*key).clone()))
            .expect("duplicate key must exist")
            .clone();
        return Err(HorizontalError::DuplicatePageKey(duplicate));
    }
    let mut found = BTreeSet::new();
    for row in rows {
        let key = BusinessKey(
            key_columns
                .iter()
                .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                .collect(),
        );
        if !selected.contains(&key) {
            return Err(HorizontalError::UnexpectedCellKey(key));
        }
        found.insert(key);
    }
    if let Some(missing) = selected.difference(&found).next() {
        return Err(HorizontalError::MissingCellKey(missing.clone()));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalPage {
    pub total: u64,
    pub page_keys: Vec<BusinessKey>,
    pub rows: Vec<Row>,
}

pub fn paginate_distinct_keys(
    rows: &[Row],
    key_columns: &[String],
    page_no: u32,
    page_size: u32,
) -> HorizontalPage {
    let keys = rows
        .iter()
        .map(|row| {
            BusinessKey(
                key_columns
                    .iter()
                    .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                    .collect(),
            )
        })
        .fold(
            (BTreeSet::new(), Vec::new()),
            |(mut seen, mut ordered), key| {
                if seen.insert(key.clone()) {
                    ordered.push(key);
                }
                (seen, ordered)
            },
        )
        .1;
    let offset = page_no.saturating_sub(1) as usize * page_size as usize;
    let total = keys.len() as u64;
    let page_keys = keys
        .into_iter()
        .skip(offset)
        .take(page_size as usize)
        .collect::<Vec<_>>();
    let selected = page_keys.iter().cloned().collect::<BTreeSet<_>>();
    let rows = rows
        .iter()
        .filter(|row| {
            selected.contains(&BusinessKey(
                key_columns
                    .iter()
                    .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                    .collect(),
            ))
        })
        .cloned()
        .collect();
    HorizontalPage {
        total,
        page_keys,
        rows,
    }
}

pub fn group_rows(rows: &[Row], key_columns: &[String]) -> BTreeMap<BusinessKey, Vec<Row>> {
    let mut groups = BTreeMap::new();
    for row in rows {
        let key = BusinessKey(
            key_columns
                .iter()
                .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                .collect(),
        );
        groups.entry(key).or_insert_with(Vec::new).push(row.clone());
    }
    groups
}

pub fn aggregate_pivots(
    rows: &[Row],
    key_columns: &[String],
    projections: &[AggregateProjection],
) -> Result<Vec<PivotRow>, HorizontalError> {
    let groups = group_rows(rows, key_columns);
    groups
        .into_iter()
        .map(|(business_key, rows)| {
            let mut values = BTreeMap::new();
            for projection in projections {
                if values.contains_key(&projection.output_key) {
                    return Err(HorizontalError::DuplicateOutputKey(
                        projection.output_key.clone(),
                    ));
                }
                let mut accumulator = AggregateAccumulator::new(projection.aggregate);
                for chunk in rows.chunks(64) {
                    let mut partial = AggregateAccumulator::new(projection.aggregate);
                    for row in chunk {
                        partial.add(
                            row.get(projection.column.as_str()).unwrap_or(&Value::Null),
                            &projection.output_key,
                        )?;
                    }
                    accumulator.merge(&partial, &projection.output_key)?;
                }
                values.insert(projection.output_key.clone(), accumulator.finish()?);
            }
            Ok(PivotRow {
                business_key,
                values,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AggregateAccumulator {
    Sum(Option<i64>),
    Count(u64),
    Average { sum: i64, count: u64 },
    Minimum(Option<Value>),
    Maximum(Option<Value>),
}

impl AggregateAccumulator {
    fn new(aggregate: Aggregate) -> Self {
        match aggregate {
            Aggregate::Sum => Self::Sum(None),
            Aggregate::Count => Self::Count(0),
            Aggregate::Average => Self::Average { sum: 0, count: 0 },
            Aggregate::Minimum => Self::Minimum(None),
            Aggregate::Maximum => Self::Maximum(None),
        }
    }

    fn add(&mut self, value: &Value, key: &str) -> Result<(), HorizontalError> {
        match self {
            Self::Sum(sum) => {
                if let Some(value) = integer_value(value, key)? {
                    *sum = Some(
                        sum.unwrap_or(0)
                            .checked_add(value)
                            .ok_or(HorizontalError::IntegerOverflow)?,
                    );
                }
            }
            Self::Count(count) => {
                if value != &Value::Null {
                    *count = count
                        .checked_add(1)
                        .ok_or(HorizontalError::IntegerOverflow)?;
                }
            }
            Self::Average { sum, count } => {
                if let Some(value) = integer_value(value, key)? {
                    *sum = sum
                        .checked_add(value)
                        .ok_or(HorizontalError::IntegerOverflow)?;
                    *count = count
                        .checked_add(1)
                        .ok_or(HorizontalError::IntegerOverflow)?;
                }
            }
            Self::Minimum(selected) => select_extreme(selected, value, false, key)?,
            Self::Maximum(selected) => select_extreme(selected, value, true, key)?,
        }
        Ok(())
    }

    fn merge(&mut self, other: &Self, key: &str) -> Result<(), HorizontalError> {
        match (self, other) {
            (Self::Sum(left), Self::Sum(right)) => {
                if let Some(right) = right {
                    *left = Some(
                        left.unwrap_or(0)
                            .checked_add(*right)
                            .ok_or(HorizontalError::IntegerOverflow)?,
                    );
                }
            }
            (
                Self::Average {
                    sum: left_sum,
                    count: left_count,
                },
                Self::Average {
                    sum: right_sum,
                    count: right_count,
                },
            ) => {
                *left_sum = left_sum
                    .checked_add(*right_sum)
                    .ok_or(HorizontalError::IntegerOverflow)?;
                *left_count = left_count
                    .checked_add(*right_count)
                    .ok_or(HorizontalError::IntegerOverflow)?;
            }
            (Self::Count(left), Self::Count(right)) => {
                *left = left
                    .checked_add(*right)
                    .ok_or(HorizontalError::IntegerOverflow)?;
            }
            (Self::Minimum(left), Self::Minimum(right)) => {
                if let Some(right) = right {
                    select_extreme(left, right, false, key)?;
                }
            }
            (Self::Maximum(left), Self::Maximum(right)) => {
                if let Some(right) = right {
                    select_extreme(left, right, true, key)?;
                }
            }
            _ => return Err(HorizontalError::MixedAggregateTypes(key.to_owned())),
        }
        Ok(())
    }

    fn finish(self) -> Result<AggregateResult, HorizontalError> {
        match self {
            Self::Sum(sum) => Ok(AggregateResult {
                kind: "SUM".to_owned(),
                value: sum.map(Value::Integer).unwrap_or(Value::Null),
                sum,
                count: None,
            }),
            Self::Count(count) => Ok(AggregateResult {
                kind: "COUNT".to_owned(),
                value: Value::Integer(
                    i64::try_from(count).map_err(|_| HorizontalError::IntegerOverflow)?,
                ),
                sum: None,
                count: Some(count),
            }),
            Self::Average { sum, count } => Ok(AggregateResult {
                kind: "AVG".to_owned(),
                value: if count == 0 {
                    Value::Null
                } else {
                    Value::Integer(
                        sum / i64::try_from(count).map_err(|_| HorizontalError::IntegerOverflow)?,
                    )
                },
                sum: Some(sum),
                count: Some(count),
            }),
            Self::Minimum(value) => Ok(AggregateResult {
                kind: "MIN".to_owned(),
                value: value.unwrap_or(Value::Null),
                sum: None,
                count: None,
            }),
            Self::Maximum(value) => Ok(AggregateResult {
                kind: "MAX".to_owned(),
                value: value.unwrap_or(Value::Null),
                sum: None,
                count: None,
            }),
        }
    }
}

fn integer_value(value: &Value, key: &str) -> Result<Option<i64>, HorizontalError> {
    match value {
        Value::Null => Ok(None),
        Value::Integer(value) => Ok(Some(*value)),
        _ => Err(HorizontalError::NonIntegerAggregate(key.to_owned())),
    }
}

fn select_extreme(
    selected: &mut Option<Value>,
    candidate: &Value,
    maximum: bool,
    key: &str,
) -> Result<(), HorizontalError> {
    if candidate == &Value::Null {
        return Ok(());
    }
    let Some(current) = selected else {
        *selected = Some(candidate.clone());
        return Ok(());
    };
    let ordering = match (&*current, candidate) {
        (Value::Boolean(left), Value::Boolean(right)) => left.cmp(right),
        (Value::Integer(left), Value::Integer(right)) => left.cmp(right),
        (Value::Text(left), Value::Text(right)) => left.cmp(right),
        _ => return Err(HorizontalError::MixedAggregateTypes(key.to_owned())),
    };
    if (maximum && ordering.is_lt()) || (!maximum && ordering.is_gt()) {
        *current = candidate.clone();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::query::Identifier;

    #[test]
    fn pages_distinct_typed_keys_without_splitting_cells() {
        let rows = [("a", 1), ("a", 2), ("b", 1), ("c", 1)]
            .into_iter()
            .map(|(key, cell)| {
                BTreeMap::from([
                    ("key".to_owned(), Value::Text(key.to_owned())),
                    ("cell".to_owned(), Value::Integer(cell)),
                ])
            })
            .collect::<Vec<_>>();
        let page = paginate_distinct_keys(&rows, &["key".to_owned()], 1, 2);
        assert_eq!(page.total, 3);
        assert_eq!(page.page_keys.len(), 2);
        assert_eq!(page.rows.len(), 3);
    }

    #[test]
    fn composite_keys_are_type_null_and_delimiter_safe() {
        let rows = [
            (Value::Null, Value::Text("x".to_owned())),
            (Value::Text("null".to_owned()), Value::Text("x".to_owned())),
            (Value::Integer(1), Value::Text("x".to_owned())),
            (Value::Text("1".to_owned()), Value::Text("x".to_owned())),
            (Value::Text("a|b".to_owned()), Value::Text("c".to_owned())),
            (Value::Text("a".to_owned()), Value::Text("b|c".to_owned())),
        ]
        .into_iter()
        .map(|(first, second)| {
            Row::from([("first".to_owned(), first), ("second".to_owned(), second)])
        })
        .collect::<Vec<_>>();

        let page = paginate_distinct_keys(&rows, &["first".to_owned(), "second".to_owned()], 1, 20);

        assert_eq!(page.total, 6);
        assert_eq!(page.page_keys.len(), 6);
        assert_eq!(
            page.page_keys
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>()
                .len(),
            6
        );
    }

    #[test]
    fn stable_key_pages_have_no_duplicates_or_omissions() {
        let rows = ["a", "a", "b", "c", "c", "d"]
            .into_iter()
            .map(|key| Row::from([("customer".to_owned(), Value::Text(key.to_owned()))]))
            .collect::<Vec<_>>();
        let columns = ["customer".to_owned()];
        let pages = (1..=3)
            .flat_map(|page_no| paginate_distinct_keys(&rows, &columns, page_no, 2).page_keys)
            .collect::<Vec<_>>();

        assert_eq!(pages.len(), 4);
        assert_eq!(pages.iter().cloned().collect::<BTreeSet<_>>().len(), 4);
        assert_eq!(
            pages,
            ["a", "b", "c", "d"]
                .into_iter()
                .map(|key| BusinessKey(vec![Value::Text(key.to_owned())]))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn aggregate_pivots_keep_full_average_accumulators_across_chunks() {
        let rows = (0..65)
            .map(|index| {
                Row::from([
                    ("customer".to_owned(), Value::Text("a".to_owned())),
                    (
                        "amount".to_owned(),
                        Value::Integer(if index == 64 { 6_400 } else { 0 }),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        let amount = Identifier::parse("amount").unwrap();
        let projections = [
            (Aggregate::Sum, "sum"),
            (Aggregate::Count, "count"),
            (Aggregate::Average, "average"),
            (Aggregate::Minimum, "minimum"),
            (Aggregate::Maximum, "maximum"),
        ]
        .into_iter()
        .map(|(aggregate, output_key)| AggregateProjection {
            output_key: output_key.to_owned(),
            column: amount.clone(),
            aggregate,
        })
        .collect::<Vec<_>>();

        let pivots = aggregate_pivots(&rows, &["customer".to_owned()], &projections).unwrap();
        let values = &pivots[0].values;

        assert_eq!(values["sum"].value, Value::Integer(6_400));
        assert_eq!(values["count"].value, Value::Integer(65));
        assert_eq!(values["average"].sum, Some(6_400));
        assert_eq!(values["average"].count, Some(65));
        assert_eq!(values["average"].value, Value::Integer(98));
        assert_eq!(values["minimum"].value, Value::Integer(0));
        assert_eq!(values["maximum"].value, Value::Integer(6_400));
    }

    #[test]
    fn exact_cell_validation_rejects_missing_extra_and_duplicate_keys() {
        let key = |value: &str| BusinessKey(vec![Value::Text(value.to_owned())]);
        let rows = vec![Row::from([(
            "customer".to_owned(),
            Value::Text("a".to_owned()),
        )])];
        assert!(validate_exact_cells(&rows, &["customer".to_owned()], &[key("a")]).is_ok());
        assert!(validate_exact_cells(&rows, &["customer".to_owned()], &[key("b")]).is_err());
        assert!(
            validate_exact_cells(&rows, &["customer".to_owned()], &[key("a"), key("b")]).is_err()
        );
        assert!(
            validate_exact_cells(&rows, &["customer".to_owned()], &[key("a"), key("a")]).is_err()
        );
    }
}
