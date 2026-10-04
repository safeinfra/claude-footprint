# footprint verification map

This directory is the maintained source for verifying what a footprint user sees. Read this index before driving, then use the matching feature file as the recipe. All commands are `drive.sh` subcommands, run as `.claude/skills/verify-footprint/drive.sh <sub> <name> ...` from the repo root.

## Baseline preconditions

- A fresh instance from `drive.sh launch <name>`. Never drive a claude session this run did not start.
- `drive.sh doctor <name>` shows `ok` for the tmux session, session id, claude banner and `idle at prompt`.
- AWS and kube config inside the instance are the empty scratch files `launch` created. No real account or cluster is reachable.
- The pane is open: `drive.sh send <name> "/map"` and `drive.sh pane <name>` shows `[ all ] [ write ] [ turn ] [ collapse ] [ export ]`.

## Driving conventions

- Make calls happen by asking the nested Claude, in plain words, to run exact commands. Always use profile `fpv-none` and context `fpv-none`. Then `drive.sh wait <name>`.
- Read-only verbs only (`describe-*`, `get`, `list-*`, `config get-contexts`, `version --client`). Destructive or credential verbs are out of scope for live drives; see SKILL.md safety rules.
- Ask for `safe-aws` / `safe-kubectl` (allowed by the user's settings; footprint counts them as `aws` / `kubectl`). Say "nothing added, do not retry": otherwise the nested Claude appends `; echo $?` (flips failed to worked) or retries (doubles counts).
- Treat commands and pane strings as literal.

## Proof and skip reporting

- Capture after the action, not just at the end: `drive.sh capture <name> <feature>-<step>`.
- Pane proof is the pane column (`drive.sh pane`) plus the saved full screen.
- Recording proof also needs `drive.sh export <name>` and the matching lines in `trace.jsonl`.
- If a call was denied or blocked, read the screen before judging the pane: a hook block showed as a `failed` row, a denial should show no row. Report it as "not driven: denied/blocked", never as verified.
- Do not report an entry point as verified through a different one (e.g. `/map write` vs the `w` hotkey).

## Feature entry contract

Each feature file starts with an H1 and one paragraph on the user-visible behaviour, then exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.sh` (starts with `Preconditions:`), `Gotchas`. No implementation details: only user paths, pane strings, commands and observable proof.

## Features

- [Call capture](./call-capture.md): aws/kubectl Bash calls become rows grouped by outcome and where they ran. Proven 2026-10-04.
- [Pane and filters](./pane-and-filters.md): `/map` toggle, all/write/turn filters, LOOKED AT fold and collapse.
- [Row detail](./row-detail.md): selecting a row lists every call behind it. Proven 2026-10-04.
- [Export and clear](./export-and-clear.md): `/map export` trace file and `/map clear`. Export proven 2026-10-04.
- [MCP capture](./mcp-capture.md): MCP tool calls not marked read-only show under MAY HAVE CHANGED. Never driven live.
