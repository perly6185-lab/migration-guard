# zboss-page-migration

This target implements the three approved offline semantics:

- ordinary quality predicates route to `WHERE`; aggregate predicates route to `HAVING`;
- horizontal pagination operates on the distinct business keys that survive `HAVING`;
- REFRESH executes ordered effects and attempts owner-token lease release on every terminal path.

Run `cargo test` and `cargo clippy --all-targets -- -D warnings` to verify the
domain layer.

The HTTP service, MySQL/Redis adapters and real replay evidence are not complete.
Do not route traffic here until both migration gates pass.
