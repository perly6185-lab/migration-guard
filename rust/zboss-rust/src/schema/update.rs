pub use zboss_dynamic_engine::http::{
    dto::{FieldSchemaUpdateRequest, FieldSchemaUpdateResponse},
    handler::FieldSchemaUseCase,
};

pub const HTTP_PATH: &str = zboss_dynamic_engine::FIELD_SCHEMA_UPDATE_ENTRYPOINT;
