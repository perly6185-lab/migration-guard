use crate::{
    domain::{
        context::RequestContext,
        model::{HorizontalQuery, HorizontalSlice},
    },
    http::error::ApiError,
};

pub trait HorizontalListPort: Send + Sync {
    fn list_horizontal(
        &self,
        context: &RequestContext,
        query: &HorizontalQuery,
    ) -> Result<HorizontalSlice, ApiError>;
}

pub trait HorizontalRefreshCoordinator: Send + Sync {
    fn refresh_horizontal(
        &self,
        context: &RequestContext,
        horizontal_id: u64,
    ) -> Result<(), ApiError>;
}

pub trait MysqlHorizontalQueryExecutor: Send + Sync {
    fn execute_horizontal(
        &self,
        context: &RequestContext,
        query: &HorizontalQuery,
    ) -> Result<HorizontalSlice, ApiError>;
}
