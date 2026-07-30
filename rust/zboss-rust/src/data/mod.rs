//! Stable business facade for dynamic row data operations.
//!
//! The modules follow the business meaning of each operation while preserving
//! the original ZBoss HTTP paths for migration compatibility.

pub mod delete;
pub mod horizontal;
pub mod init;
pub mod page;
pub mod update;
