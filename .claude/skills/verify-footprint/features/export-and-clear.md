# Export and clear

`/map export` writes every recorded call, unfiltered and redacted, to `~/.claude/footprint/trace-<session id>.jsonl` and copies the path to the clipboard. `/map clear` empties the map and forgets account lookups.

## Sub-features

- `export-file` one JSON line per call with `time`, `turn`, `outcome`, `class`, `tool`, `where`, `profile` (aws), `object`, `operation`, `description`, `command`.
- `export-reply` the prompt replies `Footprint: <n> calls written to <path>. Path copied.` (or `Path not copied (<reason>).`).
- `export-empty` with no calls: `Footprint: nothing to export yet.`
- `export-hotkey` hotkey `e` or the `[ export ]` button does the same and shows a toast.
- `export-overwrite` a later export of the same session overwrites the file.
- `clear` `/map clear` empties the pane back to `No aws, kubectl or MCP calls yet.`

## How to get to it (user POV)

- Type `/map export` or `/map clear`. Or focus the pane and press `e`.

## Driving it with drive.sh

Preconditions:

- Call capture drive done (so there is something to export).

- **Export.** `drive.sh export <name>`. It sends `/map export`, waits for the trace file and copies it to `~/.claude/footprint/verify/<name>/trace.jsonl`. Proven 2026-10-04: 4 lines, each `"outcome":"failed","class":"read"`, `where` equal to the pane's scope line, commands as typed.
- **Reply.** `drive.sh capture <name> export-reply` and find `Footprint: <n> calls written to`.
- **Empty export.** In a fresh instance with no calls, `drive.sh send <name> "/map export"`. Expect `Footprint: nothing to export yet.` and no new trace file.
- **Clear.** `drive.sh send <name> "/map clear"`, then `drive.sh pane <name>` shows `No aws, kubectl or MCP calls yet.` A following `/map export` replies `nothing to export yet` while the earlier trace file stays on disk.
- **Proof.** The copied `trace.jsonl`, plus captures before and after clear.

## Gotchas

- Export overwrites the user's clipboard with the path. Say so in the report.
- The trace file is keyed by session id. `drive.sh launch` sets it with `--session-id`, so the path is known up front.
- Commands are redacted before storage; to prove redaction, put a fake value like `--secret-string fpv-fake` in a failing read and check it is masked in both pane detail and trace.
