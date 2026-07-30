use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct CoordinationKey {
    pub tenant_id: u64,
    pub panel_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseMode {
    BatchShared,
    RefreshExclusive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnerLease {
    mode: LeaseMode,
    expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    Busy,
    OwnerConflict,
    OwnerMissing,
    InvalidClaim,
    Backend,
}

#[derive(Debug, Default)]
pub struct MemoryBatchRefreshLease {
    owners: BTreeMap<CoordinationKey, BTreeMap<String, OwnerLease>>,
}

impl MemoryBatchRefreshLease {
    pub fn acquire(
        &mut self,
        key: CoordinationKey,
        owner_token: &str,
        mode: LeaseMode,
        now: u64,
        ttl: u64,
    ) -> Result<(), LeaseError> {
        self.expire(&key, now);
        let owners = self.owners.entry(key).or_default();
        if let Some(current) = owners.get(owner_token)
            && current.mode != mode
        {
            return Err(LeaseError::OwnerConflict);
        }
        let incompatible = owners
            .iter()
            .filter(|(token, _)| token.as_str() != owner_token)
            .any(|(_, lease)| {
                mode == LeaseMode::RefreshExclusive || lease.mode == LeaseMode::RefreshExclusive
            });
        if incompatible {
            return Err(LeaseError::Busy);
        }
        owners.insert(
            owner_token.to_owned(),
            OwnerLease {
                mode,
                expires_at: now.saturating_add(ttl),
            },
        );
        Ok(())
    }

    pub fn renew(
        &mut self,
        key: &CoordinationKey,
        owner_token: &str,
        now: u64,
        ttl: u64,
    ) -> Result<(), LeaseError> {
        self.expire(key, now);
        let lease = self
            .owners
            .get_mut(key)
            .and_then(|owners| owners.get_mut(owner_token))
            .ok_or(LeaseError::OwnerMissing)?;
        lease.expires_at = now.saturating_add(ttl);
        Ok(())
    }

    pub fn release(&mut self, key: &CoordinationKey, owner_token: &str) -> Result<(), LeaseError> {
        let owners = self.owners.get_mut(key).ok_or(LeaseError::OwnerMissing)?;
        if owners.remove(owner_token).is_none() {
            return Err(LeaseError::OwnerMissing);
        }
        if owners.is_empty() {
            self.owners.remove(key);
        }
        Ok(())
    }

    pub fn owner_count(&self, key: &CoordinationKey) -> usize {
        self.owners.get(key).map_or(0, BTreeMap::len)
    }

    fn expire(&mut self, key: &CoordinationKey, now: u64) {
        if let Some(owners) = self.owners.get_mut(key) {
            owners.retain(|_, lease| lease.expires_at > now);
            if owners.is_empty() {
                self.owners.remove(key);
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ChunkKey {
    pub tenant_id: u64,
    pub client_session_id: String,
    pub chunk_no: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredChunkResult {
    pub request_hash: String,
    pub final_chunk: bool,
    pub terminal: String,
    pub committed: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkDecision {
    Stored(StoredChunkResult),
    Replayed(StoredChunkResult),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkError {
    InvalidRequestHash,
    HashConflict,
    OutOfOrder { expected: u32, actual: u32 },
    SessionClosed,
}

#[derive(Debug, Default)]
pub struct MemoryChunkLedger {
    records: BTreeMap<ChunkKey, StoredChunkResult>,
}

impl MemoryChunkLedger {
    pub fn decide(
        &mut self,
        key: ChunkKey,
        request_hash: &str,
        final_chunk: bool,
        terminal: &str,
        committed: usize,
        failed: usize,
    ) -> Result<ChunkDecision, ChunkError> {
        if !is_request_hash(request_hash) {
            return Err(ChunkError::InvalidRequestHash);
        }
        if let Some(stored) = self.records.get(&key) {
            if stored.request_hash != request_hash {
                return Err(ChunkError::HashConflict);
            }
            return Ok(ChunkDecision::Replayed(stored.clone()));
        }

        let session_records = self
            .records
            .iter()
            .filter(|(stored_key, _)| {
                stored_key.tenant_id == key.tenant_id
                    && stored_key.client_session_id == key.client_session_id
            })
            .collect::<Vec<_>>();
        if session_records.iter().any(|(_, result)| result.final_chunk) {
            return Err(ChunkError::SessionClosed);
        }
        let expected = session_records
            .iter()
            .map(|(stored_key, _)| stored_key.chunk_no)
            .max()
            .map_or(0, |last| last.saturating_add(1));
        if key.chunk_no != expected {
            return Err(ChunkError::OutOfOrder {
                expected,
                actual: key.chunk_no,
            });
        }

        let stored = StoredChunkResult {
            request_hash: request_hash.to_owned(),
            final_chunk,
            terminal: terminal.to_owned(),
            committed,
            failed,
        };
        self.records.insert(key, stored.clone());
        Ok(ChunkDecision::Stored(stored))
    }
}

fn is_request_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
