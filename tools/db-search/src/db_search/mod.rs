//! Reusable SQLite FTS5 query and schema helpers used by this tool.
//!
//! The application owns its domain schema, migrations, result hydration, and
//! ranking policy. This module only owns the generic FTS retrieval mechanics.

pub mod query;
pub mod sqlite_fts;
