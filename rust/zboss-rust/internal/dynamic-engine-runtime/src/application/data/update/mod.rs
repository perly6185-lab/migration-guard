pub mod adapters;
pub mod application;
pub mod batch;
pub mod coordination;
pub mod entrypoint;
pub mod execution;
pub mod progress;
pub mod runtime;
pub mod scenario_contract;
pub mod schema_service;
pub mod schema_transition;

#[cfg(test)]
mod scenario_matrix;

pub const CONTRACT_VERSION: u32 = 1;
