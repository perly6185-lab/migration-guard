use crate::{
    domain::{
        model::{FieldMetadata, PageMetadata, Value},
        query::{Expression, Identifier, Operator, Predicate, QueryPlanError},
    },
    http::dto::PageRequest,
};

pub fn compile_request_filters(
    metadata: &PageMetadata,
    request: &PageRequest,
) -> Result<Vec<Predicate>, QueryPlanError> {
    let mut values = request.header_values.clone();
    for (key, value) in &request.select_values {
        if matches!(value, Value::Text(marker) if marker == key) {
            continue;
        }
        values.entry(key.clone()).or_insert_with(|| value.clone());
    }

    let mut predicates = values
        .into_iter()
        .map(|(key, value)| predicate_for_key(&metadata.fields, &key, value))
        .collect::<Result<Vec<_>, _>>()?;

    if let Some(primary_key) = primary_key(request)? {
        let key = metadata.business_key.first().ok_or_else(|| {
            QueryPlanError::InvalidCondition(
                "primary-key filter requires businessKey metadata".to_owned(),
            )
        })?;
        let value = i64::try_from(primary_key).map_err(|_| {
            QueryPlanError::InvalidCondition("primary-key value exceeds signed 64-bit".to_owned())
        })?;
        predicates.push(predicate_for_key(
            &metadata.fields,
            key,
            Value::Integer(value),
        )?);
    }

    if request.show_archived != Some(true)
        && let Some(field) = metadata
            .fields
            .iter()
            .find(|field| field.key.eq_ignore_ascii_case("archived"))
    {
        predicates.push(predicate_for_field(field, Value::Boolean(false))?);
    }

    if let Some(condition) = request
        .layout_global_condition
        .as_deref()
        .filter(|condition| !condition.trim().is_empty())
    {
        predicates.extend(parse_layout_condition(&metadata.fields, condition)?);
    }

    Ok(predicates)
}

fn primary_key(request: &PageRequest) -> Result<Option<u64>, QueryPlanError> {
    match (request.primary_key_id, request.locate_primary_key_id) {
        (Some(primary), Some(locate)) if primary != locate => Err(
            QueryPlanError::ConflictingValue("primaryKeyId/locatePrimaryKeyId".to_owned()),
        ),
        (Some(primary), _) => Ok(Some(primary)),
        (_, Some(locate)) => Ok(Some(locate)),
        _ => Ok(None),
    }
}

fn predicate_for_key(
    fields: &[FieldMetadata],
    key: &str,
    value: Value,
) -> Result<Predicate, QueryPlanError> {
    let field = fields
        .iter()
        .find(|field| field.key == key)
        .ok_or_else(|| QueryPlanError::UnknownField(key.to_owned()))?;
    if field.aggregate.is_some() {
        return Err(QueryPlanError::InvalidCondition(format!(
            "{key} cannot be used as a row filter"
        )));
    }
    predicate_for_field(field, value)
}

fn predicate_for_field(field: &FieldMetadata, value: Value) -> Result<Predicate, QueryPlanError> {
    let is_null = value == Value::Null;
    Ok(Predicate {
        expression: Expression {
            column: Identifier::parse(field.column.clone())?,
            aggregate: None,
        },
        operator: if is_null {
            Operator::IsNull
        } else {
            Operator::Equal
        },
        values: if is_null { vec![] } else { vec![value] },
    })
}

fn parse_layout_condition(
    fields: &[FieldMetadata],
    condition: &str,
) -> Result<Vec<Predicate>, QueryPlanError> {
    condition
        .split(" AND ")
        .map(str::trim)
        .map(|clause| {
            if let Some(key) = clause.strip_suffix(" IS NULL") {
                return predicate_for_key(fields, key.trim(), Value::Null);
            }
            let (key, literal) = clause.split_once('=').ok_or_else(|| {
                QueryPlanError::InvalidCondition(
                    "layoutGlobalCondition accepts only field=value or field IS NULL joined by AND"
                        .to_owned(),
                )
            })?;
            predicate_for_key(fields, key.trim(), parse_literal(literal.trim())?)
        })
        .collect()
}

fn parse_literal(literal: &str) -> Result<Value, QueryPlanError> {
    if literal.eq_ignore_ascii_case("null") {
        return Ok(Value::Null);
    }
    if literal.eq_ignore_ascii_case("true") {
        return Ok(Value::Boolean(true));
    }
    if literal.eq_ignore_ascii_case("false") {
        return Ok(Value::Boolean(false));
    }
    if let Ok(value) = literal.parse::<i64>() {
        return Ok(Value::Integer(value));
    }
    if literal.len() >= 2 && literal.starts_with('\'') && literal.ends_with('\'') {
        return Ok(Value::Text(
            literal[1..literal.len() - 1].replace("''", "'"),
        ));
    }
    Err(QueryPlanError::InvalidCondition(
        "layoutGlobalCondition text values must be single-quoted".to_owned(),
    ))
}

pub fn upload_parameters(
    request: &PageRequest,
) -> Result<(Option<String>, Option<i32>), QueryPlanError> {
    let post_table = request
        .post_values
        .get("uploadTmpTableName")
        .and_then(|value| match value {
            Value::Text(value) => Some(value.clone()),
            _ => None,
        });
    let post_flag = request
        .post_values
        .get("uploadTmpFlag")
        .and_then(|value| match value {
            Value::Integer(value) => i32::try_from(*value).ok(),
            _ => None,
        });
    let table = merge_value(
        request.upload_tmp_table_name.clone(),
        post_table,
        "uploadTmpTableName",
    )?;
    let flag = merge_value(request.upload_tmp_flag, post_flag, "uploadTmpFlag")?;
    if flag.is_some_and(|value| value != 0) && table.is_none() {
        return Err(QueryPlanError::InvalidCondition(
            "uploadTmpFlag requires uploadTmpTableName".to_owned(),
        ));
    }
    Ok((table, flag))
}

fn merge_value<T: Eq>(
    explicit: Option<T>,
    post: Option<T>,
    name: &str,
) -> Result<Option<T>, QueryPlanError> {
    match (explicit, post) {
        (Some(explicit), Some(post)) if explicit != post => {
            Err(QueryPlanError::ConflictingValue(name.to_owned()))
        }
        (Some(explicit), _) => Ok(Some(explicit)),
        (_, post) => Ok(post),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> PageMetadata {
        PageMetadata {
            version: 1,
            page_id: 7,
            panel_id: 8,
            table: "orders".to_owned(),
            business_key: vec!["id".to_owned()],
            fields: vec![
                FieldMetadata {
                    key: "id".to_owned(),
                    column: "order_id".to_owned(),
                    aggregate: None,
                },
                FieldMetadata {
                    key: "status".to_owned(),
                    column: "status".to_owned(),
                    aggregate: None,
                },
            ],
        }
    }

    #[test]
    fn header_wins_over_mobile_select_fallback() {
        let mut request = PageRequest::default();
        request
            .header_values
            .insert("status".to_owned(), Value::Text("header".to_owned()));
        request
            .select_values
            .insert("status".to_owned(), Value::Text("mobile".to_owned()));
        let predicates = compile_request_filters(&metadata(), &request).unwrap();
        assert_eq!(predicates[0].values, vec![Value::Text("header".to_owned())]);
    }

    #[test]
    fn self_mapped_select_values_are_projection_markers_not_filters() {
        let mut request = PageRequest {
            req_id: "projection".to_owned(),
            use_page_id: Some(7),
            ..PageRequest::default()
        };
        request
            .select_values
            .insert("name".to_owned(), Value::Text("name".to_owned()));
        let predicates = compile_request_filters(&metadata(), &request).unwrap();
        assert!(predicates.is_empty());
    }

    #[test]
    fn layout_condition_is_parsed_without_accepting_raw_sql() {
        let mut request = PageRequest {
            layout_global_condition: Some("status='open' AND id=7".to_owned()),
            ..PageRequest::default()
        };
        assert_eq!(
            compile_request_filters(&metadata(), &request)
                .unwrap()
                .len(),
            2
        );
        request.layout_global_condition = Some("status LIKE '%'".to_owned());
        assert!(compile_request_filters(&metadata(), &request).is_err());
    }
}
