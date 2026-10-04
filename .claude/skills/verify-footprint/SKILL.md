---
name: verify-footprint
description: Drive the real footprint Claude Code mod (this repo) end to end. Launches an interactive `claude` with this checkout loaded via --plugin-dir inside tmux, makes the nested Claude run aws/kubectl commands, then reads the /map pane and the /map export trace. Use to prove a change to hooks/*.ts or hooks/register.tsx works in the real app, not just in `bun test` / `claude plugin test`.
---

# Verify footprint

footprint is a Claude Code plugin made of function hooks. It has no server and no CLI of its own. Its only user surface is the **`/map` pane** inside an interactive `claude` session, plus the file `/map export` writes. To verify it you run a second, nested `claude` in tmux, ask that Claude to run `aws`/`kubectl` commands, and read the pane.

Every step goes through the helper `.claude/skills/verify-footprint/drive.sh` (run it by path, it is executable). `<name>` is a short tag for one run, e.g. `run1`; it names the tmux session `fpv-<name>`, the scratch dir and the evidence dir.

## Safety rules (read first)

- **Only offline, failing commands.** `drive.sh launch` points `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` and `KUBECONFIG` at empty scratch files. Every `aws`/`kubectl` call (the nested Claude's and the mod's own `aws sts get-caller-identity` lookups) then fails locally. Never remove that isolation, and still use a profile/context that does not exist (`fpv-none`).
- **Prefer read verbs.** `describe-*`, `get`, `list-*`. A destructive verb (even against a fake profile) was blocked by the auto mode classifier in an earlier attempt. To see the `CHANGED` / write-colour paths, rely on `bun test spec` and `claude plugin test .`, or ask the user first.
- **Keep the user's settings and hooks on.** Do not launch with `--setting-sources` or anything that strips the user's hooks or permission rules.
- **Never put the `claude` alias's env values into a file.** `drive.sh` types `claude ...` into the tmux shell so the user's alias supplies auth.

## Launch

```bash
.claude/skills/verify-footprint/drive.sh launch run1
```

- Ready when it prints `ready: fpv-run1 (session <uuid>)`, meaning the `❯` prompt is on screen. It fails after 30s with the last screen lines.
- Starts `claude --plugin-dir <repo> --session-id <uuid> --model haiku` in tmux session `fpv-run1` (220x60, cwd = repo), with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- Refuses if `fpv-run1` already exists. Two runs with different names should not collide: state lives in each session's memory and the trace file is per session id. Never tried side by side.
- The footprint plugin is not installed in the user's settings, so `--plugin-dir` is the only copy loaded. If `/map` ever shows twice in the slash menu, it got installed; say so instead of guessing which one ran.

Teardown is `drive.sh teardown run1` (see Cleanup).

## Doctor

```bash
.claude/skills/verify-footprint/drive.sh doctor run1
```

Read-only. Expect `ok` on: tmux session, session id, claude banner (`Claude Code v...`), `idle at prompt`. `info pane command` shows the claude version (e.g. `2.1.289`), not `zsh`; if it says `zsh`, claude exited. `footprint pane is open` appears once `/map` was sent. Run it first whenever anything looks off.

Pre-checks that are **not** proof (stubbed engine): `bun test spec`, `claude plugin test .`.

## Drive

```bash
.claude/skills/verify-footprint/drive.sh send run1 "/map"
.claude/skills/verify-footprint/drive.sh send run1 "Run these two read-only Bash commands exactly as written: one Bash tool call each, nothing added (no '; echo', no '2>&1', no pipes), and do not retry them any other way. Then reply with one line giving both exit codes from the tool results. The profile and context do not exist and the AWS/kube config files are empty, so both fail locally with no network: 1) safe-aws --profile fpv-none ec2 describe-instances --region ap-northeast-1   2) safe-kubectl --context fpv-none -n web get pods"
.claude/skills/verify-footprint/drive.sh wait run1 180
.claude/skills/verify-footprint/drive.sh pane run1
```

- Why this exact prompt:
  - **`safe-aws` / `safe-kubectl`, not raw `aws` / `kubectl`.** The user's settings allow the `safe-*` wrappers. Raw `aws` raises a permission prompt and the user's hook blocks raw `kubectl` reads. footprint counts `safe-*` as `aws` / `kubectl`.
  - **"nothing added".** Unprompted, the nested Claude appended `; echo "Exit code: $?"`. That made the call exit 0, so the rows correctly moved to `LOOKED AT` (worked). Run 2026-10-04.
- `send` types text then Enter (with a pause so the slash menu settles).
- `wait` returns `idle` after 3 quiet seconds with no spinner. The user's UserPromptSubmit hook can delay the spinner by 5s or more. If `pane` shows no rows right after `idle`, check the screen: the turn may not have started yet, so `wait` again. Exit `3` means a permission prompt (`Do you want`) is up: read the printed screen, then answer it with `drive.sh keys run1 Enter` (accept) or `Escape` (deny). Never accept a prompt for anything other than the command you asked for.
- `pane` prints only the footprint pane column.
- Pane keyboard: `drive.sh keys run1 focus` focuses the pane (ctrl+x tab). Then hotkeys `a` / `w` / `t` (filter), `l` (open/fold LOOKED AT), `c` (collapse), `e` (export). `Tab` moves through the buttons `[ all ] [ write ] [ turn ] [ collapse ] [ export ]` and then the rows; `Enter` presses. Example: `drive.sh keys run1 focus w`.
- Feature recipes with exact end states: [features/README.md](features/README.md).

## Evidence

- Lives in `~/.claude/footprint/verify/<name>/`, outside the repo, and survives teardown.
- `drive.sh capture run1 <label>` saves the full screen as `<label>.txt`. Capture after each action, not just at the end.
- `drive.sh export run1` sends `/map export`, waits for `~/.claude/footprint/trace-<session-id>.jsonl` and copies it to `trace.jsonl` in the evidence dir. That file is the side effect to check: one JSON line per recorded call with `outcome`, `class`, `tool`, `where`, `operation`, `command`.
- `/map export` also **puts the path on the user's clipboard**. Mention that in the report.
- Proof standards:
  - Drive the real path: a nested Claude making a Bash tool call. Do not call the parser or the engine stubs and call it proof.
  - Show the action (the prompt and `Ran N shell commands` on screen) and the result (pane rows plus trace lines).
  - Pane and trace must agree: same object, operation, outcome and `where`.
  - Read the nested screen before judging the pane. A denied call should leave no row. A call blocked by the user's PreToolUse hook showed as a `failed` row although it never ran.

## Cleanup

```bash
.claude/skills/verify-footprint/drive.sh teardown run1
```

- Kills only tmux session `fpv-run1` (and the nested claude in it) and deletes its scratch config dir.
- Keeps `~/.claude/footprint/verify/run1/` and the original `~/.claude/footprint/trace-<id>.jsonl`.
- Never `pkill claude` or kill by name: the user's own sessions are claude processes too.
- After teardown, `ls ~/.claude/footprint/verify/run1/` must still list the captures and `trace.jsonl`.
- Run teardown after every failed attempt too.

## Helpers

- `drive.sh` subcommands: `launch`, `doctor`, `send`, `wait`, `keys`, `pane`, `capture`, `export`, `teardown`. The usage block is at the top of the script.
- Last proven: 2026-10-04 (run4, this exact `drive.sh`), Claude Code 2.1.289, Haiku 4.5. Evidence: `~/.claude/footprint/verify/run4/`.
