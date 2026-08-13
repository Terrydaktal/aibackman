# ChatGPT database search

This tool owns the ChatGPT application's SQLite FTS5 retrieval path. The
generic query and FTS schema helpers live in `src/db_search/`; they are local
modules so clean ChatGPT checkouts do not depend on an untracked sibling
directory.

The application owns its domain schema, migrations, result hydration, and
ranking policy. The local `db_search` module owns only:

- parsing quoted and unquoted user query tokens;
- preparing SQLite FTS5 `MATCH` strings and highlight terms;
- validating FTS identifiers;
- generating FTS virtual-table and sync-trigger SQL;
- generating rebuild and ranked/recency search SQL.

`fuzzy-rank` remains responsible for typo-aware and product-specific reranking.

## Structure

```text
tools/db-search/
├── Cargo.toml
├── Cargo.lock
├── README.md
└── src/
    ├── main.rs
    └── db_search/
        ├── mod.rs
        ├── query.rs
        └── sqlite_fts.rs
```

The binary supports `ensure-index`, `search`, and `serve` commands. It opens
the ChatGPT SQLite database, maintains the `messages_fts` external-content
index, retrieves FTS candidates, and passes multi-token results through
`fuzzy-rank` before emitting JSON.
