use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum KeyPart {
    Null,
    Integer(i64),
    Boolean(bool),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct BusinessKey(pub Vec<KeyPart>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalCell {
    pub key: BusinessKey,
    pub dimension: String,
    pub value: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HorizontalPage {
    pub page: usize,
    pub page_size: usize,
    pub total: usize,
    pub page_keys: Vec<BusinessKey>,
    pub cells: Vec<HorizontalCell>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HorizontalPageError {
    InvalidPage,
    InvalidPageSize,
}

pub fn paginate_after_having(
    cells: &[HorizontalCell],
    having_survivors: &BTreeSet<BusinessKey>,
    page: usize,
    page_size: usize,
) -> Result<HorizontalPage, HorizontalPageError> {
    if page == 0 {
        return Err(HorizontalPageError::InvalidPage);
    }
    if page_size == 0 {
        return Err(HorizontalPageError::InvalidPageSize);
    }

    let available_keys = cells
        .iter()
        .map(|cell| cell.key.clone())
        .filter(|key| having_survivors.contains(key))
        .collect::<BTreeSet<_>>();
    let offset = (page - 1).saturating_mul(page_size);
    let page_keys = available_keys
        .iter()
        .skip(offset)
        .take(page_size)
        .cloned()
        .collect::<Vec<_>>();
    let selected = page_keys.iter().cloned().collect::<BTreeSet<_>>();
    let page_cells = cells
        .iter()
        .filter(|cell| selected.contains(&cell.key))
        .cloned()
        .collect();

    Ok(HorizontalPage {
        page,
        page_size,
        total: available_keys.len(),
        page_keys,
        cells: page_cells,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(value: &str) -> BusinessKey {
        BusinessKey(vec![KeyPart::Text(value.into()), KeyPart::Null])
    }

    #[test]
    fn applies_having_before_distinct_key_pagination_and_total() {
        let cells = vec![
            HorizontalCell {
                key: key("a"),
                dimension: "jan".into(),
                value: 10,
            },
            HorizontalCell {
                key: key("a"),
                dimension: "feb".into(),
                value: 20,
            },
            HorizontalCell {
                key: key("b"),
                dimension: "jan".into(),
                value: 30,
            },
            HorizontalCell {
                key: key("c"),
                dimension: "jan".into(),
                value: 40,
            },
        ];
        let survivors = BTreeSet::from([key("a"), key("c")]);
        let page = paginate_after_having(&cells, &survivors, 1, 1).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.page_keys, vec![key("a")]);
        assert_eq!(page.cells.len(), 2);
        assert!(page.cells.iter().all(|cell| cell.key == key("a")));
    }

    #[test]
    fn consecutive_pages_do_not_split_or_duplicate_business_keys() {
        let cells = ["a", "a", "b", "b", "c"]
            .into_iter()
            .enumerate()
            .map(|(index, value)| HorizontalCell {
                key: key(value),
                dimension: index.to_string(),
                value: index as i64,
            })
            .collect::<Vec<_>>();
        let survivors = BTreeSet::from([key("a"), key("b"), key("c")]);
        let first = paginate_after_having(&cells, &survivors, 1, 2).unwrap();
        let second = paginate_after_having(&cells, &survivors, 2, 2).unwrap();
        assert_eq!(first.page_keys, vec![key("a"), key("b")]);
        assert_eq!(second.page_keys, vec![key("c")]);
        assert_eq!(first.total, second.total);
        assert!(
            first
                .page_keys
                .iter()
                .all(|candidate| !second.page_keys.contains(candidate))
        );
    }

    #[test]
    fn typed_composite_keys_do_not_collapse_null_and_text() {
        assert_ne!(
            BusinessKey(vec![KeyPart::Null]),
            BusinessKey(vec![KeyPart::Text("null".into())])
        );
        assert_ne!(
            BusinessKey(vec![KeyPart::Integer(1)]),
            BusinessKey(vec![KeyPart::Text("1".into())])
        );
    }
}
