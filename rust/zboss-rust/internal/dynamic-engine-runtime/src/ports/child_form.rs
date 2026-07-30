use std::collections::BTreeMap;

use crate::{
    domain::{context::RequestContext, model::Value},
    http::error::ApiError,
};

pub trait ChildFormPort: Send + Sync {
    fn header_conditions(
        &self,
        context: &RequestContext,
        field_id: u64,
    ) -> Result<BTreeMap<String, Value>, ApiError>;
}
