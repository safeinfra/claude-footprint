# Implementation notes

Deviations from the v1 spec, and what was planned instead.

## Deviations

| # | What changed | Why | Spec said |
|---|---|---|---|
| 1 | Mod is named `footprint`, lives at the repo root with `.claude-plugin/marketplace.json` | User asked to rename; layout follows `aqaurius6666/claude-env-badge` so it installs the same way | Plugin folder `infra-map/` |
| 2 | Hooks module is `hooks/register.tsx` (+ `parse.ts`, `record.ts`, `view.ts`) | JSX compiles against `h`; `.mjs` would mean hand-written `h(...)` calls | `./infra-map.mjs` |
| 3 | Pure tests are `tests/*.spec.ts` under `bun test`; mod tests are `tests/register.test.tsx` under `claude plugin test` | env-badge convention: `claude plugin test` runs `*.test.ts[x]` only, specs stay fast | One test suite |
| 4 | `safe-aws` / `safe-kubectl` count as `aws` / `kubectl` | This user's setup routes reads through those wrappers; without them the map would show writes only | Bare `aws` / `kubectl` |
| 5 | `eks update-kubeconfig` and every `kubectl config ...` count as read | They only touch the local kubeconfig. `config` rows are not drawn at all; `use-context` still switches the context for later rows | `update` → write |
| 6 | `kubectl rollout status/history` are read | They change nothing | `rollout` → write |
| 7 | Extra cred verbs: `kubectl create token`, `kubectl get secret -o yaml/json/...`, `s3 presign`, `rds generate-db-auth-token`, `iam create-access-key`, `codeartifact`/`ecr-public` tokens, `sso login/get-role-credentials` | Each hands out a credential or dumps one | Spec list only |
| 8 | Extra destructive verbs: `revoke`, `disassociate`, `batch-delete`, `s3 rb`, `s3 mv` from a bucket | Each removes something; `mv` deletes the source objects | Spec list only |
| 9 | Unknown aws verbs default to write; `kubectl run -it` is interactive | Conservative: an unknown mutating verb should be visible | Not specified |
| 10 | Group title keeps the profile name of the first profile seen for an account; profiles on the same account merge | Account is the real scope; one row per account | `acct-A (1234…9012)` |
| 11 | Account lookup state shows as `(…)` pending, `(?)` failed; unknown region `?` | Unknown must never look like "fine" (env-badge lesson) | `?` for region only |
| 12 | Links are one row per group: `→ link: a · b` | Keeps the acceptance view at 12 lines | One `→ link:` row per edge |
| 13 | A group with several regions/namespaces puts the label in a left column, not a row of its own | Line budget | Hierarchy rows |
| 14 | `/map clear` also forgets the profile/kube lookups | Lets a profile that failed (expired SSO) be asked again | Clears events |
| 15 | Heredoc bodies are never stored (`[heredoc: N lines hidden]`); URL creds, `curl -u`, `docker login -p`, `aws configure set *secret*`, JWT/GitHub/GitLab/Slack token shapes are masked | Secret manifests and payloads arrive through heredocs; the spec's list missed them | Spec redaction list |
| 16 | Filter buttons `a`/`w`/`t` and `collapse` (`c`) sit at the top of the pane, beside the slash commands | Same actions without leaving the pane | Slash commands only |

## Known gaps

- `-f` paths resolve against the session's start directory plus any `cd` in the same command. Claude's Bash keeps its own cwd across calls, which a mod cannot read.
- `kubectl apply -f dir/` and URLs show as one `manifest` row (no directory walk, no fetch).
- `kubectl config set-context --current --namespace=x` does not update the cached default namespace.
- Hot reload: all state is in `$.state` and pending lookups are restarted from `session.start`, but no live reload was run in this session. Writing into `~/.claude/dev-mods/<session>/` was blocked by the local permit hook, so live loading is **not verified**.
- Spec step "load the mod once, read the generated `.claude-plugin/types/`" was not possible (the mod never loaded here). The API authority used instead was the plugin-authoring skill's `claude-code.d.ts`, written by the same engine build (2.1.286 header; CLI reports 2.1.287), plus `anthropics/claude-code` `mods/diff` and `aqaurius6666/claude-env-badge`.
- The claude.dev post "Getting started with Claude Code mods" was read (Blast Radius / Replay Theater patterns); its first URL guess 404'd.

## v2 plan: MCP tool capture

Goal: MCP calls land on the same map as CLI calls. An MCP k8s `pods_list` and `kubectl get pods` on the same context share one group.

### Design

- Capture: `tool.call` hook without the `{ tool: 'Bash' }` filter; branch on `e.tool === 'Bash'` vs `e.tool.startsWith('mcp__')`. Glob filters (`mcp__*`) not confirmed in the d.ts, so branch in code.
- Event shape (no back compat): `EventBase` gets `source: 'cli' | 'mcp'`; `cmd` becomes a display string (redacted command, or `tool(args)` with allowlisted args). New `McpEvent = EventBase & { tool: 'mcp'; server: string }`, reusing `verb` for the tool name and `resource` for the target (M6: fewer fields than planned, same view code paths). `Cls` gains `unknown` (badge `?N`, dim, notable, kept by the write filter).
- Adapters: `(tool, args) => MapEvent | null`, matched on tool name + arg keys, never on server name (users name servers freely).
  - aws: `call_aws { cli_command }` → feed `cli_command` to `parse.ts` → `AwsEvent`. Tool/arg names **not verified**; read awslabs aws-api-mcp-server source first.
  - k8s: `kind/name/namespace/context` args → `KubeEvent`. No `context` arg → resolved default context (M4), same as bare `kubectl`.
  - `null` → generic `McpEvent`, grouped `server › tool › target`; `target` = first of `name/id/cluster/namespace/topic/job` present.
- Read/write order: user config > server `isReadOnly` (self-declared `readOnlyHint`) > tool-name guess, worst verb in the name wins (`get_and_delete` → destructive) > `?` dim. Unknown never draws as read.
  - M6: `build` is not a write verb. As a noun it turned every Jenkins `get_build_*` into a write. `build_item` is `?` instead. `run` stays a write verb; `get_run` is noise until config overrides it.
- Config (flat dotted keys, arrays of patterns):
  - `mcp.write`: globs allowed (too broad only adds noise).
  - `mcp.read`: exact names only (a glob could hide real writes).
  - Read the way `aqaurius6666/claude-blast-radius` `hooks/rules.ts` `optionsOf` does: `$.settings.read({ source })` for `user, project, local, flag, policy`, key `footprint` or `footprint@*`, last source wins. Skips `userConfig` filtering and the install-route plugin ID gotcha in one go.
  - Read on every capture, so edits apply without a reload.
  - `mcp.read` only from `user`/`flag`/`policy`: a cloned repo must not be able to hide writes. `mcp.write` from any source (teams can share a list per repo).
  - Bad entries (glob in `mcp.read`, non-array) show as `⚠ config: …` at the top of the pane, like blast-radius.
- Redaction: never store full MCP args. Keep allowlisted identifier keys only, then run the existing redaction. Message bodies, scripts, payloads stay out.
- Row marker: `mcp` tag on MCP rows; detail pane shows `server › tool` + kept args instead of `$ cmd`.
- `/map doctor`: loaded config, and per MCP tool seen: class + which rule decided it.

### Open

- Capture scope: (a) confirmed. Writes and unknowns from every server; reads only from infra servers (adapter match in M8, config in M7). Until then generic MCP reads are dropped. Dropped at capture, not filtered at draw: `HISTORY_CAP` would let MCP reads evict CLI writes.
- Desktop app's own servers (`ccd_*`) are skipped: UI bookkeeping (`mark_chapter`, `spawn_task`), not infra. Revisit with `mcp.ignore` in M7.
- `terminal__run_in_terminal` carries a shell `command`: M8 adapter into `analyze()`.
- env-badge collab (shared `aws.label` script for alias + tier on group titles): separate change, after this.

### Milestones and checks

| # | Change | Check |
|---|---|---|
| M6 | Types + `source` + generic `McpEvent` capture, redaction allowlist, built-in classification (`isReadOnly` > name guess > `unknown`), scope (a) | `bun test spec`: name guess, arg pick; `claude plugin test`: `isReadOnly` path, read dropped, write kept |
| M7 | `mcp.write`/`mcp.read`/`mcp.ignore` config via `optionsOf`, `⚠ config` errors | Specs per rule level; `mcp.read` glob rejected; `mcp.read` from `project` ignored |
| M8 | aws + k8s adapters | Specs: adapter output equals the CLI event for the same call; same group key |
| M9 | View: `mcp` marker, detail pane, `/map doctor` | `view.spec.ts` snapshot; `claude plugin test` |
| M10 | Live run | One real MCP call in the desktop app shows on the map. Hook firing for MCP on the desktop surface is **not verified** yet |

## v3: map display redesign (DESIGN_MAP_DISPLAY.md)

Implemented: the doc's Presentation rows. Deferred: every Capture row (user-declared CLI tools, `NOT TRACKED` per tool, `ignore`, MCP reads for configured servers, `where`/`show`, arg key names). Each depends on the doc's open points (config sources, key shape, history cap).

### Decisions the doc left open

| Point | Chosen | Why |
|---|---|---|
| `cred`, `interactive`, `unknown` | `MAY HAVE CHANGED` | Matches "any verb not in `read`" and the `write` filter (everything not read) |
| Row identity | where + object + operation; section picked per row from its calls | A row moving section on a later success keeps its selection key |
| Section of a row | all calls failed → FAILED; else worst class among calls that worked | A failed write followed by a worked one is a change |
| Object | aws: `service resource` or `service`; k8s: singular kind + name, or plural kind; MCP: target, else the tool name with no separate operation | Doc gives no MCP rule |
| Folded LOOKED AT names | service or kind (`ec2, pods`), not every named object | Object names made the line unreadable (24 rows) |
| Row retry wording | Short: `worked`, `3 calls`, `3 calls, last worked`, `3 calls, all failed`. Same versus different commands moves to the detail head (`2 calls, same command`) | First live run: the doc's `same call 2 times, last one worked` was cut off at pane width. Deviates from doc §4 wording |
| Object repeated on consecutive rows | Named once, later rows leave the column blank | Live run: `rds` printed on every row |
| Pending account lookup | `account not looked up yet`; failed: `account unknown` | Doc only named `region unknown` |
| Links (assume-role, update-kubeconfig) | Indented line under the row: `opens AWS account …, role …` | Groups no longer exist; `→` is a symbol the doc drops |
| `NOT TRACKED` | Shows only the existing unparsed counter: `aws or kubectl commands the map could not read: N` | Per-tool counts need capture |
| Detail | Drops the `$ ` prefix and `this turn`; `•` on rows covers turn. AWS profile shown only when the command does not name it. `where` line under the head, no label; no `result` line | Doc mockup; live run showed the profile twice per call and a repeated result line |
| Selection | `selected` holds a row key, not an event id | Detail lists every call behind a row |

### Not verified

- Typecheck: no `tsc` on this machine; `claude plugin test` and `bun test` load the code but do not typecheck.
- Live pane in the desktop app or terminal: not run.

### Also decided

- Failed non-read rows: `(change)` for write/destructive, `(may have changed)` for cred/interactive/unknown, so a failed credential call does not read as a change.
- With LOOKED AT folded, link lines on read rows (`eks update-kubeconfig`) are hidden until it is opened.
- Bash `description` (the tool's own one-line summary) is stored per call, redacted, capped at 200 chars, and shown on the detail time line; the command moves to its own dim line below. MCP calls have no standard description.
- Export: `/map export` and pane button `e` write all events, unfiltered, as JSONL to `~/.claude/footprint/trace-<session>.jsonl` (outside the repo so it never lands in a commit; overwritten per export). Writes are not verified against a real `fs.*` permit hook.
- Band above the prompt removed (user: no footprint in the main window). `bandGroups`, `bandTokens`, `badges`, `shortRegion` and the `AbovePrompt` hook are gone; a narrow terminal now only says so.
