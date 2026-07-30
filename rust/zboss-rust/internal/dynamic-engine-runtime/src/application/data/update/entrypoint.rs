use crate::application::data::update::execution::{
    BatchCommand, BatchExecutionResult, ExecuteError, MemoryBatchStore, ProgressJournal,
    TerminalStatus, execute_batch,
};

pub const HTTP_PATH: &str =
    "/zboss/data/view/dynamic/engine/use/engine-use-batch-page/batchUpdateWithProgress";
pub const RPC_METHOD: &str = "EngineUseBatchPageRpc.batchUpdateWithProgress";
pub const WEB_RPC_METHOD: &str = "EngineUseBatchPageWebRpc.batchUpdateWithProgress";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entrypoint {
    Http,
    Rpc,
    WebRpc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicBatchResponse {
    pub code: u16,
    pub terminal: TerminalStatus,
    pub committed: Vec<usize>,
    pub failed: Vec<usize>,
}

pub fn invoke(
    _entrypoint: Entrypoint,
    command: &BatchCommand,
    store: &mut MemoryBatchStore,
    progress: &mut ProgressJournal,
) -> Result<(PublicBatchResponse, BatchExecutionResult), ExecuteError> {
    let result = execute_batch(command, store, progress)?;
    let response = PublicBatchResponse {
        code: 200,
        terminal: result.status,
        committed: result.committed.clone(),
        failed: result
            .failures
            .iter()
            .map(|failure| failure.index)
            .collect(),
    };
    Ok((response, result))
}
