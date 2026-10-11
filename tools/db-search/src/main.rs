use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{self, BufRead, Write};

mod db_search;
mod ranking_model;

use crate::db_search::query::SearchQuery;
use crate::db_search::sqlite_fts::{FtsIndexConfig, SearchMode, prepare_fts_query};
use fuzzy_rank::fields::literal::{
    MessageCandidate, MessageField, MessageQuery, select_top_k, select_top_k_with_model,
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

const SHORT_QUERY_PREVIEW_MAX_LEN: usize = 2;
const SHORT_QUERY_PREVIEW_LIMIT: usize = 100;
const RANKED_RESULT_LIMIT: usize = 40;

#[derive(Clone, Debug, Serialize)]
struct SearchRow {
    id: String,
    conversation_id: String,
    role: String,
    content: String,
    conversation_title: String,
    created_at: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
struct SearchOutput {
    total: usize,
    total_is_lower_bound: bool,
    results: Vec<SearchRow>,
}

#[derive(Clone, Debug, Deserialize)]
struct ServerRequest {
    id: u64,
    command: String,
    query: Option<String>,
    limit: Option<usize>,
    sort: Option<String>,
    role: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct ServerResponse {
    id: u64,
    ok: bool,
    output: Option<SearchOutput>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct RankedSearchRow {
    row: SearchRow,
    score: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchSort {
    Relevance,
    DateAsc,
    DateDesc,
}

impl SearchSort {
    fn parse(value: Option<&str>) -> Result<Self, Box<dyn std::error::Error>> {
        match value.unwrap_or("relevance") {
            "relevance" => Ok(Self::Relevance),
            "date_asc" => Ok(Self::DateAsc),
            "date_desc" => Ok(Self::DateDesc),
            other => Err(format!("unknown search sort: {other}").into()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchRole {
    All,
    User,
    Assistant,
}

impl SearchRole {
    fn parse(value: Option<&str>) -> Result<Self, Box<dyn std::error::Error>> {
        match value.unwrap_or("all") {
            "all" => Ok(Self::All),
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            other => Err(format!("unknown search role: {other}").into()),
        }
    }

    fn sql_predicate(self) -> &'static str {
        match self {
            Self::All => "m.role IN ('user', 'assistant')",
            Self::User => "m.role = 'user'",
            Self::Assistant => "m.role = 'assistant'",
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        return Err("missing command".into());
    }

    let command = args.remove(0);
    match command.as_str() {
        "ensure-index" => {
            let db_path = take_flag_value(&args, "--db-path")?;
            let conn = Connection::open(db_path)?;
            ensure_index(&conn, true)?;
        }
        "search" => {
            let db_path = take_flag_value(&args, "--db-path")?;
            let query = take_flag_value(&args, "--query")?;
            let limit = take_flag_value(&args, "--limit")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(100);
            let sort = SearchSort::parse(flag_value(&args, "--sort").as_deref())?;
            let role = SearchRole::parse(flag_value(&args, "--role").as_deref())?;

            let conn = Connection::open(db_path)?;
            ensure_index(&conn, false)?;
            let output = search_messages(&conn, &query, limit, sort, role)?;
            println!("{}", serde_json::to_string(&output)?);
        }
        "serve" => {
            let db_path = take_flag_value(&args, "--db-path")?;
            let conn = Connection::open(db_path)?;
            ensure_index(&conn, false)?;
            serve(conn)?;
        }
        other => return Err(format!("unknown command: {other}").into()),
    }

    Ok(())
}

fn serve(conn: Connection) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<ServerRequest>(&line) {
            Ok(request) => handle_server_request(&conn, request),
            Err(error) => ServerResponse {
                id: 0,
                ok: false,
                output: None,
                error: Some(error.to_string()),
            },
        };
        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_server_request(conn: &Connection, request: ServerRequest) -> ServerResponse {
    if request.command != "search" {
        return ServerResponse {
            id: request.id,
            ok: false,
            output: None,
            error: Some(format!("unknown command: {}", request.command)),
        };
    }

    let output = SearchSort::parse(request.sort.as_deref()).and_then(|sort| {
        SearchRole::parse(request.role.as_deref()).and_then(|role| {
            search_messages(
                conn,
                request.query.as_deref().unwrap_or_default(),
                request.limit.unwrap_or(100),
                sort,
                role,
            )
        })
    });
    match output {
        Ok(output) => ServerResponse {
            id: request.id,
            ok: true,
            output: Some(output),
            error: None,
        },
        Err(error) => ServerResponse {
            id: request.id,
            ok: false,
            output: None,
            error: Some(error.to_string()),
        },
    }
}

fn take_flag_value(args: &[String], flag: &str) -> Result<String, Box<dyn std::error::Error>> {
    args.windows(2)
        .find(|window| window[0] == flag)
        .map(|window| window[1].clone())
        .ok_or_else(|| format!("missing required flag {flag}").into())
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|window| window[0] == flag)
        .map(|window| window[1].clone())
}

fn ensure_index(conn: &Connection, rebuild: bool) -> Result<(), Box<dyn std::error::Error>> {
    let index = FtsIndexConfig::new("messages", "rowid", "messages_fts", ["content"]);

    if fts_columns_need_reset(conn, &index)? {
        for drop_trigger_sql in index.drop_trigger_sql()? {
            conn.execute_batch(&drop_trigger_sql)?;
        }
        conn.execute_batch("DROP TABLE IF EXISTS messages_fts")?;
    }

    conn.execute_batch(&index.create_table_sql()?)?;
    for trigger_sql in index.create_trigger_sql()? {
        conn.execute_batch(&trigger_sql)?;
    }

    if rebuild || !fts_index_has_terms(conn)? {
        conn.execute_batch(&index.rebuild_sql()?)?;
    }

    Ok(())
}

fn search_messages(
    conn: &Connection,
    query: &str,
    limit: usize,
    sort: SearchSort,
    role: SearchRole,
) -> Result<SearchOutput, Box<dyn std::error::Error>> {
    let search_query = SearchQuery::new(query);
    if search_query.is_empty() {
        return Ok(SearchOutput {
            total: 0,
            total_is_lower_bound: false,
            results: Vec::new(),
        });
    }

    if sort != SearchSort::Relevance {
        let prepared = prepare_fts_query(&search_query, SearchMode::Prefix);
        let output_limit = limit.max(1);
        let (total, total_is_lower_bound) = if is_short_preview_query(query) {
            lower_bound_search_count(conn, &prepared.match_query, output_limit, role)?
        } else {
            count_search_rows(conn, &prepared.match_query, role)?
        };
        return Ok(SearchOutput {
            total,
            total_is_lower_bound,
            results: fetch_search_rows(
                conn,
                &prepared.match_query,
                output_limit as i64,
                sort,
                role,
            )?
            .into_iter()
            .map(|item| item.row)
            .collect(),
        });
    }

    if is_fts_only_query(&search_query, query) {
        let match_query = prepare_fts_query(&search_query, SearchMode::Prefix).match_query;
        let preview_limit = limit.min(SHORT_QUERY_PREVIEW_LIMIT).max(1) as i64;
        let (total, total_is_lower_bound) = if is_short_preview_query(query) {
            lower_bound_search_count(conn, &match_query, preview_limit as usize, role)?
        } else {
            count_search_rows(conn, &match_query, role)?
        };
        return Ok(SearchOutput {
            total,
            total_is_lower_bound,
            results: fetch_search_rows(conn, &match_query, preview_limit, sort, role)?
                .into_iter()
                .map(|item| item.row)
                .collect(),
        });
    }

    let strict = prepare_fts_query(&search_query, SearchMode::Prefix);
    let (total, total_is_lower_bound) = count_search_rows(conn, &strict.match_query, role)?;
    let output_limit = limit.min(RANKED_RESULT_LIMIT).max(1);
    let strict_fetch_limit = ranked_fetch_limit(output_limit, total) as i64;

    let mut raw_rows = Vec::new();
    let mut seen_ids = HashSet::new();
    for item in fetch_search_rows(conn, &strict.match_query, strict_fetch_limit, sort, role)? {
        if seen_ids.insert(item.row.id.clone()) {
            raw_rows.push(item);
        }
    }

    let Some(message_query) = MessageQuery::new(query) else {
        return Ok(SearchOutput {
            total,
            total_is_lower_bound,
            results: raw_rows
                .into_iter()
                .map(|item| item.row)
                .take(output_limit)
                .collect(),
        });
    };

    let index_by_key = raw_rows
        .iter()
        .enumerate()
        .map(|(idx, item)| (item.row.id.as_str(), idx))
        .collect::<HashMap<_, _>>();

    let mut ranked = raw_rows
        .iter()
        .enumerate()
        .filter_map(|(_, item)| {
            let fields = [
                MessageField {
                    priority: 0,
                    value: item.row.conversation_title.as_str(),
                },
                MessageField {
                    priority: 1,
                    value: item.row.content.as_str(),
                },
            ];
            message_query.search_rank(MessageCandidate {
                key: item.row.id.as_str(),
                fields: &fields,
                score: item.score,
            })
        })
        .collect::<Vec<_>>();

    if let Some(model) = ranking_model::field_rank_model() {
        select_top_k_with_model(&mut ranked, output_limit, model, 256);
    } else {
        select_top_k(&mut ranked, output_limit);
    }

    let mut ordered = Vec::with_capacity(ranked.len());

    for ranked_match in ranked {
        if let Some(&idx) = index_by_key.get(ranked_match.key) {
            ordered.push(raw_rows[idx].row.clone());
        }
    }
    Ok(SearchOutput {
        total,
        total_is_lower_bound,
        results: ordered,
    })
}

fn is_short_preview_query(query: &str) -> bool {
    let trimmed = query.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= SHORT_QUERY_PREVIEW_MAX_LEN
        && trimmed.chars().all(char::is_alphanumeric)
}

fn is_fts_only_query(query: &SearchQuery, raw_query: &str) -> bool {
    is_short_preview_query(raw_query)
        || query.tokens().iter().filter(|token| !token.quoted).count() == 1
}

fn ranked_fetch_limit(limit: usize, total: usize) -> usize {
    if total <= limit {
        return total.max(1);
    }

    let adaptive = if total <= 1_000 {
        limit.saturating_mul(2)
    } else if total <= 5_000 {
        limit.saturating_mul(5)
    } else {
        limit.saturating_mul(10)
    };

    adaptive.clamp(limit.max(1), 2_000).min(total)
}

fn fetch_search_rows(
    conn: &Connection,
    match_query: &str,
    fetch_limit: i64,
    sort: SearchSort,
    role: SearchRole,
) -> Result<Vec<RankedSearchRow>, Box<dyn std::error::Error>> {
    let order = match sort {
        SearchSort::Relevance => "rank, relevance_score DESC",
        SearchSort::DateAsc => "created_at_score IS NULL, created_at_score ASC, m.id ASC",
        SearchSort::DateDesc => "created_at_score IS NULL, created_at_score DESC, m.id ASC",
    };
    let sql = format!(
        "SELECT m.id, m.conversation_id, m.role, m.content, c.title AS conversation_title,
                CAST(m.created_at AS REAL) AS relevance_score,
                CASE
                  WHEN typeof(m.created_at) IN ('integer', 'real') THEN CAST(m.created_at AS REAL)
                  WHEN m.created_at IS NULL THEN NULL
                  WHEN instr(CAST(m.created_at AS TEXT), '-') = 0
                    AND instr(CAST(m.created_at AS TEXT), 'T') = 0
                    AND instr(CAST(m.created_at AS TEXT), ':') = 0
                  THEN CAST(m.created_at AS REAL)
                  ELSE (julianday(m.created_at) - 2440587.5) * 86400.0
                END AS created_at_score
         FROM messages_fts
         JOIN messages m ON messages_fts.rowid = m.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?1
           AND {role_predicate}
         ORDER BY {order}
         LIMIT ?2",
        role_predicate = role.sql_predicate()
    );

    let mut stmt = conn.prepare_cached(&sql)?;
    stmt.query_map(params![match_query, fetch_limit], |sql_row| {
        let row = SearchRow {
            id: sql_row.get(0)?,
            conversation_id: sql_row.get(1)?,
            role: sql_row.get(2)?,
            content: sql_row.get(3)?,
            conversation_title: sql_row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            created_at: sql_row.get(6)?,
        };
        Ok(RankedSearchRow {
            score: sql_row.get::<_, Option<f64>>(5)?.unwrap_or_default(),
            row,
        })
    })?
    .collect::<Result<Vec<_>, _>>()
    .map_err(Into::into)
}

fn count_search_rows(
    conn: &Connection,
    match_query: &str,
    role: SearchRole,
) -> Result<(usize, bool), Box<dyn std::error::Error>> {
    let sql = format!(
        "SELECT COUNT(*)
         FROM messages_fts
         JOIN messages m ON messages_fts.rowid = m.rowid
         WHERE messages_fts MATCH ?1
           AND {}",
        role.sql_predicate()
    );
    let count = conn.query_row(&sql, params![match_query], |row| row.get::<_, i64>(0))?;
    Ok((count.max(0) as usize, false))
}

fn lower_bound_search_count(
    conn: &Connection,
    match_query: &str,
    lower_bound: usize,
    role: SearchRole,
) -> Result<(usize, bool), Box<dyn std::error::Error>> {
    let sql = format!(
        "SELECT 1
         FROM messages_fts
         JOIN messages m ON messages_fts.rowid = m.rowid
         WHERE messages_fts MATCH ?1
           AND {}
         LIMIT ?2",
        role.sql_predicate()
    );
    let probe_limit = (lower_bound + 1) as i64;
    let count = conn
        .prepare_cached(&sql)?
        .query_map(params![match_query, probe_limit], |_| Ok(()))?
        .count();
    Ok((count.min(lower_bound), count > lower_bound))
}

fn fts_index_has_terms(conn: &Connection) -> Result<bool, Box<dyn std::error::Error>> {
    let term_count = conn.query_row("SELECT COUNT(*) FROM messages_fts_idx", [], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(term_count > 0)
}

fn fts_columns_need_reset(
    conn: &Connection,
    index: &FtsIndexConfig,
) -> Result<bool, Box<dyn std::error::Error>> {
    let pragma = format!("PRAGMA table_info({})", index.fts_table);
    let columns = conn
        .prepare(&pragma)?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;

    if columns.is_empty() {
        return Ok(false);
    }

    Ok(columns != index.search_columns)
}
