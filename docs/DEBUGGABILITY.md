# AIBackman debuggability contract

The executable contract is [../debuggability.toml](../debuggability.toml). It is schema version 5 and uses the `stateful` profile with the durable-mutation audit overlay.

Validate it with:

```bash
npm run validate:debuggability
```

## Modes

- `release-minimal` is the normal build. Optional diagnostics are not started. Archive mutation auditing remains active because it protects user data rather than serving as optional troubleshooting instrumentation.
- `release-observable` is the optimized production build with `AIBACKMAN_DIAGNOSTICS=1`. It enables the bounded redacted recorder and the private supervisor.
- `runtime-activated` is selected with `AIBACKMAN_DEBUG=1` for a bounded debugging session.
- `diagnostic-build` is produced by `npm run build:debug`; it adds source maps and is used by the release-debug commands.

Activated sessions expire after at most five minutes. The bridge window, Chromium file logging, remote debugging port, and detached DevTools are independently gated. The named release-debug commands explicitly enable logging and remote debugging, while the bridge remains hidden unless `electron:release:debug:bridge` is used.

## Evidence and control plane

The main process writes a bounded event ring and asynchronous session JSONL file. Events include a schema, sequence, wall and monotonic time, process/session identity, build identity, and optional operation/task correlation. Credential-shaped keys and values are redacted, strings/collections are capped, and raw message bodies are not written by the diagnostic runtime. Files and directories are private, sessions are isolated by unique names, snapshots are capped at 768 KiB, and all diagnostics are capped at 64 MiB and seven days.

The supervisor is a separate Node process reached over a private Unix socket. It retains a bounded cross-process event/state view and accepts only a random token stored with mode 0600. The control commands are:

```bash
npm run diagnose -- capabilities
npm run diagnose -- build-info
npm run diagnose -- snapshot
npm run diagnose -- events --last 100
```

Snapshots are explicitly `best-effort-cross-process`, not atomic. A snapshot reports its generation, heartbeat, task/resource registries, event drops, build identity, and recent semantic events.

## Durable archive safety

`ChatDatabase.runArchiveOperation` is the authoritative mutation boundary. The raw database handle and destructive capability are private. Connection-scoped SQLite functions make the persistent guard unforgeable through normal SQL, and triggers reject direct content, context, audit, recovery, and identity writes. Each operation binds an asserted in-process actor, writer component/instance, reason code, transaction/operation ID, store instance, and store generation; this is process provenance, not authenticated human identity.

Startup never recreates a missing `conversations` or `messages` table in an existing archive. It first snapshots the damaged file and refuses to open it. A v4 database with missing safety triggers is likewise snapshotted before those triggers are repaired. This prevents schema damage from being disguised as a valid empty cache.

The database-local audit row is committed in the same transaction as the mutation. The supplemental JSONL journal is fsynced, exclusively locked, hash chained, permission restricted, bounded to 64 KiB per event and 256 MiB by default, and never silently rotated. If its pre-commit record cannot be written or its budget is exhausted, the mutation is refused. Recovery snapshots and exact deleted rows are retained until explicit maintenance.

Message audit values contain lengths and hashes rather than message bodies. Exact deleted rows and prior message, conversation, and source-item revisions remain in the immutable recovery table. Explicit restore methods require the exact entity identifier and an audit reason. Pre-migration and destructive bulk snapshots are integrity-checked and retained outside diagnostic cleanup.

Install or verify the current safety schema across the default and legacy archive roots with:

```bash
npm run archive:migrate-safety
npm run archive:verify-safety
```

Every pre-v4 database is checkpointed and copied to a verified recovery snapshot before its schema changes. Migration refuses a database that fails SQLite `quick_check` or whose conversation/message counts change.

## Performance and retention

The optional recorder is not created in `release-minimal`. The performance gate measures 250,000 disabled calls, activated record p99, snapshot latency, and one hundred guarded 200-message transactions against raw SQLite. Always-on archive auditing is measured separately because it is data protection, not optional debugging. On the reference machine, disabled calls average roughly 0.000002 ms, activated recording is roughly 0.03 ms p99, and a guarded 200-message transaction is roughly 20–25 ms median.

Run `npm run diagnostics:secure` to apply private permissions and the same retention policy to diagnostic artifacts created by older builds. Recovery snapshots and archive audit data are not touched by this command.

## Assurance

```bash
npm run test:diagnostics
npm run test:archive:safety
npm run test:debuggability:performance
npm run validate:debuggability
```

CI runs the validator, lint, renderer/highlight tests, diagnostic fault injection, archive/import safety, performance gates, and the production build. Exact packaged-artifact symbol retention, real Electron crash/OOM capture, and full deterministic conversation replay remain explicitly `implemented_untested`; they are not implied capabilities.
