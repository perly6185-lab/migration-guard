#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--scenario-manifest") {
        for scenario in
            zboss_dynamic_engine::application::data::update::scenario_contract::SCENARIOS
        {
            println!("{}|{}", scenario.id, scenario.decisions.join(","));
        }
        return;
    }
    if let Err(error) =
        zboss_dynamic_engine::application::data::update::runtime::run_from_env().await
    {
        eprintln!("batch-update service failed: {error}");
        std::process::exit(1);
    }
}
