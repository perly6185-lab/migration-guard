pub use zboss_dynamic_engine::http::{
    dto::{MetadataQueryRequest, MetadataQueryResponse},
    handler::MetadataQueryUseCase,
};

pub const HTTP_PATH: &str = zboss_dynamic_engine::QUERY_ENTRYPOINT;
