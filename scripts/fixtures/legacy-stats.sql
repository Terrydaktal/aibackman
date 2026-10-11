-- Pre-optimization query retained only as a differential regression oracle.

      WITH eligible_messages AS (
        SELECT
          m.conversation_id,
          m.role,
          m.created_at,
          CASE
            WHEN typeof(m.created_at) IN ('integer', 'real') THEN CAST(m.created_at AS REAL)
            WHEN m.created_at IS NULL THEN NULL
            WHEN instr(CAST(m.created_at AS TEXT), '-') = 0
              AND instr(CAST(m.created_at AS TEXT), 'T') = 0
              AND instr(CAST(m.created_at AS TEXT), ':') = 0
            THEN CAST(m.created_at AS REAL)
            ELSE (julianday(m.created_at) - 2440587.5) * 86400.0
          END AS created_at_unix,
          m.id,
          COALESCE(json_extract(m.metadata_json, '$.source'), '') AS source,
          COALESCE(json_extract(m.metadata_json, '$.phase'), '') AS phase
        FROM messages AS m
        JOIN conversations AS c ON c.id = m.conversation_id
        WHERE IFNULL(c.is_deleted_on_web, 0) = 0
          AND m.role IN ('user', 'assistant')
          AND trim(COALESCE(m.content, '')) <> ''
          AND COALESCE(json_extract(m.metadata_json, '$.is_thinking_preamble_message'), 0) != 1
          AND COALESCE(json_extract(m.metadata_json, '$.is_visually_hidden_from_conversation'), 0) != 1
      ),
      ordered_messages AS (
        SELECT
          eligible_messages.*,
          LAG(role) OVER (
            PARTITION BY conversation_id
            ORDER BY created_at, id
          ) AS previous_role
        FROM eligible_messages
      ),
      codex_runs AS (
        SELECT
          ordered_messages.*,
          SUM(
            CASE
              WHEN role = 'assistant'
                AND source IN ('codex-local', 'gemini-cli-local')
                AND COALESCE(previous_role, '') != 'assistant'
              THEN 1
              ELSE 0
            END
          ) OVER (
            PARTITION BY conversation_id
            ORDER BY created_at, id
            ROWS UNBOUNDED PRECEDING
          ) AS assistant_run
        FROM ordered_messages
      ),
      codex_responses AS (
        SELECT conversation_id, assistant_run
        FROM codex_runs
        WHERE role = 'assistant' AND source IN ('codex-local', 'gemini-cli-local')
        GROUP BY conversation_id, assistant_run
        HAVING MAX(CASE WHEN phase != 'commentary' THEN 1 ELSE 0 END) = 1
      )
      SELECT
        (SELECT COUNT(*) FROM conversations WHERE IFNULL(is_deleted_on_web, 0) = 0) AS conversation_count,
        -- Keep internal/tool rows and Codex commentary fragments available for
        -- rendering, but do not present them as separate archive messages. A
        -- local agent response may contain several consecutive stream events,
        -- so count that run once.
        (
          SELECT COUNT(*)
          FROM eligible_messages
          WHERE NOT (
            role = 'assistant'
            AND source IN ('codex-local', 'gemini-cli-local')
          )
        ) + (SELECT COUNT(*) FROM codex_responses) AS message_count,
        (SELECT COUNT(DISTINCT conversation_id) FROM messages) AS cached_count,
        (SELECT MAX(created_at_unix) FROM eligible_messages) AS latest_message_at,
        (
          SELECT MAX(
            CASE
              WHEN typeof(updated_at) IN ('integer', 'real') THEN CAST(updated_at AS REAL)
              WHEN updated_at IS NULL THEN NULL
              WHEN instr(CAST(updated_at AS TEXT), '-') = 0
                AND instr(CAST(updated_at AS TEXT), 'T') = 0
                AND instr(CAST(updated_at AS TEXT), ':') = 0
              THEN CAST(updated_at AS REAL)
              ELSE (julianday(updated_at) - 2440587.5) * 86400.0
            END
          )
          FROM conversations
        ) AS latest_updated_at
