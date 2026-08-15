# AIBackman

A local-first Electron archive for browsing and searching conversations from multiple AI agents and accounts. The application keeps each account in an independent SQLite database, presents all agents and accounts on one home page, and searches every archive from one global search field.

The existing live ChatGPT and Google AI Mode bridges remain available for their default accounts. Official exports and local coding-agent histories are handled by narrow provider plugins.

## Supported Sources

| Agent | Live bridge | Official backup | Local history |
| --- | --- | --- | --- |
| ChatGPT | Read, sync, send, cache | `conversations.json`, export directory, or ZIP | No |
| Google AI Mode | Read and sync | Google Takeout My Activity JSON, directory, or ZIP | No |
| Gemini | No | Google Takeout Gemini Apps JSON, directory, or ZIP | No |
| Codex | No | No | `~/.codex/sessions/**/*.jsonl`, separated by discovered account |
| Antigravity | No | No | `~/.gemini/antigravity-cli` transcripts |

Backup accounts are read-only snapshots. Multiple backups from the same provider can coexist. Reimporting into a backup account replaces that account's snapshot; it never clears another account's database. Local providers fingerprint source files and skip unchanged sessions.

## Project Structure

```text
.
├── electron/
│   ├── accounts/
│   │   ├── catalog.cjs       # Central account registry
│   │   └── manager.cjs       # Account DB lifecycle, imports, refresh, global search
│   ├── agents/
│   │   ├── registry.cjs      # Provider registration
│   │   ├── chatgpt.cjs       # ChatGPT official export adapter
│   │   ├── google-ai-mode.cjs# AI Mode Takeout adapter
│   │   ├── gemini.cjs        # Gemini Takeout adapter
│   │   ├── codex.cjs         # Local Codex session adapter
│   │   ├── antigravity.cjs   # Local Antigravity transcript adapter
│   │   └── utils.cjs         # Safe ZIP/materialization and adapter helpers
│   ├── bridges/
│   │   ├── chatgpt.cjs       # ChatGPT live-site automation and extraction
│   │   └── ai-mode.cjs       # Google AI Mode live-site automation and extraction
│   ├── conversations/
│   │   └── chatgpt-tree.cjs  # Branch reconstruction and snapshot safeguards
│   ├── ipc/archive.cjs       # Archive/account/database IPC boundary
│   ├── services/
│   │   └── chatgpt-cache.cjs # Pacing, retries, cancellation, and cache progress
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
│   │   ├── ChatPresentation.tsx      # Message/markdown/branch presentation
│   │   ├── useArchiveSearch.ts       # Search across one account database
│   │   ├── useMessageNavigation.ts   # In-chat matching, highlighting, and jumps
│   │   ├── useCacheManagement.ts     # Cache runs, markers, and progress
│   │   ├── useWorkspaceLayout.ts     # Persistent panels and zoom behavior
│   │   └── useWorkspaceDiagnostics.ts# Opt-in renderer diagnostics
│   ├── components/           # Shared renderer components
│   ├── search/               # Crash-safe native highlight helpers
│   ├── types/                # Renderer and IPC contracts
│   └── index.css
├── scripts/
│   ├── test-archive-imports.cjs       # Provider/account regression suite
│   ├── test-highlight.mjs             # Search highlighting regression suite
│   └── reconcile-aimode-takeout.cjs   # Standalone AI Mode reconciliation
├── tools/
│   ├── db-search/             # Rust streaming SQLite search helper
│   └── aibackdiff/            # GUI AI archive backup/database comparator
└── package.json
```

## Architecture

Dependencies point inward in this order:

1. `database.cjs` owns one account's storage and search-worker lifecycle.
2. `agents/*` translate one external source into the common conversation/message schema.
3. `accounts/manager.cjs` resolves accounts, opens databases lazily, invokes plugins, and combines global-search results.
4. `bridges/*`, `conversations/*`, and `services/*` own live-site automation, branch reconstruction, and cache workflows behind narrow interfaces.
5. `ipc/archive.cjs` exposes account operations without knowing provider formats.
6. `main.cjs` composes Electron windows, authentication, account services, and live-provider runtimes.
7. Renderer features consume account capabilities and do not branch on storage paths; chat hooks isolate database search, in-chat navigation, cache runs, layout, and diagnostics from the account coordinator.

An agent plugin exports metadata plus one or more narrow operations:

```js
module.exports = {
  id: 'provider-id',
  name: 'Provider',
  description: 'Source description',
  accent: '#000000',
  capabilities: { importBackup: true, localBackup: true },
  discoverAccounts, // optional
  importBackup,     // optional: ({ db, inputPath, replaceExisting, sourceConfig })
  refreshLocal,     // optional: ({ db, sourceConfig, onProgress })
};
```

Register a new plugin once in `electron/agents/registry.cjs`. It must write through the `ChatDatabase` API rather than opening another account's SQLite file.

## Database Layout

On Linux, Electron normally stores the archive under `~/.config/aibackman/`:
the first launch after upgrading migrates the legacy `~/.config/chatgpt/`
directory when it is present.

```text
~/.config/aibackman/
├── archive-catalog.db  # Account identity, provider, source kind, DB path
├── chatgpt.db          # Existing default live ChatGPT account
├── aimode.db           # Existing default live Google AI Mode account
└── accounts/
    └── account-*.db    # Backup and local-agent accounts
```

Every account database contains:

- `conversations`: title, timestamps, current branch node, deletion/sync state.
- `messages`: stable message ID, role, content, metadata, timestamp, and parent ID.
- `cache_failures`: non-destructive live-sync failure tracking.
- `source_items`: source path and fingerprint for incremental local imports.

SQLite uses WAL mode, normal synchronous writes, a busy timeout, foreign keys, an in-memory temp store, and indexes for conversation ordering and message traversal. Search runs through the persistent Rust `db-search` worker, with SQLite `LIKE` as a fallback.

## Operation

### Add an official backup

1. Open the archive home page.
2. Select `Add backup` under ChatGPT, Google AI Mode, or Gemini.
3. Give the account/snapshot a label.
4. Select an export JSON file, extracted export directory, or ZIP.
5. The provider adapter imports into a new isolated account database.

Use `Import backup` on an existing account when the export belongs to that
account and should update its current database. Use `Add backup` when the
export should remain a separate account. Account labels can be changed from
the home page; live ChatGPT and Google AI Mode accounts are renamed to the
detected signed-in email when the site exposes it, unless a custom label has
already been set.

ZIP entries are validated before extraction; absolute paths, drive-prefixed paths, parent traversal, and extracted symbolic links are rejected.

### Back up local Codex or Antigravity chats

1. Start the app so local accounts are discovered.
2. Select `Refresh all local` on the provider, or `Refresh local` on one account.
3. Changed JSONL transcripts are streamed and atomically replaced per conversation.
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
- `npm run test:archive`: test all backup/local adapters, account refresh, and cross-account search under Electron's native Node ABI.
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
cargo test --manifest-path tools/db-search/Cargo.toml
cargo test --manifest-path tools/aibackdiff/Cargo.toml
npm run build
```

## Release Debugging

`npm run electron:release:debug` builds production code with source maps, enables persistent diagnostics, exposes the renderer DevTools endpoint at `http://127.0.0.1:9222`, and exposes the main-process Node inspector at `127.0.0.1:9229`.

- Diagnostics: `~/.config/aibackman/debug/events-*.jsonl` and `chromium-*.log`.
- Crash dumps: `~/.config/aibackman/debug/crashes/`.
- Set `AIBACKMAN_OPEN_DEVTOOLS=1` to open detached renderer DevTools automatically.
- For a native debugger, find the Electron PID with `pgrep -a -f 'node_modules/electron/dist/electron'`, then attach with `gdb -p PID`.

## Inputs and Outputs

Inputs include authenticated live web sessions, official provider exports, local Codex/Antigravity JSONL histories, prompts, attachments, and images. Outputs are isolated SQLite account archives, the central catalog, the desktop browsing/search interface, renderer artifacts in `dist/`, optional diagnostics, and clipboard image data.

This project depends on undocumented live website structure for ChatGPT and Google AI Mode. Provider export/local adapters are intentionally isolated so a website change does not affect stored archives or unrelated agents.
