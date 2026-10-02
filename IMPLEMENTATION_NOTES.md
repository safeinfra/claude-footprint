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
