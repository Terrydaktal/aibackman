#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryToken {
    pub text: String,
    pub quoted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchQuery {
    raw: String,
    tokens: Vec<QueryToken>,
}

impl SearchQuery {
    pub fn new(query: impl Into<String>) -> Self {
        let raw = query.into();
        let tokens = parse_query_tokens(&raw);
        Self { raw, tokens }
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }

    pub fn tokens(&self) -> &[QueryToken] {
        &self.tokens
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}

pub fn parse_query_tokens(query: &str) -> Vec<QueryToken> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in query.chars() {
        if ch == '"' {
            if in_quotes {
                push_token(&mut tokens, &mut current, true);
                in_quotes = false;
            } else {
                push_split_tokens(&mut tokens, &mut current);
                in_quotes = true;
            }
        } else {
            current.push(ch);
        }
    }

    if in_quotes {
        push_token(&mut tokens, &mut current, true);
    } else {
        push_split_tokens(&mut tokens, &mut current);
    }

    tokens
}

fn push_split_tokens(tokens: &mut Vec<QueryToken>, current: &mut String) {
    let text = std::mem::take(current);
    for part in text.split_whitespace() {
        let trimmed = part.trim();
        if !trimmed.is_empty() {
            tokens.push(QueryToken {
                text: trimmed.to_owned(),
                quoted: false,
            });
        }
    }
}

fn push_token(tokens: &mut Vec<QueryToken>, current: &mut String, quoted: bool) {
    let text = std::mem::take(current);
    let trimmed = text.trim();
    if !trimmed.is_empty() {
        tokens.push(QueryToken {
            text: trimmed.to_owned(),
            quoted,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{QueryToken, SearchQuery, parse_query_tokens};

    #[test]
    fn parses_unquoted_and_quoted_tokens() {
        assert_eq!(
            parse_query_tokens(r#"hello "two words" OR test"#),
            vec![
                QueryToken {
                    text: "hello".into(),
                    quoted: false,
                },
                QueryToken {
                    text: "two words".into(),
                    quoted: true,
                },
                QueryToken {
                    text: "OR".into(),
                    quoted: false,
                },
                QueryToken {
                    text: "test".into(),
                    quoted: false,
                },
            ]
        );
    }

    #[test]
    fn unclosed_quote_keeps_phrase_token() {
        assert_eq!(
            parse_query_tokens(r#""hello world"#),
            vec![QueryToken {
                text: "hello world".into(),
                quoted: true,
            }]
        );
    }

    #[test]
    fn search_query_wraps_raw_and_tokens() {
        let query = SearchQuery::new("hello world");
        assert_eq!(query.raw(), "hello world");
        assert_eq!(query.tokens().len(), 2);
        assert!(!query.is_empty());
    }
}
