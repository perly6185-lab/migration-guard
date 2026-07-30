use crate::{
    domain::context::RequestContext,
    domain::{model::PageSlice, query::QueryPlan},
    http::error::ApiError,
};

pub trait PageQueryPort: Send + Sync {
    fn query(&self, context: &RequestContext, plan: &QueryPlan) -> Result<PageSlice, ApiError>;
}
