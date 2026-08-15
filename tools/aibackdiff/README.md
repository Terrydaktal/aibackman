# AIBackdiff

`aibackdiff` is a read-only native GUI for comparing any two AI archive
databases or official backups.

Run it from the project root:

```sh
npm run aibackdiff
```

Choose a baseline source and a comparison source. Either source can be:

- An `aimode.db` SQLite database.
- A Takeout `MyActivity.json` file.
- An extracted Takeout directory.

The source type is detected automatically. This supports database-to-backup,
database-to-database, and backup-to-backup comparisons.

The report separates:

- Chats added in the comparison source.
- Chats present in the baseline but missing from the comparison source.
- Existing chats with new messages.
- Existing chats with messages missing from the new backup.
- Existing chats whose message strings differ between the two sources.
- Unchanged chats.

Select a changed chat to inspect each added, missing, or modified message. The
report can also be exported as JSON. Comparing and exporting do not modify the
selected sources.

Chat matching first uses identical message transcripts. Remaining chats are
matched conservatively using their title, first user message, first assistant
message, and creation-time proximity. Message changes are found with an ordered
sequence diff, so missing messages in the middle of a chat are reported.
