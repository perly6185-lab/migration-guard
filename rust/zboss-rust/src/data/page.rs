pub use zboss_dynamic_engine::{
    application::data::page::DynamicEngineApplication,
    http::{
        dto::{PageRequest, PageResponse},
        handler::PageUseCase,
    },
};

pub const HTTP_PATH: &str = zboss_dynamic_engine::PAGE_ENTRYPOINT;
