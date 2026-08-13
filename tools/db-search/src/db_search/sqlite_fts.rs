use super::query::{QueryToken, SearchQuery};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SqlBuildError {
    EmptyIdentifier,
    InvalidIdentifier(String),
    EmptySearchColumns,
    EmptySelectColumns,
}

impl std::fmt::Display for SqlBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyIdentifier => write!(f, "identifier cannot be empty"),
            Self::InvalidIdentifier(identifier) => {
                write!(f, "invalid SQL identifier: {identifier}")
            }
            Self::EmptySearchColumns => write!(f, "FTS index requires at least one search column"),
            Self::EmptySelectColumns => {
                write!(f, "search query requires at least one select column")
            }
        }
    }
}

impl std::error::Error for SqlBuildError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchMode {
    Exact,
    Prefix,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedFtsQuery {
    pub match_query: String,
    pub highlight_terms: Vec<String>,
}

pub fn prepare_fts_query(query: &SearchQuery, mode: SearchMode) -> PreparedFtsQuery {
    let match_query = match mode {
        SearchMode::Exact => query.raw().to_owned(),
        SearchMode::Prefix => build_prefix_match_query(query.tokens()),
    };

    let highlight_terms = query.tokens().iter().filter_map(highlight_term).collect();

    PreparedFtsQuery {
        match_query,
        highlight_terms,
    }
}

pub fn rowid_match_subquery(fts_table: &str, parameter_index: usize) -> String {
    format!("SELECT rowid FROM {fts_table} WHERE {fts_table} MATCH ?{parameter_index}")
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FtsIndexConfig {
    pub content_table: String,
    pub content_pk: String,
    pub fts_table: String,
    pub search_columns: Vec<String>,
}

impl FtsIndexConfig {
    pub fn new(
        content_table: impl Into<String>,
        content_pk: impl Into<String>,
        fts_table: impl Into<String>,
        search_columns: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            content_table: content_table.into(),
            content_pk: content_pk.into(),
            fts_table: fts_table.into(),
            search_columns: search_columns.into_iter().map(Into::into).collect(),
        }
    }

    pub fn validate(&self) -> Result<(), SqlBuildError> {
        quote_ident(&self.content_table)?;
        quote_ident(&self.content_pk)?;
        quote_ident(&self.fts_table)?;
        if self.search_columns.is_empty() {
            return Err(SqlBuildError::EmptySearchColumns);
        }
        for column in &self.search_columns {
            quote_ident(column)?;
        }
        Ok(())
    }

    pub fn create_table_sql(&self) -> Result<String, SqlBuildError> {
        self.validate()?;
        let columns = self
            .search_columns
            .iter()
            .map(|column| quote_ident(column))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        Ok(format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {} USING fts5({}, content={}, content_rowid={})",
            quote_ident(&self.fts_table)?,
            columns,
            quote_string_literal(&self.content_table),
            quote_string_literal(&self.content_pk),
        ))
    }

    pub fn rebuild_sql(&self) -> Result<String, SqlBuildError> {
        self.validate()?;
        Ok(format!(
            "INSERT INTO {}({}) VALUES('rebuild')",
            quote_ident(&self.fts_table)?,
            quote_ident(&self.fts_table)?,
        ))
    }

    pub fn create_trigger_sql(&self) -> Result<Vec<String>, SqlBuildError> {
        self.validate()?;
        let trigger_prefix = format!("{}_sync", self.fts_table);
        let fts_table = quote_ident(&self.fts_table)?;
        let content_table = quote_ident(&self.content_table)?;
        let content_pk = quote_ident(&self.content_pk)?;
        let columns = self.quoted_columns()?.join(", ");
        let new_columns = self
            .search_columns
            .iter()
            .map(|column| format!("new.{}", quote_ident(column).unwrap()))
            .collect::<Vec<_>>()
            .join(", ");
        let old_columns = self
            .search_columns
            .iter()
            .map(|column| format!("old.{}", quote_ident(column).unwrap()))
            .collect::<Vec<_>>()
            .join(", ");

        Ok(vec![
            format!(
                "CREATE TRIGGER IF NOT EXISTS {} AFTER INSERT ON {} BEGIN INSERT INTO {}(rowid, {}) VALUES (new.{}, {}); END",
                quote_ident(&format!("{trigger_prefix}_ai"))?,
                content_table,
                fts_table,
                columns,
                content_pk,
                new_columns,
            ),
            format!(
                "CREATE TRIGGER IF NOT EXISTS {} AFTER DELETE ON {} BEGIN INSERT INTO {}({}, rowid, {}) VALUES('delete', old.{}, {}); END",
                quote_ident(&format!("{trigger_prefix}_ad"))?,
                content_table,
                fts_table,
                quote_ident(&self.fts_table)?,
                columns,
                content_pk,
                old_columns,
            ),
            format!(
                "CREATE TRIGGER IF NOT EXISTS {} AFTER UPDATE ON {} BEGIN INSERT INTO {}({}, rowid, {}) VALUES('delete', old.{}, {}); INSERT INTO {}(rowid, {}) VALUES (new.{}, {}); END",
                quote_ident(&format!("{trigger_prefix}_au"))?,
                content_table,
                fts_table,
                quote_ident(&self.fts_table)?,
                columns,
                content_pk,
                old_columns,
                fts_table,
                columns,
                content_pk,
                new_columns,
            ),
        ])
    }

    pub fn drop_trigger_sql(&self) -> Result<Vec<String>, SqlBuildError> {
        self.validate()?;
        let trigger_prefix = format!("{}_sync", self.fts_table);
        ["ai", "ad", "au"]
            .into_iter()
            .map(|suffix| {
                quote_ident(&format!("{trigger_prefix}_{suffix}"))
                    .map(|trigger| format!("DROP TRIGGER IF EXISTS {trigger}"))
            })
            .collect::<Result<Vec<_>, _>>()
    }

    fn quoted_columns(&self) -> Result<Vec<String>, SqlBuildError> {
        self.search_columns
            .iter()
            .map(|column| quote_ident(column))
            .collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchOrder {
    Rank,
    Recency {
        column: &'static str,
        descending: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchSqlConfig {
    pub index: FtsIndexConfig,
    pub select_columns: Vec<String>,
    pub filters: Vec<String>,
    pub order: SearchOrder,
    pub match_parameter_index: usize,
    pub limit_parameter_index: Option<usize>,
}

impl SearchSqlConfig {
    pub fn select_sql(&self) -> Result<String, SqlBuildError> {
        self.index.validate()?;
        if self.select_columns.is_empty() {
            return Err(SqlBuildError::EmptySelectColumns);
        }

        let content_table = quote_ident(&self.index.content_table)?;
        let fts_table = quote_ident(&self.index.fts_table)?;
        let content_pk = quote_ident(&self.index.content_pk)?;
        let select_columns = self.select_columns.join(", ");
        let mut where_parts = vec![format!(
            "{} MATCH ?{}",
            fts_table, self.match_parameter_index
        )];
        where_parts.extend(self.filters.iter().cloned());

        let mut sql = format!(
            "SELECT {select_columns} FROM {content_table} JOIN {fts_table} ON {fts_table}.rowid = {content_table}.{content_pk} WHERE {}",
            where_parts.join(" AND ")
        );
        sql.push_str(&format!(" ORDER BY {}", self.order.order_by_sql()?));
        if let Some(limit_parameter_index) = self.limit_parameter_index {
            sql.push_str(&format!(" LIMIT ?{limit_parameter_index}"));
        }
        Ok(sql)
    }
}

impl SearchOrder {
    fn order_by_sql(self) -> Result<String, SqlBuildError> {
        match self {
            Self::Rank => Ok("rank".to_owned()),
            Self::Recency { column, descending } => {
                let direction = if descending { "DESC" } else { "ASC" };
                Ok(format!("{} {direction}", quote_ident(column)?))
            }
        }
    }
}

fn build_prefix_match_query(tokens: &[QueryToken]) -> String {
    let mut parts = Vec::new();

    for token in tokens {
        if token.quoted {
            parts.push(format!("\"{}\"", token.text));
            continue;
        }

        if token.text.eq_ignore_ascii_case("or") {
            parts.push("OR".to_owned());
            continue;
        }

        for cleaned in fts_token_fragments(&token.text) {
            if cleaned.ends_with('*') {
                parts.push(cleaned);
            } else {
                parts.push(format!("{cleaned}*"));
            }
        }
    }

    parts.join(" ")
}

fn highlight_term(token: &QueryToken) -> Option<String> {
    if token.quoted {
        return Some(token.text.to_lowercase());
    }

    if matches!(
        token.text.to_ascii_lowercase().as_str(),
        "or" | "and" | "not"
    ) {
        return None;
    }

    let terms = fts_token_fragments(&token.text);
    (!terms.is_empty()).then(|| terms.join(" ").trim_end_matches('*').to_lowercase())
}

fn fts_token_fragments(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '*')
        .filter_map(|part| {
            let cleaned = part.trim_matches('*');
            if cleaned.is_empty() {
                None
            } else if part.ends_with('*') {
                Some(format!("{cleaned}*"))
            } else {
                Some(cleaned.to_owned())
            }
        })
        .collect()
}

fn quote_ident(identifier: &str) -> Result<String, SqlBuildError> {
    if identifier.is_empty() {
        return Err(SqlBuildError::EmptyIdentifier);
    }
    let mut chars = identifier.chars();
    let first = chars.next().ok_or(SqlBuildError::EmptyIdentifier)?;
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return Err(SqlBuildError::InvalidIdentifier(identifier.to_owned()));
    }
    if !chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric()) {
        return Err(SqlBuildError::InvalidIdentifier(identifier.to_owned()));
    }
    Ok(format!("\"{identifier}\""))
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::{
        FtsIndexConfig, PreparedFtsQuery, SearchMode, SearchOrder, SearchSqlConfig, SqlBuildError,
        prepare_fts_query, rowid_match_subquery,
    };
    use crate::db_search::query::SearchQuery;

    #[test]
    fn exact_mode_preserves_query() {
        let query = SearchQuery::new(r#""hello world" OR cat"#);
        assert_eq!(
            prepare_fts_query(&query, SearchMode::Exact),
            PreparedFtsQuery {
                match_query: r#""hello world" OR cat"#.into(),
                highlight_terms: vec!["hello world".into(), "cat".into()],
            }
        );
    }

    #[test]
    fn prefix_mode_adds_wildcards_and_preserves_or() {
        let query = SearchQuery::new(r#"hello "two words" OR cat*"#);
        assert_eq!(
            prepare_fts_query(&query, SearchMode::Prefix),
            PreparedFtsQuery {
                match_query: r#"hello* "two words" OR cat*"#.into(),
                highlight_terms: vec!["hello".into(), "two words".into(), "cat".into()],
            }
        );
    }

    #[test]
    fn prefix_mode_splits_path_like_tokens() {
        let query = SearchQuery::new("cachy /dev/assistant");
        assert_eq!(
            prepare_fts_query(&query, SearchMode::Prefix),
            PreparedFtsQuery {
                match_query: "cachy* dev* assistant*".into(),
                highlight_terms: vec!["cachy".into(), "dev assistant".into()],
            }
        );
    }

    #[test]
    fn rowid_subquery_uses_fts_table_name() {
        assert_eq!(
            rowid_match_subquery("messages_fts", 1),
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1"
        );
    }

    #[test]
    fn fts_index_config_builds_external_content_table() {
        let config = FtsIndexConfig::new("messages", "id", "messages_fts", ["content", "title"]);
        assert_eq!(
            config.create_table_sql().unwrap(),
            "CREATE VIRTUAL TABLE IF NOT EXISTS \"messages_fts\" USING fts5(\"content\", \"title\", content='messages', content_rowid='id')"
        );
        assert_eq!(
            config.rebuild_sql().unwrap(),
            "INSERT INTO \"messages_fts\"(\"messages_fts\") VALUES('rebuild')"
        );
    }

    #[test]
    fn fts_index_config_builds_sync_triggers() {
        let config = FtsIndexConfig::new("messages", "id", "messages_fts", ["content"]);
        let triggers = config.create_trigger_sql().unwrap();
        assert_eq!(triggers.len(), 3);
        assert!(triggers[0].contains("AFTER INSERT ON \"messages\""));
        assert!(triggers[1].contains("VALUES('delete', old.\"id\", old.\"content\")"));
        assert!(triggers[2].contains("AFTER UPDATE ON \"messages\""));
    }

    #[test]
    fn fts_index_config_builds_drop_triggers() {
        let config = FtsIndexConfig::new("messages", "id", "messages_fts", ["content"]);
        assert_eq!(
            config.drop_trigger_sql().unwrap(),
            vec![
                "DROP TRIGGER IF EXISTS \"messages_fts_sync_ai\"",
                "DROP TRIGGER IF EXISTS \"messages_fts_sync_ad\"",
                "DROP TRIGGER IF EXISTS \"messages_fts_sync_au\"",
            ]
        );
    }

    #[test]
    fn search_sql_config_builds_ranked_select() {
        let config = SearchSqlConfig {
            index: FtsIndexConfig::new("messages", "id", "messages_fts", ["content"]),
            select_columns: vec!["messages.*".into()],
            filters: vec!["messages.conversation_id = ?2".into()],
            order: SearchOrder::Rank,
            match_parameter_index: 1,
            limit_parameter_index: Some(3),
        };
        assert_eq!(
            config.select_sql().unwrap(),
            "SELECT messages.* FROM \"messages\" JOIN \"messages_fts\" ON \"messages_fts\".rowid = \"messages\".\"id\" WHERE \"messages_fts\" MATCH ?1 AND messages.conversation_id = ?2 ORDER BY rank LIMIT ?3"
        );
    }

    #[test]
    fn search_sql_config_builds_recency_ordered_select() {
        let config = SearchSqlConfig {
            index: FtsIndexConfig::new("messages", "id", "messages_fts", ["content"]),
            select_columns: vec!["messages.id".into()],
            filters: Vec::new(),
            order: SearchOrder::Recency {
                column: "created_at",
                descending: true,
            },
            match_parameter_index: 1,
            limit_parameter_index: None,
        };
        assert_eq!(
            config.select_sql().unwrap(),
            "SELECT messages.id FROM \"messages\" JOIN \"messages_fts\" ON \"messages_fts\".rowid = \"messages\".\"id\" WHERE \"messages_fts\" MATCH ?1 ORDER BY \"created_at\" DESC"
        );
    }

    #[test]
    fn invalid_identifiers_are_rejected() {
        let config = FtsIndexConfig::new(
            "messages; DROP TABLE messages",
            "id",
            "messages_fts",
            ["content"],
        );
        assert!(matches!(
            config.create_table_sql(),
            Err(SqlBuildError::InvalidIdentifier(_))
        ));
    }
}
