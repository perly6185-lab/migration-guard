# zboss batch-update Rust reimplementation

Independent Rust reimplementation target for the read-only Java reference method
`ViewMetaBatchUpdateApplicationServiceImpl.batchUpdate/doBatchUpdate`.

This project does not modify or call from `zboss-cloud`.

## Local checks

```powershell
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Integration environment

```powershell
docker compose -f docker-compose.integration.yml up -d
docker compose -f docker-compose.integration.yml ps
```

MySQL listens on `127.0.0.1:13306`; Redis listens on `127.0.0.1:16379`.
Generated comparison evidence belongs under `.migration-guard/vmp-batch-rust`, not in `zboss-cloud`.
