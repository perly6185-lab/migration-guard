#[tokio::main]
async fn main() {
    let config = zboss_rust::UnifiedConfig::from_env().unwrap_or_else(|error| {
        eprintln!("invalid unified service configuration: {error}");
        std::process::exit(2);
    });
    if let Err(error) = zboss_rust::serve(config).await {
        eprintln!("zboss unified service failed: {error}");
        std::process::exit(2);
    }
}
