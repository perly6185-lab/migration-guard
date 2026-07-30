#[tokio::main]
async fn main() {
    if let Err(error) =
        zboss_dynamic_engine::application::data::delete::runtime::run_from_env().await
    {
        eprintln!("batch-delete service failed: {error}");
        std::process::exit(1);
    }
}
