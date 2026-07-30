pub mod adapters;
pub mod application;
pub mod config;
pub mod domain;
pub mod http;
pub mod ports;
pub mod runtime;

pub const CONTRACT_VERSION: u32 = 8;
pub const PROJECT_ID: &str = "zboss-dynamic-engine";
pub const PAGE_ENTRYPOINT: &str = "/zboss/data/view/dynamic/engine/use/engine-use-page/page";
pub const QUERY_ENTRYPOINT: &str = "/zboss/data/view/dynamic/engine/use/engine-use-page/query";
pub const HORIZONTAL_LIST_ENTRYPOINT: &str =
    "/zboss/data/view/dynamic/engine/use/engine-use-horizontal/list";
pub const INIT_ENTRYPOINT: &str = "/zboss/data/view/dynamic/engine/use/engine-use-page/init";
pub const FIELD_SCHEMA_UPDATE_ENTRYPOINT: &str = "/zboss/data/view-dynamic-field-data/update";
pub const FIELD_SCHEMA_DELETE_ENTRYPOINT: &str = "/zboss/data/view-dynamic-field-data/delete";
pub const FIELD_DETAIL_ENTRYPOINT: &str = "/zboss/data/view-dynamic-field-data/get";
pub const ENTRYPOINT: &str = PAGE_ENTRYPOINT;

pub fn readiness(profile: config::Profile) -> http::envelope::Envelope<http::dto::Readiness> {
    http::envelope::Envelope::success(http::dto::Readiness {
        ready: profile_ready(profile),
        profile: profile.as_str().to_owned(),
        contract_version: CONTRACT_VERSION,
    })
}

pub fn profile_ready(profile: config::Profile) -> bool {
    match profile {
        config::Profile::Memory => cfg!(feature = "memory"),
        config::Profile::Production => production_adapters_ready(),
    }
}

fn production_adapters_ready() -> bool {
    #[cfg(all(feature = "mysql", feature = "redis"))]
    {
        adapters::mysql::MysqlAdapterConfig::default().is_configured()
            && adapters::redis::RedisAdapterConfig::default().is_configured()
            && std::env::var("ZBOSS_PAGE_CATALOG_FILE").is_ok_and(|value| !value.trim().is_empty())
    }
    #[cfg(not(all(feature = "mysql", feature = "redis")))]
    {
        false
    }
}
