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
    ├── ranking_model.rs
    └── db_search/
        ├── mod.rs
        ├── query.rs
        └── sqlite_fts.rs
```

The binary supports `ensure-index`, `search`, and `serve` commands. It opens
the ChatGPT SQLite database, maintains the `messages_fts` external-content
index, retrieves FTS candidates, and passes multi-token results through
`fuzzy-rank` before emitting JSON.

If `CHATGPT_FIELD_RANK_MODEL` is set, or if
`$XDG_STATE_HOME/chatgpt-db-search/field-rank-model.json` exists, the worker
loads a schema-versioned `fuzzy-rank::fields::FieldRankModel` and reranks only
the leading 256 retrieved message candidates. Without a valid active model,
the deterministic `fields::literal` ordering is unchanged. Model persistence
and feedback collection remain caller-owned; this worker only loads the model
and applies it.
