fn main() {
    if std::env::args().nth(1).as_deref() == Some("--scenario-manifest") {
        for scenario in
            zboss_dynamic_engine::application::data::update::scenario_contract::SCENARIOS
        {
            println!("{}|{}", scenario.id, scenario.decisions.join(","));
        }
        return;
    }
    println!(
        "zboss batch-update Rust contract v{}",
        zboss_dynamic_engine::application::data::update::CONTRACT_VERSION
    );
}
