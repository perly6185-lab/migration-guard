//! Offline implementation of the approved `zboss-page` migration semantics.
//!
//! Runtime adapters remain outside this crate until real environment evidence is
//! available. The domain modules intentionally have no network or database
//! dependencies so the approved behavior can be verified deterministically.

pub mod horizontal;
pub mod quality;
pub mod refresh;

pub const MIGRATION_PROJECT_ID: &str = "zboss-page";
pub const ENTRYPOINTS: &[&str] = &["post-zboss-data-view-dynamic-engine-use-engine-use-page-page"];
pub const APPROVED_CORRECTIONS: &[&str] = &[
    "PAGE-DEC-QUALITY-AGGREGATE-ROUTING",
    "PAGE-DEC-HORIZONTAL-HAVING",
    "PAGE-DEC-REQUIRES-NEW-SELF-CALL",
    "PAGE-DEC-REFRESH-EFFECT-ORDER",
];
