#[tokio::main]
async fn main() {
    if let Err(error) =
        zboss_dynamic_engine::application::data::update::schema_service::run_from_env().await
    {
        eprintln!("schema-transition service failed: {error}");
        std::process::exit(1);
    }
}
