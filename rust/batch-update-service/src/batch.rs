use std::collections::BTreeSet;

pub const DEFAULT_ROW_LIMIT: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRow {
    pub index: usize,
    pub primary_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchPlan {
    pub requested: Vec<usize>,
    pub valid: Vec<usize>,
    pub failed: Vec<usize>,
    pub inserts: Vec<usize>,
    pub updates: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    RowLimitExceeded { limit: usize },
    InvalidFailedIndex { index: usize },
}

pub fn plan_batch(
    post_rows: &[BatchRow],
    header_row_count: usize,
    failed_indexes: &[usize],
    limit: usize,
) -> Result<BatchPlan, PlanError> {
    if post_rows.len() > limit || header_row_count > limit {
        return Err(PlanError::RowLimitExceeded { limit });
    }
    let failed = failed_indexes.iter().copied().collect::<BTreeSet<_>>();
    if let Some(index) = failed.iter().find(|index| **index >= post_rows.len()) {
        return Err(PlanError::InvalidFailedIndex { index: *index });
    }
    let requested = post_rows.iter().map(|row| row.index).collect::<Vec<_>>();
    let valid_rows = post_rows
        .iter()
        .enumerate()
        .filter(|(position, _)| !failed.contains(position))
        .map(|(_, row)| row)
        .collect::<Vec<_>>();
    Ok(BatchPlan {
        requested,
        valid: valid_rows.iter().map(|row| row.index).collect(),
        failed: failed
            .into_iter()
            .map(|position| post_rows[position].index)
            .collect(),
        inserts: valid_rows
            .iter()
            .filter(|row| row.primary_key.is_none())
            .map(|row| row.index)
            .collect(),
        updates: valid_rows
            .iter()
            .filter(|row| row.primary_key.is_some())
            .map(|row| row.index)
            .collect(),
    })
}

pub fn validate_committed_undo(
    plan: &BatchPlan,
    committed: &[usize],
    undo: &[usize],
) -> Result<(), &'static str> {
    let valid = plan.valid.iter().copied().collect::<BTreeSet<_>>();
    let committed = committed.iter().copied().collect::<BTreeSet<_>>();
    let undo = undo.iter().copied().collect::<BTreeSet<_>>();
    if !committed.is_subset(&valid) {
        return Err("committed rows must be valid");
    }
    if committed != undo {
        return Err("undo rows must equal committed rows");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_partial_success_and_mixed_insert_update() {
        let rows = vec![
            BatchRow {
                index: 0,
                primary_key: Some("1".into()),
            },
            BatchRow {
                index: 1,
                primary_key: None,
            },
            BatchRow {
                index: 2,
                primary_key: Some("3".into()),
            },
        ];
        let plan = plan_batch(&rows, 1, &[2], DEFAULT_ROW_LIMIT).unwrap();
        assert_eq!(plan.valid, vec![0, 1]);
        assert_eq!(plan.failed, vec![2]);
        assert_eq!(plan.inserts, vec![1]);
        assert_eq!(plan.updates, vec![0]);
        assert!(validate_committed_undo(&plan, &[0, 1], &[0, 1]).is_ok());
    }

    #[test]
    fn enforces_post_and_header_limits() {
        let row = BatchRow {
            index: 0,
            primary_key: None,
        };
        assert!(matches!(
            plan_batch(&[row], 2, &[], 1),
            Err(PlanError::RowLimitExceeded { .. })
        ));
    }
}
