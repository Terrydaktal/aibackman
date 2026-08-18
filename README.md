# AIBackman

A local-first Electron archive for browsing and searching conversations from multiple AI agents and accounts. The application keeps each account in an independent SQLite database, presents all agents and accounts on one home page, and searches every archive from one global search field.

The existing live ChatGPT and Google AI Mode bridges remain available for their default accounts. Official exports and local coding-agent histories are handled by narrow provider plugins.

## Supported Sources

| Agent | Live bridge | Official backup | Local history |
| --- | --- | --- | --- |
| ChatGPT | Read, sync, send, cache | `conversations.json`, export directory, or ZIP | No |
| Google AI Mode | Read and sync | Google Takeout My Activity JSON, directory, or ZIP | No |
| Gemini | No | Google Takeout Gemini Apps JSON, directory, or ZIP | No |
| Claude | No | Claude `conversations.json`, directory, or ZIP | No |
| DeepSeek | No | DeepSeek `conversations.json` or directory | No |
| Grok | No | Grok `prod-grok-backend.json` export directory or ZIP | No |
| ChatHub | No | ChatHub Chromium or Firefox browser profile / IndexedDB directory | No |
| Codex | No | No | `~/.codex/sessions/**/*.jsonl`, separated by discovered account |
| Antigravity | No | No | `~/.gemini/antigravity-cli` transcripts |
| Gemini CLI | No | No | `~/.gemini/tmp` session files |

Backup accounts are read-only in the viewer. Multiple backups from the same provider can coexist. Reimporting always merges into that account: a missing conversation or message is never interpreted as a deletion. Local providers fingerprint source files and skip unchanged sessions.

## Project Structure

```text
.
├── electron/
│   ├── accounts/
│   │   ├── catalog.cjs       # Central account registry
│   │   └── manager.cjs       # Account DB lifecycle, imports, refresh, global search
│   ├── agents/
│   │   ├── registry.cjs      # Compatibility entry point to provider registry
│   │   ├── utils.cjs         # Safe ZIP/materialization and adapter helpers
│   │   ├── firefox-indexeddb.cjs # Firefox structured-clone IndexedDB decoder
│   │   └── google-accounts.cjs   # Shared Google local-account discovery
│   ├── archive/
│   │   ├── standard/
│   │   │   ├── index.cjs     # Universal archive read/write facade
│   │   │   ├── writer.cjs    # Non-destructive standard records -> SQLite merge
│   │   │   └── reader.cjs    # Standard SQLite -> conversations/messages/state
│   │   └── safety/
│   │       ├── schema.cjs    # Delete guards, immutable audit, row recovery
│   │       └── journal.cjs   # Durable JSONL journal, DB snapshots, quarantine
│   ├── providers/
│   │   ├── registry.cjs      # Canonical provider registration
│   │   ├── scrapers/         # One bespoke live-site scraper per provider
│   │   ├── backup-parsers/   # One bespoke export/local-backup parser per provider
│   │   ├── formatters/       # Provider-specific cleanup before universal storage
│   │   └── shared/           # Provider composition and unsupported-scraper helpers
│   ├── bridges/
│   │   ├── chatgpt.cjs       # ChatGPT live-site automation and extraction
│   │   └── ai-mode.cjs       # Google AI Mode live-site automation and extraction
│   ├── conversations/
│   │   ├── chatgpt-tree.cjs  # Branch reconstruction and snapshot safeguards
│   │   └── chatgpt-protocol.cjs # ChatGPT internal tool-node classification
│   ├── ipc/archive.cjs       # Archive/account/database IPC boundary
│   ├── services/
│   │   └── chatgpt-cache.cjs # Pacing, retries, cancellation, and cache progress
│   ├── diagnostics/           # Bounded recorder, supervisor, and build identity
│   ├── main.cjs              # Electron startup, windows, and IPC orchestration
│   ├── database.cjs          # Per-account SQLite schema and query API
│   ├── aimode-takeout.cjs    # Shared Google activity parser
│   ├── auth.cjs              # ChatGPT session and authenticated requests
│   ├── bridge-preload.cjs    # Isolated live bridge preload
│   └── preload.cjs           # Renderer IPC exposure
├── src/
│   ├── App.tsx               # Home/account route shell
│   ├── features/home/        # Agent directory and global search
│   ├── features/chat/
│   │   ├── ChatWorkspace.tsx         # Account session and composer coordinator
│   │   ├── useArchiveSearch.ts       # Search across one account database
│   │   ├── useMessageNavigation.ts   # In-chat matching, highlighting, and jumps
│   │   ├── useCacheManagement.ts     # Cache runs, markers, and progress
│   │   ├── useWorkspaceLayout.ts     # Persistent panels and zoom behavior
│   │   └── useWorkspaceDiagnostics.ts# Opt-in renderer diagnostics
│   ├── archive/
│   │   └── standard/
│   │       └── UniversalArchivePresenter.tsx # One presenter for every provider
│   ├── components/           # Shared renderer components
│   ├── search/               # Crash-safe native highlight helpers
│   ├── types/                # Renderer and IPC contracts
│   └── index.css
├── scripts/
│   ├── test-archive-imports.cjs       # Provider/account regression suite
│   ├── test-archive-safety.cjs        # Deletion/overwrite/recovery suite
│   ├── test-diagnostics.cjs           # Fault injection, bounds, privacy, and shutdown
│   ├── test-debuggability-performance.cjs # Optional/always-on overhead gates
│   ├── validate-debuggability.py      # Portable strict contract validator
│   ├── migrate-archive-safety.cjs     # Snapshot, migrate, and verify archive databases
│   ├── test-highlight.mjs             # Search highlighting regression suite
│   └── reconcile-aimode-takeout.cjs   # Standalone AI Mode reconciliation
├── tools/
│   ├── db-search/             # Rust streaming SQLite search helper
│   └── aibackdiff/            # GUI AI archive backup/database comparator
└── package.json
```

## Architecture

Dependencies point inward in this order:

1. `database.cjs` owns one account's SQLite schema and low-level storage lifecycle.
2. `providers/scrapers/<provider>.cjs` owns live-site extraction for one provider. A provider without live support has an explicit unsupported scraper instead of silently sharing another site's logic.
3. `providers/backup-parsers/<provider>.cjs` owns that provider's export/local-history format.
4. `providers/formatters/<provider>.cjs` removes source-specific presentation/control markup before provider output reaches the universal archive contract.
5. `archive/standard/writer.cjs` normalizes provider output and is the only shared insertion path for imported, scraped, and local snapshots. Its writes are merge-only.
6. `archive/safety/*` guards destructive SQL, versions overwritten rows, snapshots bulk operations, and records durable audit events below every provider.
7. `archive/standard/reader.cjs` is the only standard database read/state path used to return conversations and messages to the application.
8. `src/archive/standard/UniversalArchivePresenter.tsx` is the shared renderer for every provider; it consumes the same universal conversation/message format and can clean legacy records at display time.
9. `accounts/manager.cjs` resolves accounts, opens databases lazily, invokes parser plugins, and combines global-search results.
10. `bridges/*`, `conversations/*`, and `services/*` own live-site automation, source-specific branch safeguards, and cache workflows behind narrow interfaces.
11. `ipc/archive.cjs` exposes account operations without knowing provider formats, while `main.cjs` composes Electron windows, authentication, account services, and live-provider runtimes.

The provider registry pairs each provider implementation with its scraper and backup parser:

```js
module.exports = {
  id: 'provider-id',
  name: 'Provider',
  description: 'Source description',
  accent: '#000000',
  capabilities: { importBackup: true, localBackup: true },
  siteScraper,      // provider-specific live site extraction contract
  backupParser,     // provider-specific export/local-history parser
  discoverAccounts, // optional local-account discovery
};
```

Register a provider once in `electron/providers/registry.cjs`, alongside its scraper and backup-parser paths. Scrapers and parsers may understand only their own source format; they return the universal conversation/message shape and write through `electron/archive/standard/writer.cjs`. They must not open another account's SQLite file or create provider-specific tables. `electron/agents/registry.cjs` remains only as a compatibility import for older modules.

## Database Layout

On Linux, Electron normally stores the archive under `~/.config/aibackman/`:
the first launch after upgrading migrates the legacy `~/.config/chatgpt/`
directory when it is present.

```text
~/.config/aibackman/
├── archive-catalog.db  # Account identity, provider, source kind, DB path
├── chatgpt.db          # Existing default live ChatGPT account
├── aimode.db           # Existing default live Google AI Mode account
├── audit/
│   └── archive-mutations.jsonl # Fsynced cross-database operation journal
├── recovery/
│   ├── database-snapshots/     # Verified pre-import/migration/clear snapshots
│   └── deleted-accounts/       # Quarantined DB files plus account manifests
└── accounts/
    ├── account-*.db    # Backup and local-agent accounts
    └── assets/          # Copied provider attachments, grouped by account DB
```

Every account database contains:

- `conversations`: title, timestamps, current branch node, deletion/sync state.
- `messages`: stable message ID, role, content, metadata, timestamp, and parent ID.
- `cache_failures`: non-destructive live-sync failure tracking.
- `source_items`: source path and fingerprint for incremental local imports.
- `archive_audit_log`: immutable operation summaries and before/after row versions.
- `archive_recovery_records`: immutable complete rows captured before permitted deletion.
- `archive_operation_context`: a normally closed transactional destructive-write guard.

SQLite uses WAL mode, full synchronous writes, a busy timeout, foreign keys, an in-memory temp store, and indexes for conversation ordering and message traversal. Search runs through the persistent Rust `db-search` worker, with SQLite `LIKE` as a fallback.

### Archive safety and recovery

Normal imports, live snapshots, index refreshes, and local-history refreshes may insert or update records but may not reduce the conversation or message count. Requests that previously used replacement semantics now merge, and omitted rows are retained. Updating a message keeps bounded previous and next typed summaries (lengths and SHA-256 hashes) in `archive_audit_log`; exact rows are retained for permitted deletion recovery, and attempts to turn non-empty content into an empty value are rejected.

SQLite triggers reject direct deletion from `conversations` and `messages` unless a short-lived destructive guard is opened inside a named transaction with an actor and reason. A permitted deletion first copies every affected row to `archive_recovery_records`. The viewer requires the exact conversation ID as confirmation, and `db:restoreConversation` can reconstruct the conversation from those records. Full-archive clearing additionally requires the literal maintenance confirmation and a verified database snapshot.

Before a populated database is imported into or migrated, AIBackman checkpoints its WAL, copies the database, runs `PRAGMA quick_check` on the copy, and writes a manifest under `recovery/database-snapshots/`. Removing an account moves its database, WAL, and manifest into `recovery/deleted-accounts/` instead of unlinking them. Recovery files are never rotated automatically.

Every named write records start/completion/failure events in the fsynced, hash-chained `audit/archive-mutations.jsonl` journal. The database-local trail can be inspected with:

```bash
sqlite3 ~/.config/aibackman/chatgpt.db \
  "SELECT sequence, occurred_at, operation_type, action, entity_type, entity_id, reason FROM archive_audit_log ORDER BY sequence DESC LIMIT 100;"
```

## Operation

### Add an official backup

1. Open the archive home page.
2. Select `Add backup` under the provider that produced the export.
3. Give the account/snapshot a label.
4. Select an export JSON file, extracted export directory, or ZIP.
5. The provider adapter imports into a new isolated account database.

Use `Import backup` on an existing account when the export belongs to that
account and should update its current database. Use `Add backup` when the
export should remain a separate account. Account labels can be changed from
the home page; live ChatGPT and Google AI Mode accounts are renamed to the
detected signed-in email when the site exposes it, unless a custom label has
already been set.

ZIP entries are validated before extraction; absolute paths, drive-prefixed paths, parent traversal, and extracted symbolic links are rejected. Claude and DeepSeek imports preserve exported text and metadata. Grok and Gemini imports copy referenced local assets into managed per-account storage so images and files remain available after the source export moves. ChatHub imports Chromium `keyval-store` data through an isolated browser session and decodes Firefox structured-clone IndexedDB data, preserving conversations from each model in either browser backup.

The Gemini web Takeout format currently exported by Google stores user prompts in
`Prompted ...` titles and responses in the HTML payload. The adapter handles that
format as well as the older labeled HTML format. Select the extracted `Gemini Apps`
directory when it contains `MyActivity.json` and its companion files.

### Back up local Codex or Antigravity chats

1. Start the app so local accounts are discovered.
2. Select `Refresh all local` on the provider, or `Refresh local` on one account.
3. Changed JSONL transcripts are streamed and merged per conversation; prior rows omitted by a partial parse are retained.
4. Unchanged source fingerprints are skipped on later runs.

The home page reports imported chats/messages, unchanged files, and parse
errors after each local refresh. A local provider such as Antigravity has no
provider email to discover, so its default label is `Local Antigravity` and
can be renamed manually.

Codex reads all system sessions and routes them by the account IDs found in session events. Sessions without an account ID are kept in the `Local sessions (unattributed)` account.

### Global search

1. Search from the home page.
2. The account manager queries all account databases concurrently.
3. Results include provider, account, chat, role, and message identity.
4. Selecting a result opens the correct account, chat, message, and highlight query.

### Live synchronization

The default ChatGPT and Google AI Mode accounts retain their bridge-specific controls. Live responses that look partial or interrupted do not replace a more complete cached conversation. Cache-all supports progress, retries, cancellation, and preservation of locally cached deleted chats.

The Google AI Mode section also has `Compare backups`, which opens the
`AIBackdiff` GUI. It compares the default AI Mode database with another
database or Takeout backup and reports added, missing, changed, and unchanged
chats. The same GUI can be started directly with `npm run aibackdiff`.

## Commands

- `npm install`: install JavaScript and Electron dependencies.
- `npm run electron:dev`: start Vite and the Electron application in development mode.
- `npm run build`: TypeScript check plus production renderer build into `dist/`.
- `npm run lint`: run ESLint, including strict React hooks/compiler checks.
- `npm run test:archive`: test all backup/local adapters, account refresh, cross-account search, destructive-write guards, audit records, snapshots, and restoration under Electron's native Node ABI.
- `npm run test:archive:safety`: run only the destructive-write, audit, snapshot, and recovery regression suite.
- `npm run test:diagnostics`: test diagnostic mode bounds, redaction, build identity, supervisor control, and shutdown.
- `npm run test:debuggability:performance`: enforce disabled/activated diagnostic and always-on audit budgets.
- `npm run test:debuggability`: run the complete debuggability contract, fault-injection, archive-safety, and performance suite.
- `npm run validate:debuggability`: strictly validate the repository-local debuggability contract.
- `npm run diagnose -- capabilities|build-info|snapshot|events`: query the private bounded diagnostic control plane without opening DevTools.
- `npm run diagnostics:secure`: privatize and prune legacy diagnostic artifacts without touching archives or recovery snapshots.
- `npm run archive:migrate-safety`: snapshot and migrate every discovered archive database to the current safety schema.
- `npm run archive:verify-safety`: verify that every discovered archive database has the current safety schema.
- `npm run test:highlight`: run crash/highlight regression checks.
- `cargo test --manifest-path tools/db-search/Cargo.toml`: test the Rust search worker.
- `cargo test --manifest-path tools/aibackdiff/Cargo.toml`: test the backup comparison GUI core.
- `npm run aibackdiff`: run the AI archive backup/database comparison GUI.
- `npm run aimode:reconcile-takeout -- DATABASE TAKEOUT`: diagnose and optionally reconcile an AI Mode database from Takeout.
- `npm run electron:release`: build and start the production application.
- `npm run preview`: serve the built renderer locally.

Recommended validation order:

```bash
npm run lint
npm run test:highlight
npm run test:archive
npm run test:debuggability
cargo test --manifest-path tools/db-search/Cargo.toml
cargo test --manifest-path tools/aibackdiff/Cargo.toml
npm run build
```

## Release Debugging

`npm run electron:release:debug` builds production code with source maps, enables a bounded five-minute diagnostic session and Chromium logging, exposes the renderer DevTools endpoint at `http://127.0.0.1:9222`, and exposes the main-process Node inspector at `127.0.0.1:9229`. Normal and observable releases do not open either debugging port. The hidden bridge remains hidden unless `electron:release:debug:bridge` or `AIBACKMAN_BRIDGE_VISIBLE=1` is explicitly used.

- Diagnostics: `~/.config/aibackman/debug/events-*.jsonl` and `chromium-*.log`.
- Crash dumps: `~/.config/aibackman/debug/crashes/`.
- Machine-readable control: `npm run diagnose -- snapshot` (private Unix socket, 2-second timeout, bounded response).
- Exact build identity: `dist/build-info.json` includes source and artifact digests, and its `build_id` is carried in every diagnostic snapshot/event.
- Production startup refuses a stale `dist/build-info.json`; rebuild rather than debugging mismatched source and artifacts.
- Set `AIBACKMAN_OPEN_DEVTOOLS=1` to open detached renderer DevTools automatically.
- For a native debugger, find the Electron PID with `pgrep -a -f 'node_modules/electron/dist/electron'`, then attach with `gdb -p PID`.

## Inputs and Outputs

Inputs include authenticated live web sessions, official ChatGPT/Google/Gemini/Claude/DeepSeek/Grok exports, ChatHub Chromium/Firefox browser storage, local Codex/Antigravity JSONL histories, prompts, attachments, and images. Outputs are isolated SQLite account archives, the central catalog, the desktop browsing/search interface, managed archive assets, renderer artifacts in `dist/`, optional diagnostics, and clipboard image data.

This project depends on undocumented live website structure for ChatGPT and Google AI Mode. Provider export/local adapters are intentionally isolated so a website change does not affect stored archives or unrelated agents.
