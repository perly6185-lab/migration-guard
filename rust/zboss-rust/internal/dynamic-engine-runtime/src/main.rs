#[cfg(feature = "memory")]
use std::sync::Arc;

#[cfg(feature = "memory")]
use zboss_dynamic_engine::adapters::memory::MemoryAdapters;
use zboss_dynamic_engine::{
    config::Config,
    runtime::{RuntimeState, serve},
};

#[cfg(all(test, feature = "memory"))]
use zboss_dynamic_engine::{
    application::data::page::DynamicEngineApplication, http::server::route,
};

#[tokio::main]
async fn main() {
    let config = Config::from_env().unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    let bind = config.bind;
    let state = match config.profile {
        zboss_dynamic_engine::config::Profile::Memory => {
            #[cfg(feature = "memory")]
            {
                RuntimeState::memory(config, Arc::new(MemoryAdapters::default()))
            }
            #[cfg(not(feature = "memory"))]
            {
                eprintln!("memory profile requires the memory feature");
                std::process::exit(2);
            }
        }
        zboss_dynamic_engine::config::Profile::Production => RuntimeState::production(config)
            .unwrap_or_else(|error| {
                eprintln!("production startup failed: {error}");
                std::process::exit(2);
            }),
    };
    if let Err(error) = serve(bind, state).await {
        eprintln!("server failed: {error}");
        std::process::exit(2);
    }
}

#[cfg(all(test, feature = "memory"))]
mod tests {
    use super::*;
    use zboss_dynamic_engine::{
        ENTRYPOINT,
        domain::{
            context::RequestContext,
            model::{FieldMetadata, PageMetadata},
        },
    };

    fn application() -> DynamicEngineApplication<MemoryAdapters> {
        DynamicEngineApplication::new(Arc::new(MemoryAdapters::default()))
    }

    #[test]
    fn health_and_readiness_are_available_in_memory_profile() {
        let config = Config::default();
        let application = application();
        assert_eq!(
            route("GET /health HTTP/1.1", &config, &application).0,
            "200 OK"
        );
        let ready = route("GET /ready HTTP/1.1", &config, &application);
        assert_eq!(ready.0, "200 OK");
        assert!(ready.1.contains("\"ready\":true"));
    }

    #[test]
    fn page_route_requires_explicit_context() {
        let config = Config::default();
        let fixture = include_str!("../fixtures/contracts/page-request-minimal.json");
        let response = route(
            &format!("POST {ENTRYPOINT} HTTP/1.1\r\n\r\n{fixture}"),
            &config,
            &application(),
        );
        assert_eq!(response.0, "403 Forbidden");
    }

    #[test]
    fn page_route_reaches_application_flow() {
        let config = Config::default();
        let ports = Arc::new(MemoryAdapters::default());
        let context = RequestContext {
            tenant_id: 1,
            user_id: 2,
            device_id: "device".to_owned(),
            request_id: "request".to_owned(),
            trace_id: "trace".to_owned(),
            datasource: "primary".to_owned(),
            snapshot_id: "snapshot".to_owned(),
        };
        ports.insert_metadata(
            &context,
            PageMetadata {
                version: 1,
                page_id: 9_007_199_254_740_993,
                panel_id: 77,
                table: "orders".to_owned(),
                business_key: vec!["id".to_owned()],
                fields: vec![FieldMetadata {
                    key: "id".to_owned(),
                    column: "id".to_owned(),
                    aggregate: None,
                }],
            },
        );
        let application = DynamicEngineApplication::new(ports);
        let fixture = include_str!("../fixtures/contracts/page-request-minimal.json");
        let raw = format!(
            "POST {ENTRYPOINT} HTTP/1.1\r\n\
             X-Tenant-Id: 1\r\n\
             X-User-Id: 2\r\n\
             X-Device-Id: device\r\n\
             X-Request-Id: request\r\n\
             X-Trace-Id: trace\r\n\
             X-Datasource: primary\r\n\
             X-Snapshot-Id: snapshot\r\n\r\n{fixture}"
        );
        let response = route(&raw, &config, &application);
        assert_eq!(response.0, "200 OK");
        assert!(response.1.contains("\"code\":0"));
    }
}
